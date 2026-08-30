use std::io;
#[cfg(unix)]
use std::os::fd::RawFd;
use std::path::Path;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::fs::OpenOptions;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::process::{Child, Command};
#[cfg(windows)]
use tokio::sync::oneshot;
use tokio::sync::{Mutex, mpsc, watch};
use tokio::time::{sleep, timeout};

use crate::attachment::AttachmentRegistry;
use crate::durable::{JobLock, JobRecord, JobStore, StoredJobState, sha256_hex};
#[cfg(unix)]
use crate::execution_policy::FilesystemPolicy;
use crate::execution_policy::{
    ExecutionCapabilities, ExecutionSecuritySnapshot, linux_bubblewrap_execution_capabilities,
    macos_seatbelt_execution_capabilities,
};
use crate::execution_security;
use crate::framing::{read_json_frame, write_json_frame};
use crate::internal_protocol::{
    EmptyParams, WORKER_PROTOCOL_VERSION, WorkerHelloParams, WorkerHelloResult, WorkerRequest,
    WorkerResponse, WorkerTerminateParams, decode_base64, encode_base64, parse_params,
    status_value, worker_proof,
};
use crate::platform::bootstrap::{BootstrapHandle, read_inherited_secret};
#[cfg(unix)]
use crate::platform::bootstrap::{
    BootstrapRead, BootstrapWrite, SandboxBootstrapChannels, await_gate_and_exec,
    configure_pipe_command, configure_pty_command, create_bootstrap_channel, release_gate,
};
use crate::platform::identity::current_process_identity;
#[cfg(windows)]
use crate::platform::identity::process_start_identity;
#[cfg(windows)]
use crate::platform::process::{
    ManagedProcessTree, SuspendedManagedProcess, SuspendedManagedPtyProcess,
};
#[cfg(unix)]
use crate::platform::process::{
    ProcessTreeSignal, exit_signal_name, process_group_exists, signal_process_group,
};
#[cfg(unix)]
use crate::platform::terminal::{
    duplicate_terminal, is_terminal_eof, open_terminal, set_terminal_size,
};
use crate::platform::{
    LocalListener, LocalStream, accept_local_connection, bind_local_endpoint, verify_local_peer,
};
use crate::protocol::{
    AttachmentAcquireInputParams, AttachmentCredentials, AttachmentDetachParams,
    AttachmentDetachResult, AttachmentReadParams, AttachmentReadResult, AttachmentRenewParams,
    InputLeaseResult, InputWriteParams, InputWriteResult, IoMode, JobFailure, JobSnapshot,
    JobState, MAX_PENDING_PTY_INPUT_BYTES, MAX_PTY_INPUT_BYTES, ProtocolError,
    TerminalResizeParams, TerminalResizeResult, TerminationAttempt, TerminationReason,
    TerminationSnapshot,
};
use crate::pty_output::PtyOutputStore;

const OUTPUT_BUFFER_BYTES: usize = 16_384;
const PTY_COMMAND_QUEUE_DEPTH: usize = 64;
#[cfg(unix)]
const COMMAND_GATE_FD: RawFd = 3;
#[cfg(windows)]
const WINDOWS_PTY_FAULT_MARKER: &[u8] = b"RETAINED-BEFORE-WORKER-LOSS";

pub async fn run_worker(
    job_directory: &Path,
    token_handle: BootstrapHandle,
) -> Result<(), ProtocolError> {
    let token = read_inherited_token(token_handle)?;
    let store_root = job_directory
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| ProtocolError::new("INVALID_WORKER_ARGUMENT", "Job path is malformed."))?;
    let store = JobStore::open(store_root)?;
    let record = store.load_job(job_directory)?;
    if sha256_hex(&token) != record.manifest.token_sha256 {
        return Err(ProtocolError::new(
            "WORKER_AUTHENTICATION_FAILED",
            "Inherited Worker token does not match the job manifest.",
        ));
    }
    let _lock = JobLock::acquire(&record.lock_path())?;
    let current = record.read_state()?;
    if !matches!(current.state, JobState::Accepted | JobState::WorkerReady) {
        return Err(ProtocolError::new(
            "INVALID_WORKER_STATE",
            format!("Worker cannot start from state {:?}.", current.state),
        ));
    }
    let execution_capabilities = worker_execution_capabilities(record.manifest.security.as_ref());
    let admission = if record.manifest.format_version == 1 {
        Err(ProtocolError::new(
            "INVALID_EXECUTION_POLICY",
            "Legacy pending jobs require a fresh approved request.",
        ))
    } else {
        record
            .manifest
            .security
            .as_ref()
            .ok_or_else(execution_security::corrupt)
            .and_then(|security| {
                execution_security::validate_worker_admission_with_capabilities(
                    &record.manifest.start,
                    security,
                    &execution_capabilities,
                )
            })
    };
    if let Err(error) = admission {
        let mut next = current.clone();
        next.state = JobState::StartFailed;
        next.failure = Some(JobFailure {
            code: error.code.into(),
            message: error.message.clone(),
        });
        record.transition(&current, next)?;
        return Err(error);
    }
    let worker_identity = current_process_identity().map_err(identity_error)?;
    let endpoint = record.worker_socket_path()?;
    let listener = bind_local_endpoint(&endpoint)
        .await
        .map_err(worker_socket_error)?;
    let runtime = Arc::new(WorkerRuntime::new(
        record,
        current,
        token.clone(),
        execution_capabilities,
    )?);
    runtime.publish_worker_ready(&worker_identity).await?;
    fault_point("after_worker_ready");

    let (shutdown_sender, shutdown_receiver) = watch::channel(false);
    let server_runtime = Arc::clone(&runtime);
    let server_token = token.clone();
    let server_identity = worker_identity.clone();
    let server = tokio::spawn(async move {
        serve_worker(
            listener,
            server_runtime,
            server_token,
            server_identity,
            shutdown_receiver,
        )
        .await
    });

    let execution = execute_job(Arc::clone(&runtime)).await;
    let _ = shutdown_sender.send(true);
    let _ = server.await;
    if let Ok(endpoint) = runtime.record.worker_socket_path() {
        let _ = crate::platform::remove_local_endpoint(&endpoint);
    }
    execution
}

fn worker_execution_capabilities(
    retained: Option<&ExecutionSecuritySnapshot>,
) -> ExecutionCapabilities {
    match retained {
        Some(ExecutionSecuritySnapshot::Policy(security))
            if security.schema_version == 2 && crate::macos_seatbelt::launch_available() =>
        {
            macos_seatbelt_execution_capabilities()
        }
        Some(ExecutionSecuritySnapshot::Policy(security)) if security.schema_version == 3 => {
            security
                .sandbox_runtime
                .as_ref()
                .and_then(|runtime| linux_bubblewrap_execution_capabilities(runtime).ok())
                .unwrap_or_else(execution_security::native_capabilities)
        }
        _ => execution_security::native_capabilities(),
    }
}

struct WorkerRuntime {
    record: JobRecord,
    state: Mutex<StoredJobState>,
    started_at: Instant,
    stdout_total: AtomicU64,
    stderr_total: AtomicU64,
    stdout_retained: AtomicU64,
    stderr_retained: AtomicU64,
    stdout_complete: AtomicBool,
    stderr_complete: AtomicBool,
    terminate_sender: mpsc::Sender<TerminationReason>,
    terminate_receiver: Mutex<Option<mpsc::Receiver<TerminationReason>>>,
    pty: Option<PtyRuntime>,
    execution_capabilities: ExecutionCapabilities,
}

impl WorkerRuntime {
    fn new(
        record: JobRecord,
        state: StoredJobState,
        token: Vec<u8>,
        execution_capabilities: ExecutionCapabilities,
    ) -> Result<Self, ProtocolError> {
        let (terminate_sender, terminate_receiver) = mpsc::channel(1);
        let pty = if record.manifest.start.io_mode == IoMode::Pty {
            let output_limit = record
                .manifest
                .start
                .pty
                .as_ref()
                .ok_or_else(|| ProtocolError::new("INVALID_WORKER_STATE", "PTY config is absent."))?
                .output_limit_bytes;
            Some(PtyRuntime::new(
                &record.manifest.job_id,
                token,
                PtyOutputStore::open(&record.pty_output_path(), output_limit)?,
            ))
        } else {
            None
        };
        Ok(Self {
            record,
            stdout_total: AtomicU64::new(state.stdout_bytes),
            stderr_total: AtomicU64::new(state.stderr_bytes),
            stdout_retained: AtomicU64::new(state.stdout_retained_bytes),
            stderr_retained: AtomicU64::new(state.stderr_retained_bytes),
            state: Mutex::new(state),
            started_at: Instant::now(),
            stdout_complete: AtomicBool::new(false),
            stderr_complete: AtomicBool::new(false),
            terminate_sender,
            terminate_receiver: Mutex::new(Some(terminate_receiver)),
            pty,
            execution_capabilities,
        })
    }

    async fn publish_worker_ready(&self, identity: &str) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::WorkerReady;
        next.worker_pid = Some(std::process::id());
        next.worker_start_identity = Some(identity.to_owned());
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn publish_command_starting(&self) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        if let Err(error) = execution_security::validate_worker_admission_with_capabilities(
            &self.record.manifest.start,
            guard
                .security
                .as_ref()
                .ok_or_else(execution_security::corrupt)?,
            &self.execution_capabilities,
        ) {
            next.state = JobState::StartFailed;
            next.failure = Some(JobFailure {
                code: error.code.into(),
                message: error.message.clone(),
            });
            *guard = self.record.transition(&guard, next)?;
            return Err(error);
        }
        next.state = JobState::CommandStarting;
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn publish_running(
        &self,
        pid: u32,
        identity: String,
        macos_seatbelt_confirmed: bool,
    ) -> Result<(), ProtocolError> {
        #[cfg(windows)]
        let _ = macos_seatbelt_confirmed;
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        #[cfg(unix)]
        {
            next.security = Some(execution_security::launch_setup_with_capabilities(
                &self.record.manifest.start,
                guard
                    .security
                    .as_ref()
                    .ok_or_else(execution_security::corrupt)?,
                &self.execution_capabilities,
                macos_seatbelt_confirmed,
            )?);
        }
        next.state = JobState::Running;
        next.command_pid = Some(pid);
        next.command_start_identity = Some(identity);
        *guard = self.record.transition(&guard, next)?;
        #[cfg(unix)]
        fault_point("after_security_setup");
        Ok(())
    }

    #[cfg(unix)]
    async fn publish_command_identity(
        &self,
        pid: u32,
        identity: String,
    ) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::CommandStarting;
        next.command_pid = Some(pid);
        next.command_start_identity = Some(identity);
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    #[cfg(windows)]
    async fn publish_command_identity(
        &self,
        pid: u32,
        identity: String,
    ) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::CommandStarting;
        next.command_pid = Some(pid);
        next.command_start_identity = Some(identity);
        next.security = Some(execution_security::launch_setup(
            &self.record.manifest.start,
            guard
                .security
                .as_ref()
                .ok_or_else(execution_security::corrupt)?,
        )?);
        *guard = self.record.transition(&guard, next)?;
        fault_point("after_security_setup");
        Ok(())
    }

    async fn publish_terminating(&self) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::Terminating;
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn publish_start_failed(&self, error: io::Error) -> Result<(), ProtocolError> {
        self.stdout_complete.store(true, Ordering::Release);
        self.stderr_complete.store(true, Ordering::Release);
        if let Some(pty) = &self.pty {
            pty.complete.store(true, Ordering::Release);
        }
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::StartFailed;
        next.duration_ms = duration_millis(self.started_at.elapsed());
        next.failure = Some(JobFailure {
            code: if error.kind() == io::ErrorKind::NotFound {
                "COMMAND_NOT_FOUND".to_owned()
            } else {
                "COMMAND_START_FAILED".to_owned()
            },
            message: format!("Command could not start: {error}"),
        });
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn publish_terminal(
        &self,
        state: JobState,
        status: Option<std::process::ExitStatus>,
        timed_out: bool,
        termination: Option<TerminationSnapshot>,
        failure: Option<JobFailure>,
    ) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        if let Some(pty) = &self.pty {
            pty.complete.store(true, Ordering::Release);
            pty.output.lock().await.sync()?;
        }
        let mut next = guard.clone();
        next.state = state;
        next.timed_out = timed_out;
        next.duration_ms = duration_millis(self.started_at.elapsed());
        next.termination = termination;
        next.failure = failure;
        next.stdout_bytes = self.stdout_total.load(Ordering::Acquire);
        next.stderr_bytes = self.stderr_total.load(Ordering::Acquire);
        next.stdout_retained_bytes = self.stdout_retained.load(Ordering::Acquire);
        next.stderr_retained_bytes = self.stderr_retained.load(Ordering::Acquire);
        if let Some(status) = status {
            next.exit_code = status.code();
            #[cfg(unix)]
            {
                next.signal = exit_signal_name(&status);
            }
            #[cfg(windows)]
            {
                next.signal = None;
            }
        }
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn snapshot(&self) -> JobSnapshot {
        let mut state = self.state.lock().await.clone();
        if !state.state.is_terminal() {
            state.duration_ms = duration_millis(self.started_at.elapsed());
            state.stdout_bytes = self.stdout_total.load(Ordering::Acquire);
            state.stderr_bytes = self.stderr_total.load(Ordering::Acquire);
            state.stdout_retained_bytes = self.stdout_retained.load(Ordering::Acquire);
            state.stderr_retained_bytes = self.stderr_retained.load(Ordering::Acquire);
        }
        state.snapshot(&self.record.manifest.start)
    }

    async fn request_termination(&self, reason: TerminationReason) -> Result<(), String> {
        if matches!(
            reason,
            TerminationReason::Timeout | TerminationReason::OrphanCleanup
        ) {
            return Err("clients cannot request this termination reason".to_owned());
        }
        match self.terminate_sender.try_send(reason) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                if self.state.lock().await.state.is_terminal() {
                    Ok(())
                } else {
                    Err("Worker termination channel is closed".to_owned())
                }
            }
        }
    }

    async fn take_termination_receiver(
        &self,
    ) -> Result<mpsc::Receiver<TerminationReason>, ProtocolError> {
        self.terminate_receiver
            .lock()
            .await
            .take()
            .ok_or_else(|| ProtocolError::new("INTERNAL_ERROR", "Termination receiver was reused."))
    }

    async fn sync_output(&self) -> Result<JobSnapshot, String> {
        if let Some(pty) = &self.pty {
            pty.output
                .lock()
                .await
                .sync()
                .map_err(|error| error.message)?;
        }
        sync_file(&self.record.stdout_path()).await?;
        sync_file(&self.record.stderr_path()).await?;
        Ok(self.snapshot().await)
    }

    fn require_pty(&self) -> Result<&PtyRuntime, ProtocolError> {
        self.pty.as_ref().ok_or_else(|| {
            ProtocolError::new(
                "PTY_NOT_SUPPORTED_FOR_JOB",
                "This job was not started in PTY mode.",
            )
        })
    }

    async fn ensure_live(&self) -> Result<(), ProtocolError> {
        if self.state.lock().await.state.is_terminal() {
            Err(ProtocolError::new(
                "JOB_TERMINAL",
                "The PTY job is already terminal.",
            ))
        } else {
            Ok(())
        }
    }

    async fn open_attachment(&self) -> Result<AttachmentCredentials, ProtocolError> {
        self.require_pty()?.attachments.lock().await.open()
    }

    async fn read_attachment(
        &self,
        params: &AttachmentReadParams,
    ) -> Result<AttachmentReadResult, ProtocolError> {
        let pty = self.require_pty()?;
        pty.attachments
            .lock()
            .await
            .verify(&params.attachment_id, &params.capability_token)?;
        let complete = pty.complete.load(Ordering::Acquire);
        pty.output
            .lock()
            .await
            .read(&params.job_id, params.cursor, params.max_bytes, complete)
    }

    async fn acquire_input(
        &self,
        params: &AttachmentAcquireInputParams,
    ) -> Result<InputLeaseResult, ProtocolError> {
        self.ensure_live().await?;
        self.require_pty()?
            .attachments
            .lock()
            .await
            .acquire_input(&params.attachment_id, &params.capability_token)
    }

    async fn renew_input(
        &self,
        params: &AttachmentRenewParams,
    ) -> Result<InputLeaseResult, ProtocolError> {
        self.ensure_live().await?;
        self.require_pty()?.attachments.lock().await.renew_input(
            &params.attachment_id,
            &params.capability_token,
            &params.lease_token,
            params.fence,
        )
    }

    async fn write_input(
        &self,
        params: &InputWriteParams,
    ) -> Result<InputWriteResult, ProtocolError> {
        self.ensure_live().await?;
        let pty = self.require_pty()?;
        pty.attachments.lock().await.validate_input(
            &params.attachment_id,
            &params.capability_token,
            &params.lease_token,
            params.fence,
        )?;
        let bytes = decode_base64(&params.data_base64)
            .map_err(|error| ProtocolError::new("INVALID_REQUEST", error))?;
        if bytes.is_empty() || bytes.len() > MAX_PTY_INPUT_BYTES {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                format!("PTY input must contain 1-{MAX_PTY_INPUT_BYTES} bytes."),
            ));
        }
        let accepted_bytes = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        pty.enqueue_input(bytes)?;
        Ok(InputWriteResult {
            job_id: params.job_id.clone(),
            accepted_bytes,
        })
    }

    async fn resize_terminal(
        &self,
        params: &TerminalResizeParams,
    ) -> Result<TerminalResizeResult, ProtocolError> {
        self.ensure_live().await?;
        let pty = self.require_pty()?;
        pty.attachments.lock().await.validate_input(
            &params.attachment_id,
            &params.capability_token,
            &params.lease_token,
            params.fence,
        )?;
        pty.enqueue_resize(params.rows, params.cols)?;
        Ok(TerminalResizeResult {
            job_id: params.job_id.clone(),
            rows: params.rows,
            cols: params.cols,
        })
    }

    async fn detach_attachment(
        &self,
        params: &AttachmentDetachParams,
    ) -> Result<AttachmentDetachResult, ProtocolError> {
        let detached = self
            .require_pty()?
            .attachments
            .lock()
            .await
            .detach(&params.attachment_id, &params.capability_token)?;
        Ok(AttachmentDetachResult {
            job_id: params.job_id.clone(),
            detached,
        })
    }
}

struct PtyRuntime {
    output: Mutex<PtyOutputStore>,
    attachments: Mutex<AttachmentRegistry>,
    command_sender: mpsc::Sender<PtyCommand>,
    command_receiver: Mutex<Option<mpsc::Receiver<PtyCommand>>>,
    pending_input_bytes: AtomicU64,
    complete: AtomicBool,
}

impl PtyRuntime {
    fn new(job_id: &str, token: Vec<u8>, output: PtyOutputStore) -> Self {
        let (command_sender, command_receiver) = mpsc::channel(PTY_COMMAND_QUEUE_DEPTH);
        Self {
            output: Mutex::new(output),
            attachments: Mutex::new(AttachmentRegistry::new(job_id.to_owned(), token)),
            command_sender,
            command_receiver: Mutex::new(Some(command_receiver)),
            pending_input_bytes: AtomicU64::new(0),
            complete: AtomicBool::new(false),
        }
    }

    fn enqueue_input(&self, bytes: Vec<u8>) -> Result<(), ProtocolError> {
        let count = bytes.len() as u64;
        self.pending_input_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                pending
                    .checked_add(count)
                    .filter(|next| *next <= MAX_PENDING_PTY_INPUT_BYTES)
            })
            .map_err(|_| {
                ProtocolError::new(
                    "PTY_INPUT_BACKPRESSURE",
                    "The PTY input queue has reached its 64 KiB byte limit.",
                )
            })?;
        if self
            .command_sender
            .try_send(PtyCommand::Input(bytes))
            .is_err()
        {
            self.pending_input_bytes.fetch_sub(count, Ordering::AcqRel);
            return Err(ProtocolError::new(
                "PTY_INPUT_BACKPRESSURE",
                "The PTY input queue is full.",
            ));
        }
        Ok(())
    }

    fn enqueue_resize(&self, rows: u16, cols: u16) -> Result<(), ProtocolError> {
        self.command_sender
            .try_send(PtyCommand::Resize { rows, cols })
            .map_err(|_| {
                ProtocolError::new("PTY_INPUT_BACKPRESSURE", "The PTY command queue is full.")
            })
    }

    #[cfg(windows)]
    fn enqueue_interrupt(&self) -> bool {
        self.command_sender.try_send(PtyCommand::Interrupt).is_ok()
    }

    async fn take_command_receiver(&self) -> Result<mpsc::Receiver<PtyCommand>, ProtocolError> {
        self.command_receiver
            .lock()
            .await
            .take()
            .ok_or_else(|| ProtocolError::new("INTERNAL_ERROR", "PTY command receiver was reused."))
    }
}

enum PtyCommand {
    Input(Vec<u8>),
    Resize {
        rows: u16,
        cols: u16,
    },
    #[cfg(windows)]
    Interrupt,
}

async fn serve_worker(
    listener: LocalListener,
    runtime: Arc<WorkerRuntime>,
    token: Vec<u8>,
    worker_identity: String,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    loop {
        tokio::select! {
            accepted = accept_local_connection(&listener) => {
                let stream = accepted?;
                verify_local_peer(&stream)?;
                let connection_runtime = Arc::clone(&runtime);
                let connection_token = token.clone();
                let connection_identity = worker_identity.clone();
                tokio::spawn(async move {
                    let _ = handle_worker_connection(
                        stream,
                        connection_runtime,
                        connection_token,
                        connection_identity,
                    ).await;
                });
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(());
                }
            }
        }
    }
}

async fn handle_worker_connection(
    mut stream: LocalStream,
    runtime: Arc<WorkerRuntime>,
    token: Vec<u8>,
    worker_identity: String,
) -> io::Result<()> {
    let mut authenticated = false;
    loop {
        let Some(request) = read_json_frame::<WorkerRequest>(&mut stream).await? else {
            return Ok(());
        };
        let request_id = request.request_id.clone();
        let response = if request.protocol_version != WORKER_PROTOCOL_VERSION
            || crate::protocol::validate_identifier(&request.request_id, "request_id").is_err()
        {
            WorkerResponse::failure(request_id, "INVALID_REQUEST", "Invalid Worker envelope.")
        } else if request.method == "worker/hello" {
            match parse_params::<WorkerHelloParams>(request.params)
                .and_then(|params| worker_hello(&runtime, &token, &worker_identity, params))
            {
                Ok(result) => {
                    authenticated = true;
                    WorkerResponse::success(
                        request_id,
                        serde_json::to_value(result).map_err(json_io_error)?,
                    )
                }
                Err(error) => {
                    WorkerResponse::failure(request_id, "WORKER_AUTHENTICATION_FAILED", error)
                }
            }
        } else if !authenticated {
            WorkerResponse::failure(
                request_id,
                "WORKER_AUTHENTICATION_REQUIRED",
                "worker/hello must succeed first.",
            )
        } else {
            match request.method.as_str() {
                "worker/status" => match parse_params::<EmptyParams>(request.params) {
                    Ok(_) => WorkerResponse::success(
                        request_id,
                        status_value(runtime.snapshot().await).map_err(string_io_error)?,
                    ),
                    Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                },
                "worker/terminate" => match parse_params::<WorkerTerminateParams>(request.params) {
                    Ok(params) => match runtime.request_termination(params.reason).await {
                        Ok(()) => WorkerResponse::success(
                            request_id,
                            status_value(runtime.snapshot().await).map_err(string_io_error)?,
                        ),
                        Err(error) => {
                            WorkerResponse::failure(request_id, "WORKER_TERMINATION_FAILED", error)
                        }
                    },
                    Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                },
                "worker/output/sync" => match parse_params::<EmptyParams>(request.params) {
                    Ok(_) => match runtime.sync_output().await {
                        Ok(snapshot) => WorkerResponse::success(
                            request_id,
                            status_value(snapshot).map_err(string_io_error)?,
                        ),
                        Err(error) => {
                            WorkerResponse::failure(request_id, "WORKER_OUTPUT_SYNC_FAILED", error)
                        }
                    },
                    Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                },
                "worker/attach/open" => match parse_params::<EmptyParams>(request.params) {
                    Ok(_) => {
                        worker_operation_response(request_id, runtime.open_attachment().await)?
                    }
                    Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                },
                "worker/attach/read" => {
                    match parse_params::<AttachmentReadParams>(request.params) {
                        Ok(params) => worker_operation_response(
                            request_id,
                            runtime.read_attachment(&params).await,
                        )?,
                        Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                    }
                }
                "worker/attach/acquire-input" => {
                    match parse_params::<AttachmentAcquireInputParams>(request.params) {
                        Ok(params) => worker_operation_response(
                            request_id,
                            runtime.acquire_input(&params).await,
                        )?,
                        Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                    }
                }
                "worker/attach/renew" => {
                    match parse_params::<AttachmentRenewParams>(request.params) {
                        Ok(params) => worker_operation_response(
                            request_id,
                            runtime.renew_input(&params).await,
                        )?,
                        Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                    }
                }
                "worker/input/write" => match parse_params::<InputWriteParams>(request.params) {
                    Ok(params) => {
                        worker_operation_response(request_id, runtime.write_input(&params).await)?
                    }
                    Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                },
                "worker/terminal/resize" => {
                    match parse_params::<TerminalResizeParams>(request.params) {
                        Ok(params) => worker_operation_response(
                            request_id,
                            runtime.resize_terminal(&params).await,
                        )?,
                        Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                    }
                }
                "worker/attach/detach" => {
                    match parse_params::<AttachmentDetachParams>(request.params) {
                        Ok(params) => worker_operation_response(
                            request_id,
                            runtime.detach_attachment(&params).await,
                        )?,
                        Err(error) => WorkerResponse::failure(request_id, "INVALID_REQUEST", error),
                    }
                }
                _ => WorkerResponse::failure(
                    request_id,
                    "METHOD_NOT_FOUND",
                    "Unknown Worker method.",
                ),
            }
        };
        write_json_frame(&mut stream, &response).await?;
    }
}

fn worker_operation_response<T>(
    request_id: String,
    result: Result<T, ProtocolError>,
) -> io::Result<WorkerResponse>
where
    T: serde::Serialize,
{
    match result {
        Ok(value) => Ok(WorkerResponse::success(
            request_id,
            serde_json::to_value(value).map_err(json_io_error)?,
        )),
        Err(error) => Ok(WorkerResponse::failure(
            request_id,
            error.code,
            error.message,
        )),
    }
}

fn worker_hello(
    runtime: &WorkerRuntime,
    token: &[u8],
    worker_identity: &str,
    params: WorkerHelloParams,
) -> Result<WorkerHelloResult, String> {
    if params.job_id != runtime.record.manifest.job_id {
        return Err("Worker job identity does not match.".to_owned());
    }
    let nonce = decode_base64(&params.nonce_base64)?;
    if nonce.len() != 32 {
        return Err("Worker nonce must contain exactly 32 bytes.".to_owned());
    }
    let worker_pid = std::process::id();
    let proof = worker_proof(token, &nonce, &params.job_id, worker_pid, worker_identity)?;
    Ok(WorkerHelloResult {
        job_id: params.job_id,
        worker_pid,
        worker_start_identity: worker_identity.to_owned(),
        proof_base64: encode_base64(&proof),
    })
}

#[cfg(unix)]
async fn execute_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    match runtime.record.manifest.start.io_mode {
        IoMode::Pipe => execute_pipe_job(runtime).await,
        IoMode::Pty => execute_pty_job(runtime).await,
    }
}

#[cfg(windows)]
async fn execute_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    match runtime.record.manifest.start.io_mode {
        IoMode::Pipe => execute_windows_pipe_job(runtime).await,
        IoMode::Pty => execute_windows_pty_job(runtime).await,
    }
}

#[cfg(windows)]
async fn execute_windows_pipe_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    runtime.publish_command_starting().await?;
    fault_point("after_command_starting");
    let params = runtime.record.manifest.start.clone();
    let suspended = match SuspendedManagedProcess::spawn(
        &params.argv,
        Path::new(&params.cwd),
        &params.environment,
    ) {
        Ok(process) => process,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    let pid = suspended.pid();
    let identity = match suspended.process_identity() {
        Ok(identity) => identity,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    runtime
        .publish_command_identity(pid, identity.clone())
        .await?;
    fault_point("after_command_spawn");
    let (tree, stdout, stderr) = match suspended.resume() {
        Ok(process) => process,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    if let Err(error) = runtime.publish_running(pid, identity, false).await {
        let _ = tree.terminate(1);
        return Err(error);
    }
    fault_point("after_running");

    let (output_failure_sender, mut output_failure_receiver) = mpsc::channel(2);
    let stdout_runtime = Arc::clone(&runtime);
    let stdout_failure_sender = output_failure_sender.clone();
    let mut stdout_task = tokio::spawn(async move {
        let source = tokio::fs::File::from_std(stdout);
        if let Err(error) = capture_output(
            source,
            &stdout_runtime.record.stdout_path(),
            stdout_runtime.record.manifest.start.output_limit_bytes,
            &stdout_runtime.stdout_total,
            &stdout_runtime.stdout_retained,
        )
        .await
        {
            let _ = stdout_failure_sender.send(error.to_string()).await;
        }
    });
    let stderr_runtime = Arc::clone(&runtime);
    let mut stderr_task = tokio::spawn(async move {
        let source = tokio::fs::File::from_std(stderr);
        if let Err(error) = capture_output(
            source,
            &stderr_runtime.record.stderr_path(),
            stderr_runtime.record.manifest.start.output_limit_bytes,
            &stderr_runtime.stderr_total,
            &stderr_runtime.stderr_retained,
        )
        .await
        {
            let _ = output_failure_sender.send(error.to_string()).await;
        }
    });
    let wait_tree = tree.clone();
    let mut empty_task = tokio::task::spawn_blocking(move || wait_tree.wait_for_empty());
    let mut terminate_receiver = runtime.take_termination_receiver().await?;
    let trigger = tokio::select! {
        empty = &mut empty_task => WindowsJobTrigger::Empty(flatten_job_wait(empty)),
        reason = terminate_receiver.recv() => WindowsJobTrigger::Terminate(
            reason.unwrap_or(TerminationReason::Cancellation)
        ),
        Some(failure) = output_failure_receiver.recv() => WindowsJobTrigger::OutputFailed(failure),
        _ = sleep(Duration::from_millis(params.timeout_ms)) => {
            WindowsJobTrigger::Terminate(TerminationReason::Timeout)
        }
    };

    let mut failure = None;
    let (status, termination, state, timed_out) = match trigger {
        WindowsJobTrigger::Empty(Ok(())) => match tree.root_exit_status() {
            Ok(status) => (Some(status), None, JobState::Exited, false),
            Err(error) => {
                failure = Some(JobFailure {
                    code: "COMMAND_WAIT_FAILED".to_owned(),
                    message: format!("Could not read the root process exit status: {error}"),
                });
                (None, None, JobState::Exited, false)
            }
        },
        WindowsJobTrigger::Empty(Err(error)) => {
            failure = Some(JobFailure {
                code: "JOB_OBJECT_WAIT_FAILED".to_owned(),
                message: format!("Could not observe Job Object completion: {error}"),
            });
            let _ = tree.terminate(1);
            (
                None,
                Some(TerminationSnapshot {
                    reason: TerminationReason::OutputFailure.as_str().to_owned(),
                    outcome: "uncertain".to_owned(),
                    attempts: vec![TerminationAttempt {
                        attempt: "force".to_owned(),
                        mechanism: "windows_job_object_terminate".to_owned(),
                    }],
                }),
                JobState::TerminationUncertain,
                false,
            )
        }
        WindowsJobTrigger::Terminate(reason) => {
            runtime.publish_terminating().await?;
            fault_point("after_terminating");
            let termination = terminate_windows_tree(
                &tree,
                &mut empty_task,
                reason,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            let status = if state == JobState::Exited {
                tree.root_exit_status().ok()
            } else {
                None
            };
            (
                status,
                Some(termination),
                state,
                reason == TerminationReason::Timeout,
            )
        }
        WindowsJobTrigger::OutputFailed(message) => {
            runtime.publish_terminating().await?;
            failure = Some(JobFailure {
                code: "OUTPUT_CAPTURE_FAILED".to_owned(),
                message,
            });
            let termination = terminate_windows_tree(
                &tree,
                &mut empty_task,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            let status = if state == JobState::Exited {
                tree.root_exit_status().ok()
            } else {
                None
            };
            (status, Some(termination), state, false)
        }
    };

    if !empty_task.is_finished() {
        let _ = tree.cancel_wait();
    }

    let drain_timeout =
        Duration::from_millis(params.termination_confirmation_ms.clamp(2_000, 30_000));
    if timeout(drain_timeout, async {
        let _ = (&mut stdout_task).await;
        let _ = (&mut stderr_task).await;
    })
    .await
    .is_err()
    {
        stdout_task.abort();
        stderr_task.abort();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        failure.get_or_insert(JobFailure {
            code: "OUTPUT_DRAIN_TIMEOUT".to_owned(),
            message: "Windows output pipes did not reach EOF after process-tree completion."
                .to_owned(),
        });
    }
    runtime.stdout_complete.store(true, Ordering::Release);
    runtime.stderr_complete.store(true, Ordering::Release);
    runtime
        .publish_terminal(state, status, timed_out, termination, failure)
        .await?;
    fault_point("after_terminal");
    Ok(())
}

#[cfg(windows)]
async fn execute_windows_pty_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    runtime.publish_command_starting().await?;
    fault_point("after_command_starting");
    let params = runtime.record.manifest.start.clone();
    let pty_config = params
        .pty
        .clone()
        .ok_or_else(|| ProtocolError::new("INVALID_WORKER_STATE", "PTY config is absent."))?;
    let suspended = match SuspendedManagedPtyProcess::spawn(
        &params.argv,
        Path::new(&params.cwd),
        &params.environment,
        &pty_config.term,
        pty_config.rows,
        pty_config.cols,
    ) {
        Ok(process) => process,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    let pid = suspended.pid();
    let identity = match suspended.process_identity() {
        Ok(identity) => identity,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    runtime
        .publish_command_identity(pid, identity.clone())
        .await?;
    fault_point("after_command_spawn");
    let (tree, input, output) = match suspended.resume() {
        Ok(process) => process,
        Err(error) => return runtime.publish_start_failed(error).await,
    };

    let (io_failure_sender, mut io_failure_receiver) = mpsc::channel(2);
    let reader_runtime = Arc::clone(&runtime);
    let reader_failure_sender = io_failure_sender.clone();
    let mut reader_task = tokio::spawn(async move {
        if let Err(error) = capture_windows_pty_output(output, &reader_runtime).await {
            let _ = reader_failure_sender.send(error.to_string()).await;
        }
    });
    if let Err(error) = runtime.publish_running(pid, identity, false).await {
        drop(input);
        let _ = tree.terminate(1);
        let _ = close_windows_pseudo_console(tree.clone(), Duration::from_secs(2)).await;
        let _ = timeout(Duration::from_secs(2), &mut reader_task).await;
        return Err(error);
    }
    fault_point("after_running");

    let pty = runtime.require_pty()?;
    let command_receiver = pty.take_command_receiver().await?;
    let writer_runtime = Arc::clone(&runtime);
    let writer_tree = tree.clone();
    let mut writer_task = tokio::spawn(async move {
        let destination = tokio::fs::File::from_std(input);
        if let Err(error) =
            write_windows_pty_commands(destination, command_receiver, &writer_runtime, &writer_tree)
                .await
        {
            let _ = io_failure_sender.send(error.to_string()).await;
        }
    });
    let wait_tree = tree.clone();
    let mut empty_task = tokio::task::spawn_blocking(move || wait_tree.wait_for_empty());
    let mut terminate_receiver = runtime.take_termination_receiver().await?;
    let trigger = tokio::select! {
        empty = &mut empty_task => WindowsJobTrigger::Empty(flatten_job_wait(empty)),
        reason = terminate_receiver.recv() => WindowsJobTrigger::Terminate(
            reason.unwrap_or(TerminationReason::Cancellation)
        ),
        Some(failure) = io_failure_receiver.recv() => WindowsJobTrigger::OutputFailed(failure),
        _ = sleep(Duration::from_millis(params.timeout_ms)) => {
            WindowsJobTrigger::Terminate(TerminationReason::Timeout)
        }
    };

    let mut failure = None;
    let (status, termination, state, timed_out) = match trigger {
        WindowsJobTrigger::Empty(Ok(())) => match tree.root_exit_status() {
            Ok(status) => (Some(status), None, JobState::Exited, false),
            Err(error) => {
                failure = Some(JobFailure {
                    code: "COMMAND_WAIT_FAILED".to_owned(),
                    message: format!("Could not read the root process exit status: {error}"),
                });
                (None, None, JobState::Exited, false)
            }
        },
        WindowsJobTrigger::Empty(Err(error)) => {
            failure = Some(JobFailure {
                code: "JOB_OBJECT_WAIT_FAILED".to_owned(),
                message: format!("Could not observe Job Object completion: {error}"),
            });
            let _ = tree.terminate(1);
            (
                None,
                Some(TerminationSnapshot {
                    reason: TerminationReason::OutputFailure.as_str().to_owned(),
                    outcome: "uncertain".to_owned(),
                    attempts: vec![TerminationAttempt {
                        attempt: "force".to_owned(),
                        mechanism: "windows_job_object_terminate".to_owned(),
                    }],
                }),
                JobState::TerminationUncertain,
                false,
            )
        }
        WindowsJobTrigger::Terminate(reason) => {
            runtime.publish_terminating().await?;
            fault_point("after_terminating");
            let termination = terminate_windows_pty_tree(
                &runtime,
                &tree,
                &mut empty_task,
                reason,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            let status = if state == JobState::Exited {
                tree.root_exit_status().ok()
            } else {
                None
            };
            (
                status,
                Some(termination),
                state,
                reason == TerminationReason::Timeout,
            )
        }
        WindowsJobTrigger::OutputFailed(message) => {
            runtime.publish_terminating().await?;
            failure = Some(JobFailure {
                code: "PTY_IO_FAILED".to_owned(),
                message,
            });
            let termination = terminate_windows_pty_tree(
                &runtime,
                &tree,
                &mut empty_task,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            let status = if state == JobState::Exited {
                tree.root_exit_status().ok()
            } else {
                None
            };
            (status, Some(termination), state, false)
        }
    };

    if !empty_task.is_finished() {
        let _ = tree.cancel_wait();
    }
    writer_task.abort();
    let _ = timeout(Duration::from_millis(250), &mut writer_task).await;
    let drain_timeout =
        Duration::from_millis(params.termination_confirmation_ms.clamp(2_000, 30_000));
    if let Err(error) = close_windows_pseudo_console(tree.clone(), drain_timeout).await {
        failure.get_or_insert(JobFailure {
            code: "PTY_CLOSE_FAILED".to_owned(),
            message: error.to_string(),
        });
    }
    if timeout(drain_timeout, &mut reader_task).await.is_err() {
        reader_task.abort();
        let _ = reader_task.await;
        failure.get_or_insert(JobFailure {
            code: "PTY_OUTPUT_DRAIN_TIMEOUT".to_owned(),
            message: "ConPTY output did not reach EOF after process-tree completion.".to_owned(),
        });
    }
    runtime
        .publish_terminal(state, status, timed_out, termination, failure)
        .await?;
    fault_point("after_terminal");
    Ok(())
}

#[cfg(windows)]
enum WindowsJobTrigger {
    Empty(io::Result<()>),
    Terminate(TerminationReason),
    OutputFailed(String),
}

#[cfg(windows)]
fn flatten_job_wait(result: Result<io::Result<()>, tokio::task::JoinError>) -> io::Result<()> {
    result.map_err(|error| io::Error::other(format!("Job wait task failed: {error}")))?
}

#[cfg(windows)]
async fn terminate_windows_tree(
    tree: &ManagedProcessTree,
    empty_task: &mut tokio::task::JoinHandle<io::Result<()>>,
    reason: TerminationReason,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationSnapshot {
    let mut attempts = vec![TerminationAttempt {
        attempt: "graceful".to_owned(),
        mechanism: "windows_console_ctrl_break".to_owned(),
    }];
    if tree.request_console_break().is_ok()
        && let Ok(result) = timeout(Duration::from_millis(grace_ms), &mut *empty_task).await
    {
        let outcome = if flatten_job_wait(result).is_ok() {
            "terminated"
        } else {
            let _ = tree.terminate(1);
            "uncertain"
        };
        return TerminationSnapshot {
            reason: reason.as_str().to_owned(),
            outcome: outcome.to_owned(),
            attempts,
        };
    }
    attempts.push(TerminationAttempt {
        attempt: "force".to_owned(),
        mechanism: "windows_job_object_terminate".to_owned(),
    });
    if tree.terminate(1).is_err() {
        return TerminationSnapshot {
            reason: reason.as_str().to_owned(),
            outcome: "uncertain".to_owned(),
            attempts,
        };
    }
    let confirmed = timeout(Duration::from_millis(confirmation_ms), &mut *empty_task)
        .await
        .is_ok_and(|result| flatten_job_wait(result).is_ok());
    TerminationSnapshot {
        reason: reason.as_str().to_owned(),
        outcome: if confirmed { "terminated" } else { "uncertain" }.to_owned(),
        attempts,
    }
}

#[cfg(windows)]
async fn terminate_windows_pty_tree(
    runtime: &WorkerRuntime,
    tree: &ManagedProcessTree,
    empty_task: &mut tokio::task::JoinHandle<io::Result<()>>,
    reason: TerminationReason,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationSnapshot {
    let mut attempts = Vec::new();
    if runtime
        .require_pty()
        .is_ok_and(PtyRuntime::enqueue_interrupt)
    {
        attempts.push(TerminationAttempt {
            attempt: "graceful".to_owned(),
            mechanism: "windows_conpty_ctrl_c".to_owned(),
        });
        if let Ok(result) = timeout(Duration::from_millis(grace_ms), &mut *empty_task).await {
            let outcome = if flatten_job_wait(result).is_ok() {
                "terminated"
            } else {
                let _ = tree.terminate(1);
                "uncertain"
            };
            return TerminationSnapshot {
                reason: reason.as_str().to_owned(),
                outcome: outcome.to_owned(),
                attempts,
            };
        }
    }
    attempts.push(TerminationAttempt {
        attempt: "force".to_owned(),
        mechanism: "windows_job_object_terminate".to_owned(),
    });
    if tree.terminate(1).is_err() {
        return TerminationSnapshot {
            reason: reason.as_str().to_owned(),
            outcome: "uncertain".to_owned(),
            attempts,
        };
    }
    let confirmed = timeout(Duration::from_millis(confirmation_ms), &mut *empty_task)
        .await
        .is_ok_and(|result| flatten_job_wait(result).is_ok());
    TerminationSnapshot {
        reason: reason.as_str().to_owned(),
        outcome: if confirmed { "terminated" } else { "uncertain" }.to_owned(),
        attempts,
    }
}

#[cfg(windows)]
async fn close_windows_pseudo_console(
    tree: ManagedProcessTree,
    deadline: Duration,
) -> io::Result<()> {
    let (sender, receiver) = oneshot::channel();
    std::thread::Builder::new()
        .name("koda-conpty-close".to_owned())
        .spawn(move || {
            let result = tree.close_pseudo_console().map(|_| ());
            let _ = sender.send(result);
        })
        .map_err(|error| io::Error::other(format!("Could not start ConPTY closer: {error}")))?;
    match timeout(deadline, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(io::Error::other(
            "ConPTY close thread exited without reporting a result",
        )),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "ClosePseudoConsole did not complete before the output-drain deadline",
        )),
    }
}

#[cfg(windows)]
async fn capture_windows_pty_output(
    mut source: std::fs::File,
    runtime: &WorkerRuntime,
) -> io::Result<()> {
    let (sender, mut receiver) = mpsc::channel::<io::Result<Vec<u8>>>(16);
    let fault_after_marker =
        std::env::var("KODA_EXEC_TEST_FAULT_POINT").as_deref() == Ok("after_pty_output");
    let mut fault_probe = Vec::new();
    std::thread::Builder::new()
        .name("koda-conpty-output".to_owned())
        .spawn(move || {
            let mut buffer = vec![0u8; OUTPUT_BUFFER_BYTES];
            loop {
                let chunk = match std::io::Read::read(&mut source, &mut buffer) {
                    Ok(0) => break,
                    Ok(count) => Ok(buffer[..count].to_vec()),
                    Err(error) if is_windows_terminal_eof(&error) => break,
                    Err(error) => Err(error),
                };
                let failed = chunk.is_err();
                if sender.blocking_send(chunk).is_err() || failed {
                    break;
                }
            }
        })
        .map_err(|error| {
            io::Error::other(format!("Could not start ConPTY output reader: {error}"))
        })?;
    while let Some(chunk) = receiver.recv().await {
        let chunk = chunk?;
        runtime
            .require_pty()
            .map_err(protocol_io_error)?
            .output
            .lock()
            .await
            .append(&chunk)
            .map_err(protocol_io_error)?;
        if fault_after_marker {
            fault_probe.extend_from_slice(&chunk);
            if fault_probe
                .windows(WINDOWS_PTY_FAULT_MARKER.len())
                .any(|window| window == WINDOWS_PTY_FAULT_MARKER)
            {
                fault_point("after_pty_output");
            }
            let retained = WINDOWS_PTY_FAULT_MARKER.len() - 1;
            if fault_probe.len() > retained {
                fault_probe.drain(..fault_probe.len() - retained);
            }
        }
    }
    runtime
        .require_pty()
        .map_err(protocol_io_error)?
        .output
        .lock()
        .await
        .sync()
        .map_err(protocol_io_error)
}

#[cfg(windows)]
async fn write_windows_pty_commands(
    mut destination: tokio::fs::File,
    mut receiver: mpsc::Receiver<PtyCommand>,
    runtime: &WorkerRuntime,
    tree: &ManagedProcessTree,
) -> io::Result<()> {
    while let Some(command) = receiver.recv().await {
        match command {
            PtyCommand::Input(bytes) => {
                let count = bytes.len() as u64;
                let result = async {
                    destination.write_all(&bytes).await?;
                    destination.flush().await
                }
                .await;
                runtime
                    .require_pty()
                    .map_err(protocol_io_error)?
                    .pending_input_bytes
                    .fetch_sub(count, Ordering::AcqRel);
                result?;
            }
            PtyCommand::Resize { rows, cols } => {
                tree.resize_pseudo_console(rows, cols)?;
            }
            PtyCommand::Interrupt => {
                destination.write_all(&[0x03]).await?;
                destination.flush().await?;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_terminal_eof(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof
    ) || matches!(error.raw_os_error(), Some(109 | 232))
}

#[cfg(unix)]
struct UnixLaunchPreparation {
    argv: Vec<std::ffi::OsString>,
    environment: std::collections::BTreeMap<String, String>,
    sandbox: Option<UnixSandboxLaunch>,
}

#[cfg(unix)]
struct UnixSandboxLaunch {
    channels: UnixSandboxChannels,
    kind: UnixSandboxKind,
}

#[cfg(unix)]
enum UnixSandboxKind {
    MacosSeatbelt,
    #[cfg(target_os = "linux")]
    LinuxBubblewrap {
        digest: [u8; 32],
        network_denied: bool,
        runtime: crate::execution_policy::LinuxBubblewrapRuntimeDescriptor,
    },
}

#[cfg(unix)]
impl UnixSandboxKind {
    fn is_linux_bubblewrap(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            matches!(self, Self::LinuxBubblewrap { .. })
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
}

#[cfg(unix)]
struct UnixSandboxChannels {
    confirmation_read: BootstrapRead,
    confirmation_write: BootstrapWrite,
    release_read: BootstrapRead,
    release_write: BootstrapWrite,
}

#[cfg(unix)]
impl UnixSandboxChannels {
    fn child_descriptors(
        &self,
        confirmation_target: RawFd,
        release_target: RawFd,
    ) -> SandboxBootstrapChannels<'_> {
        SandboxBootstrapChannels {
            confirmation_read: &self.confirmation_read,
            confirmation_write: &self.confirmation_write,
            release_read: &self.release_read,
            release_write: &self.release_write,
            confirmation_target,
            release_target,
        }
    }

    fn into_parent_channels(self) -> (BootstrapRead, BootstrapWrite) {
        let Self {
            confirmation_read,
            confirmation_write,
            release_read,
            release_write,
        } = self;
        drop(confirmation_write);
        drop(release_read);
        (confirmation_read, release_write)
    }
}

#[cfg(unix)]
impl UnixSandboxLaunch {
    fn child_descriptors(&self) -> SandboxBootstrapChannels<'_> {
        let (confirmation_target, release_target) = match self.kind {
            UnixSandboxKind::MacosSeatbelt => (
                crate::macos_seatbelt::SANDBOX_CONFIRMATION_FD,
                crate::macos_seatbelt::SANDBOX_RELEASE_FD,
            ),
            #[cfg(target_os = "linux")]
            UnixSandboxKind::LinuxBubblewrap { .. } => (
                crate::linux_bubblewrap::LINUX_SANDBOX_CONFIRMATION_FD,
                crate::linux_bubblewrap::LINUX_SANDBOX_RELEASE_FD,
            ),
        };
        self.channels
            .child_descriptors(confirmation_target, release_target)
    }

    fn is_linux_bubblewrap(&self) -> bool {
        self.kind.is_linux_bubblewrap()
    }

    fn into_parent_channels(self) -> (BootstrapRead, BootstrapWrite, UnixSandboxKind) {
        let (confirmation_read, release_write) = self.channels.into_parent_channels();
        (confirmation_read, release_write, self.kind)
    }
}

#[cfg(unix)]
fn prepare_unix_launch(
    runtime: &WorkerRuntime,
    params: &crate::protocol::StartParams,
    bootstrap: &Path,
) -> Result<UnixLaunchPreparation, ProtocolError> {
    let policy = params.policy.as_ref().ok_or_else(|| {
        execution_security::policy_error(
            crate::execution_policy::ExecutionPolicyError::InvalidExecutionPolicy,
        )
    })?;
    let mut environment = params.environment.clone();
    let protected = policy.filesystem != FilesystemPolicy::Unrestricted
        || policy.network != crate::execution_policy::NetworkPolicy::Inherit;
    if !protected {
        return Ok(UnixLaunchPreparation {
            argv: params.argv.iter().map(std::ffi::OsString::from).collect(),
            environment,
            sandbox: None,
        });
    }

    let scratch = if policy.filesystem == FilesystemPolicy::WorkspaceWrite {
        let path = runtime.record.scratch_path();
        let text = path.to_str().ok_or_else(|| {
            execution_security::policy_error(
                crate::execution_policy::ExecutionPolicyError::InvalidExecutionPolicy,
            )
        })?;
        for name in ["TMPDIR", "TMP", "TEMP"] {
            environment.insert(name.to_owned(), text.to_owned());
        }
        Some(path)
    } else {
        None
    };
    if runtime.execution_capabilities.schema_version == 2 {
        if runtime.execution_capabilities
            != crate::execution_policy::macos_seatbelt_execution_capabilities()
            || !crate::macos_seatbelt::launch_available()
        {
            return Err(execution_security::policy_error(
                crate::execution_policy::ExecutionPolicyError::ExecutionPolicyUnavailable,
            ));
        }
        let invocation = crate::macos_seatbelt::build_invocation(
            policy,
            Path::new(&policy.workspace_root),
            scratch.as_deref(),
        )
        .map_err(execution_security::policy_error)?;
        let mut sandbox_bootstrap = vec![
            bootstrap.as_os_str().to_owned(),
            std::ffi::OsString::from("sandbox-bootstrap"),
            std::ffi::OsString::from("--confirm-fd"),
            std::ffi::OsString::from(crate::macos_seatbelt::SANDBOX_CONFIRMATION_FD.to_string()),
            std::ffi::OsString::from("--release-fd"),
            std::ffi::OsString::from(crate::macos_seatbelt::SANDBOX_RELEASE_FD.to_string()),
            std::ffi::OsString::from("--"),
        ];
        sandbox_bootstrap.extend(params.argv.iter().map(std::ffi::OsString::from));
        let argv = invocation
            .command_argv(&sandbox_bootstrap)
            .map_err(execution_security::policy_error)?;
        return Ok(UnixLaunchPreparation {
            argv,
            environment,
            sandbox: Some(UnixSandboxLaunch {
                channels: create_unix_sandbox_channels()?,
                kind: UnixSandboxKind::MacosSeatbelt,
            }),
        });
    }

    #[cfg(target_os = "linux")]
    if runtime.execution_capabilities.schema_version == 3 {
        let sandbox_runtime = runtime
            .execution_capabilities
            .sandbox_runtime
            .as_ref()
            .ok_or_else(execution_security::corrupt)?;
        if !crate::linux_bubblewrap::runtime_identity_matches(sandbox_runtime) {
            return Err(execution_security::policy_error(
                crate::execution_policy::ExecutionPolicyError::ExecutionPolicyChanged,
            ));
        }
        let digest = crate::linux_bubblewrap::launch_confirmation_digest(
            sandbox_runtime,
            policy,
            &runtime.execution_capabilities,
        )
        .map_err(execution_security::policy_error)?;
        environment.remove(crate::linux_bubblewrap::LINUX_SANDBOX_FAULT_ENV);
        if let Ok(point) = std::env::var(crate::linux_bubblewrap::LINUX_SANDBOX_FAULT_ENV)
            && matches!(
                point.as_str(),
                "after_linux_namespace_setup" | "after_linux_seccomp"
            )
        {
            environment.insert(
                crate::linux_bubblewrap::LINUX_SANDBOX_FAULT_ENV.to_owned(),
                point,
            );
        }
        let user_argv = params
            .argv
            .iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let invocation = crate::linux_bubblewrap::build_invocation(
            sandbox_runtime,
            crate::linux_bubblewrap::BubblewrapLaunch {
                binary_path: bootstrap,
                policy,
                workspace_root: Path::new(&policy.workspace_root),
                cwd: Path::new(&params.cwd),
                scratch_root: scratch.as_deref(),
                confirmation_digest: &digest,
                argv: &user_argv,
            },
        )
        .map_err(execution_security::policy_error)?;
        return Ok(UnixLaunchPreparation {
            argv: invocation.command_argv(),
            environment,
            sandbox: Some(UnixSandboxLaunch {
                channels: create_unix_sandbox_channels()?,
                kind: UnixSandboxKind::LinuxBubblewrap {
                    digest,
                    network_denied: policy.network == crate::execution_policy::NetworkPolicy::Deny,
                    runtime: sandbox_runtime.clone(),
                },
            }),
        });
    }

    Err(execution_security::policy_error(
        crate::execution_policy::ExecutionPolicyError::ExecutionPolicyUnavailable,
    ))
}

#[cfg(unix)]
fn create_unix_sandbox_channels() -> Result<UnixSandboxChannels, ProtocolError> {
    let (confirmation_read, confirmation_write) = create_bootstrap_channel().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create the sandbox confirmation channel: {error}"),
        )
    })?;
    let (release_read, release_write) = create_bootstrap_channel().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create the sandbox release channel: {error}"),
        )
    })?;
    Ok(UnixSandboxChannels {
        confirmation_read,
        confirmation_write,
        release_read,
        release_write,
    })
}

#[cfg(unix)]
async fn wait_for_sandbox_confirmation(read: BootstrapRead, pid: u32) -> io::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::macos_seatbelt::wait_for_confirmation(read, pid, Duration::from_secs(3))
    })
    .await
    .map_err(|_| io::Error::other("sandbox confirmation task failed"))?
}

#[cfg(target_os = "linux")]
async fn wait_for_linux_sandbox_confirmation(
    read: BootstrapRead,
    pid: u32,
    network_denied: bool,
    digest: [u8; 32],
    runtime: crate::execution_policy::LinuxBubblewrapRuntimeDescriptor,
) -> io::Result<()> {
    tokio::task::spawn_blocking(move || {
        crate::linux_bubblewrap::wait_for_confirmation(
            read,
            pid,
            network_denied,
            digest,
            &runtime,
            Duration::from_secs(3),
        )
        .map(|_| ())
    })
    .await
    .map_err(|_| io::Error::other("Linux sandbox confirmation task failed"))?
}

#[cfg(unix)]
async fn activate_unix_launch(
    runtime: &WorkerRuntime,
    child: &mut Child,
    pid: u32,
    command_identity: String,
    gate_write: BootstrapWrite,
    sandbox: Option<UnixSandboxLaunch>,
    params: &crate::protocol::StartParams,
) -> Result<(), ProtocolError> {
    let Some(sandbox) = sandbox else {
        if let Err(error) = runtime.publish_running(pid, command_identity, false).await {
            drop(gate_write);
            let _ = terminate_child(
                child,
                pid,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            return Err(error);
        }
        if let Err(error) = release_gate(gate_write) {
            return fail_running_unix_launch(
                runtime,
                child,
                pid,
                params,
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    format!("Could not release the command start gate: {error}"),
                ),
            )
            .await;
        }
        return Ok(());
    };

    let (confirmation_read, sandbox_release_write, sandbox_kind) = sandbox.into_parent_channels();
    let linux_bubblewrap = sandbox_kind.is_linux_bubblewrap();
    if let Err(error) = runtime
        .publish_command_identity(pid, command_identity.clone())
        .await
    {
        drop(gate_write);
        drop(sandbox_release_write);
        let _ = terminate_child(
            child,
            pid,
            TerminationReason::OutputFailure,
            params.termination_grace_ms,
            params.termination_confirmation_ms,
        )
        .await;
        return Err(error);
    }
    if let Err(error) = release_gate(gate_write) {
        drop(sandbox_release_write);
        return fail_unix_launch(
            runtime,
            child,
            pid,
            params,
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Could not release the sandbox start gate: {error}"),
            ),
        )
        .await;
    }
    let confirmation = match &sandbox_kind {
        UnixSandboxKind::MacosSeatbelt => {
            wait_for_sandbox_confirmation(confirmation_read, pid).await
        }
        #[cfg(target_os = "linux")]
        UnixSandboxKind::LinuxBubblewrap {
            digest,
            network_denied,
            runtime: sandbox_runtime,
        } => {
            wait_for_linux_sandbox_confirmation(
                confirmation_read,
                pid,
                *network_denied,
                *digest,
                sandbox_runtime.clone(),
            )
            .await
        }
    };
    if let Err(error) = confirmation {
        drop(sandbox_release_write);
        return fail_unix_launch(runtime, child, pid, params, error).await;
    }
    let current_identity = match crate::platform::identity::process_start_identity(pid) {
        Ok(identity) => identity,
        Err(error) => {
            drop(sandbox_release_write);
            return fail_unix_launch(runtime, child, pid, params, error).await;
        }
    };
    if current_identity.as_deref() != Some(command_identity.as_str()) {
        drop(sandbox_release_write);
        return fail_unix_launch(
            runtime,
            child,
            pid,
            params,
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox confirmation process identity changed",
            ),
        )
        .await;
    }
    fault_point("after_sandbox_confirmation");
    if linux_bubblewrap {
        fault_point("after_linux_sandbox_confirmation");
    }
    if let Err(error) = runtime.publish_running(pid, command_identity, true).await {
        drop(sandbox_release_write);
        let _ = terminate_child(
            child,
            pid,
            TerminationReason::OutputFailure,
            params.termination_grace_ms,
            params.termination_confirmation_ms,
        )
        .await;
        return Err(error);
    }
    if linux_bubblewrap {
        fault_point("after_linux_sandbox_evidence");
    }
    if let Err(error) = release_gate(sandbox_release_write) {
        return fail_running_unix_launch(
            runtime,
            child,
            pid,
            params,
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Could not release the sandboxed command: {error}"),
            ),
        )
        .await;
    }
    if linux_bubblewrap {
        fault_point("after_linux_sandbox_release");
    }
    Ok(())
}

#[cfg(unix)]
async fn fail_unix_launch(
    runtime: &WorkerRuntime,
    child: &mut Child,
    pid: u32,
    params: &crate::protocol::StartParams,
    error: io::Error,
) -> Result<(), ProtocolError> {
    let failure_message = format!("Command could not start: {error}");
    let termination = terminate_child(
        child,
        pid,
        TerminationReason::OutputFailure,
        params.termination_grace_ms,
        params.termination_confirmation_ms,
    )
    .await;
    if termination.snapshot.outcome == "uncertain" {
        runtime
            .publish_terminal(
                JobState::TerminationUncertain,
                termination.status,
                false,
                Some(termination.snapshot),
                Some(JobFailure {
                    code: "COMMAND_START_FAILED".to_owned(),
                    message: failure_message,
                }),
            )
            .await?;
    } else {
        runtime.publish_start_failed(error).await?;
    }
    Err(ProtocolError::new(
        "COMMAND_START_FAILED",
        "The command launch could not be validated before user code was released.",
    ))
}

#[cfg(unix)]
async fn fail_running_unix_launch(
    runtime: &WorkerRuntime,
    child: &mut Child,
    pid: u32,
    params: &crate::protocol::StartParams,
    error: io::Error,
) -> Result<(), ProtocolError> {
    let failure_message = error.to_string();
    let termination = terminate_child(
        child,
        pid,
        TerminationReason::OutputFailure,
        params.termination_grace_ms,
        params.termination_confirmation_ms,
    )
    .await;
    let state = if termination.snapshot.outcome == "uncertain" {
        JobState::TerminationUncertain
    } else {
        JobState::Exited
    };
    runtime
        .publish_terminal(
            state,
            termination.status,
            false,
            Some(termination.snapshot),
            Some(JobFailure {
                code: "COMMAND_START_FAILED".to_owned(),
                message: failure_message,
            }),
        )
        .await?;
    Err(ProtocolError::new(
        "COMMAND_START_FAILED",
        "The command start gate could not be released.",
    ))
}

#[cfg(unix)]
async fn execute_pty_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    runtime.publish_command_starting().await?;
    fault_point("after_command_starting");
    let params = runtime.record.manifest.start.clone();
    let pty_config = params
        .pty
        .clone()
        .ok_or_else(|| ProtocolError::new("INVALID_WORKER_STATE", "PTY config is absent."))?;
    let (master, slave) = open_terminal(pty_config.rows, pty_config.cols).map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create a PTY: {error}"),
        )
    })?;
    let (gate_read, gate_write) = create_bootstrap_channel().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create the command start gate: {error}"),
        )
    })?;
    let bootstrap = std::env::current_exe().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not locate the command bootstrap: {error}"),
        )
    })?;
    let launch = prepare_unix_launch(&runtime, &params, &bootstrap)?;
    let UnixLaunchPreparation {
        argv,
        environment,
        sandbox,
    } = launch;
    let mut command = Command::new(&bootstrap);
    command
        .arg("command-bootstrap")
        .arg("--gate-fd")
        .arg(COMMAND_GATE_FD.to_string())
        .arg("--")
        .args(&argv)
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&environment)
        .env("TERM", &pty_config.term)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    configure_pty_command(
        &mut command,
        &gate_read,
        &gate_write,
        &master,
        &slave,
        COMMAND_GATE_FD,
        sandbox.as_ref().map(UnixSandboxLaunch::child_descriptors),
    );

    if sandbox
        .as_ref()
        .is_some_and(UnixSandboxLaunch::is_linux_bubblewrap)
    {
        fault_point("before_linux_sandbox_spawn");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    drop(gate_read);
    drop(slave);
    fault_point("after_command_spawn");
    let Some(pid) = child.id() else {
        return runtime
            .publish_start_failed(io::Error::other("operating system returned no process ID"))
            .await;
    };
    let command_identity = match crate::platform::identity::process_start_identity(pid) {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            return fail_unix_launch(
                &runtime,
                &mut child,
                pid,
                &params,
                io::Error::new(io::ErrorKind::NotFound, "Process identity vanished"),
            )
            .await;
        }
        Err(error) => {
            return fail_unix_launch(&runtime, &mut child, pid, &params, error).await;
        }
    };
    let reader = match duplicate_terminal(&master) {
        Ok(reader) => reader,
        Err(error) => {
            return fail_unix_launch(
                &runtime,
                &mut child,
                pid,
                &params,
                io::Error::new(
                    error.kind(),
                    format!("Could not duplicate the PTY master: {error}"),
                ),
            )
            .await;
        }
    };
    activate_unix_launch(
        &runtime,
        &mut child,
        pid,
        command_identity,
        gate_write,
        sandbox,
        &params,
    )
    .await?;
    fault_point("after_running");

    let (output_failure_sender, mut output_failure_receiver) = mpsc::channel(2);
    let reader_runtime = Arc::clone(&runtime);
    let reader_failure_sender = output_failure_sender.clone();
    let mut reader_task = tokio::spawn(async move {
        let file = tokio::fs::File::from_std(std::fs::File::from(reader));
        if let Err(error) = capture_pty_output(file, &reader_runtime).await {
            let _ = reader_failure_sender.send(error.to_string()).await;
        }
    });
    let pty = runtime.require_pty()?;
    let command_receiver = pty.take_command_receiver().await?;
    let writer_failure_sender = output_failure_sender;
    let writer_runtime = Arc::clone(&runtime);
    let writer_task = tokio::spawn(async move {
        let file = tokio::fs::File::from_std(std::fs::File::from(master));
        if let Err(error) = write_pty_commands(file, command_receiver, &writer_runtime).await {
            let _ = writer_failure_sender.send(error.to_string()).await;
        }
    });

    let mut terminate_receiver = runtime.take_termination_receiver().await?;
    let trigger = tokio::select! {
        status = child.wait() => JobTrigger::Exited(status),
        reason = terminate_receiver.recv() => JobTrigger::Terminate(
            reason.unwrap_or(TerminationReason::Cancellation)
        ),
        Some(failure) = output_failure_receiver.recv() => JobTrigger::OutputFailed(failure),
        _ = sleep(Duration::from_millis(params.timeout_ms)) => {
            JobTrigger::Terminate(TerminationReason::Timeout)
        }
    };

    let mut failure = None;
    let (status, termination, state, timed_out) = match trigger {
        JobTrigger::Exited(Ok(status)) => {
            if process_group_exists(pid) {
                let termination = terminate_group_after_root(
                    pid,
                    TerminationReason::OrphanCleanup,
                    params.termination_grace_ms,
                    params.termination_confirmation_ms,
                )
                .await;
                let state = if termination.outcome == "uncertain" {
                    JobState::TerminationUncertain
                } else {
                    JobState::Exited
                };
                (Some(status), Some(termination), state, false)
            } else {
                (Some(status), None, JobState::Exited, false)
            }
        }
        JobTrigger::Exited(Err(error)) => {
            failure = Some(JobFailure {
                code: "COMMAND_WAIT_FAILED".to_owned(),
                message: format!("Could not wait for the command: {error}"),
            });
            let termination = terminate_group_after_root(
                pid,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (None, Some(termination), state, false)
        }
        JobTrigger::Terminate(reason) => {
            if let Err(error) = runtime.publish_terminating().await {
                let _ = terminate_child(
                    &mut child,
                    pid,
                    TerminationReason::OutputFailure,
                    params.termination_grace_ms,
                    params.termination_confirmation_ms,
                )
                .await;
                return Err(error);
            }
            fault_point("after_terminating");
            let terminated = terminate_child(
                &mut child,
                pid,
                reason,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if terminated.snapshot.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (
                terminated.status,
                Some(terminated.snapshot),
                state,
                reason == TerminationReason::Timeout,
            )
        }
        JobTrigger::OutputFailed(message) => {
            runtime.publish_terminating().await?;
            failure = Some(JobFailure {
                code: "PTY_IO_FAILED".to_owned(),
                message,
            });
            let terminated = terminate_child(
                &mut child,
                pid,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if terminated.snapshot.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (terminated.status, Some(terminated.snapshot), state, false)
        }
    };

    writer_task.abort();
    let _ = writer_task.await;
    if timeout(Duration::from_secs(2), &mut reader_task)
        .await
        .is_err()
    {
        reader_task.abort();
        let _ = reader_task.await;
        failure.get_or_insert(JobFailure {
            code: "PTY_OUTPUT_DRAIN_TIMEOUT".to_owned(),
            message: "PTY output did not reach EOF after the command exited.".to_owned(),
        });
    }
    runtime
        .publish_terminal(state, status, timed_out, termination, failure)
        .await?;
    fault_point("after_terminal");
    Ok(())
}

#[cfg(unix)]
async fn capture_pty_output(
    mut source: tokio::fs::File,
    runtime: &WorkerRuntime,
) -> io::Result<()> {
    let mut buffer = vec![0u8; OUTPUT_BUFFER_BYTES];
    loop {
        let count = match source.read(&mut buffer).await {
            Ok(count) => count,
            Err(error) if is_terminal_eof(&error) => 0,
            Err(error) => return Err(error),
        };
        if count == 0 {
            runtime
                .require_pty()
                .map_err(protocol_io_error)?
                .output
                .lock()
                .await
                .sync()
                .map_err(protocol_io_error)?;
            return Ok(());
        }
        runtime
            .require_pty()
            .map_err(protocol_io_error)?
            .output
            .lock()
            .await
            .append(&buffer[..count])
            .map_err(protocol_io_error)?;
    }
}

#[cfg(unix)]
async fn write_pty_commands(
    mut destination: tokio::fs::File,
    mut receiver: mpsc::Receiver<PtyCommand>,
    runtime: &WorkerRuntime,
) -> io::Result<()> {
    while let Some(command) = receiver.recv().await {
        match command {
            PtyCommand::Input(bytes) => {
                let count = bytes.len() as u64;
                let result = async {
                    destination.write_all(&bytes).await?;
                    destination.flush().await
                }
                .await;
                runtime
                    .require_pty()
                    .map_err(protocol_io_error)?
                    .pending_input_bytes
                    .fetch_sub(count, Ordering::AcqRel);
                result?;
            }
            PtyCommand::Resize { rows, cols } => {
                set_terminal_size(&destination, rows, cols)?;
            }
        }
    }
    Ok(())
}

fn protocol_io_error(error: ProtocolError) -> io::Error {
    io::Error::other(format!("{}: {}", error.code, error.message))
}

#[cfg(unix)]
async fn execute_pipe_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    runtime.publish_command_starting().await?;
    fault_point("after_command_starting");
    let params = runtime.record.manifest.start.clone();
    let (gate_read, gate_write) = create_bootstrap_channel().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create the command start gate: {error}"),
        )
    })?;
    let bootstrap = std::env::current_exe().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not locate the command bootstrap: {error}"),
        )
    })?;
    let launch = prepare_unix_launch(&runtime, &params, &bootstrap)?;
    let UnixLaunchPreparation {
        argv,
        environment,
        sandbox,
    } = launch;
    let mut command = Command::new(&bootstrap);
    command
        .arg("command-bootstrap")
        .arg("--gate-fd")
        .arg(COMMAND_GATE_FD.to_string())
        .arg("--")
        .args(&argv)
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    configure_pipe_command(
        &mut command,
        &gate_read,
        &gate_write,
        COMMAND_GATE_FD,
        sandbox.as_ref().map(UnixSandboxLaunch::child_descriptors),
    );

    if sandbox
        .as_ref()
        .is_some_and(UnixSandboxLaunch::is_linux_bubblewrap)
    {
        fault_point("before_linux_sandbox_spawn");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return runtime.publish_start_failed(error).await,
    };
    drop(gate_read);
    fault_point("after_command_spawn");
    let Some(pid) = child.id() else {
        return runtime
            .publish_start_failed(io::Error::other("operating system returned no process ID"))
            .await;
    };
    let command_identity = match crate::platform::identity::process_start_identity(pid) {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            return fail_unix_launch(
                &runtime,
                &mut child,
                pid,
                &params,
                io::Error::new(io::ErrorKind::NotFound, "Process identity vanished"),
            )
            .await;
        }
        Err(error) => {
            return fail_unix_launch(&runtime, &mut child, pid, &params, error).await;
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return fail_unix_launch(
            &runtime,
            &mut child,
            pid,
            &params,
            io::Error::other("stdout was not captured"),
        )
        .await;
    };
    let Some(stderr) = child.stderr.take() else {
        return fail_unix_launch(
            &runtime,
            &mut child,
            pid,
            &params,
            io::Error::other("stderr was not captured"),
        )
        .await;
    };
    activate_unix_launch(
        &runtime,
        &mut child,
        pid,
        command_identity,
        gate_write,
        sandbox,
        &params,
    )
    .await?;
    fault_point("after_running");

    let (output_failure_sender, mut output_failure_receiver) = mpsc::channel(1);
    let stdout_runtime = Arc::clone(&runtime);
    let stdout_failure_sender = output_failure_sender.clone();
    let stdout_task = tokio::spawn(async move {
        if let Err(error) = capture_output(
            stdout,
            &stdout_runtime.record.stdout_path(),
            stdout_runtime.record.manifest.start.output_limit_bytes,
            &stdout_runtime.stdout_total,
            &stdout_runtime.stdout_retained,
        )
        .await
        {
            let _ = stdout_failure_sender.send(error.to_string()).await;
        }
    });
    let stderr_runtime = Arc::clone(&runtime);
    let stderr_task = tokio::spawn(async move {
        if let Err(error) = capture_output(
            stderr,
            &stderr_runtime.record.stderr_path(),
            stderr_runtime.record.manifest.start.output_limit_bytes,
            &stderr_runtime.stderr_total,
            &stderr_runtime.stderr_retained,
        )
        .await
        {
            let _ = output_failure_sender.send(error.to_string()).await;
        }
    });
    let mut terminate_receiver = runtime.take_termination_receiver().await?;
    let trigger = tokio::select! {
        status = child.wait() => JobTrigger::Exited(status),
        reason = terminate_receiver.recv() => JobTrigger::Terminate(
            reason.unwrap_or(TerminationReason::Cancellation)
        ),
        Some(failure) = output_failure_receiver.recv() => JobTrigger::OutputFailed(failure),
        _ = sleep(Duration::from_millis(params.timeout_ms)) => {
            JobTrigger::Terminate(TerminationReason::Timeout)
        }
    };

    let mut failure = None;
    let (status, termination, state, timed_out) = match trigger {
        JobTrigger::Exited(Ok(status)) => {
            if process_group_exists(pid) {
                let termination = terminate_group_after_root(
                    pid,
                    TerminationReason::OrphanCleanup,
                    params.termination_grace_ms,
                    params.termination_confirmation_ms,
                )
                .await;
                let state = if termination.outcome == "uncertain" {
                    JobState::TerminationUncertain
                } else {
                    JobState::Exited
                };
                (Some(status), Some(termination), state, false)
            } else {
                (Some(status), None, JobState::Exited, false)
            }
        }
        JobTrigger::Exited(Err(error)) => {
            failure = Some(JobFailure {
                code: "COMMAND_WAIT_FAILED".to_owned(),
                message: format!("Could not wait for the command: {error}"),
            });
            let termination = terminate_group_after_root(
                pid,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if termination.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (None, Some(termination), state, false)
        }
        JobTrigger::Terminate(reason) => {
            if let Err(error) = runtime.publish_terminating().await {
                let _ = terminate_child(
                    &mut child,
                    pid,
                    TerminationReason::OutputFailure,
                    params.termination_grace_ms,
                    params.termination_confirmation_ms,
                )
                .await;
                return Err(error);
            }
            fault_point("after_terminating");
            let terminated = terminate_child(
                &mut child,
                pid,
                reason,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if terminated.snapshot.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (
                terminated.status,
                Some(terminated.snapshot),
                state,
                reason == TerminationReason::Timeout,
            )
        }
        JobTrigger::OutputFailed(message) => {
            runtime.publish_terminating().await?;
            failure = Some(JobFailure {
                code: "OUTPUT_CAPTURE_FAILED".to_owned(),
                message,
            });
            let terminated = terminate_child(
                &mut child,
                pid,
                TerminationReason::OutputFailure,
                params.termination_grace_ms,
                params.termination_confirmation_ms,
            )
            .await;
            let state = if terminated.snapshot.outcome == "uncertain" {
                JobState::TerminationUncertain
            } else {
                JobState::Exited
            };
            (terminated.status, Some(terminated.snapshot), state, false)
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    runtime.stdout_complete.store(true, Ordering::Release);
    runtime.stderr_complete.store(true, Ordering::Release);
    runtime
        .publish_terminal(state, status, timed_out, termination, failure)
        .await?;
    fault_point("after_terminal");
    Ok(())
}

#[cfg(unix)]
pub fn run_command_bootstrap(gate_fd: RawFd, argv: Vec<String>) -> io::Result<()> {
    await_gate_and_exec(gate_fd, argv)
}

#[cfg(unix)]
enum JobTrigger {
    Exited(io::Result<std::process::ExitStatus>),
    Terminate(TerminationReason),
    OutputFailed(String),
}

#[cfg(unix)]
struct TerminationResult {
    status: Option<std::process::ExitStatus>,
    snapshot: TerminationSnapshot,
}

async fn capture_output<R>(
    mut source: R,
    path: &Path,
    limit: u64,
    total: &AtomicU64,
    retained: &AtomicU64,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut destination = OpenOptions::new().append(true).open(path).await?;
    let mut buffer = vec![0u8; OUTPUT_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            destination.sync_all().await?;
            return Ok(());
        }
        total.fetch_add(count as u64, Ordering::AcqRel);
        let already_retained = retained.load(Ordering::Acquire);
        let writable = count.min(limit.saturating_sub(already_retained) as usize);
        if writable > 0 {
            destination.write_all(&buffer[..writable]).await?;
            destination.flush().await?;
            retained.fetch_add(writable as u64, Ordering::AcqRel);
        }
    }
}

async fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| error.to_string())?
        .sync_all()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
async fn terminate_child(
    child: &mut Child,
    pid: u32,
    reason: TerminationReason,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationResult {
    let mut attempts = vec![TerminationAttempt {
        attempt: "graceful".to_owned(),
        mechanism: "posix_process_group_signal".to_owned(),
    }];
    let _ = signal_process_group(pid, ProcessTreeSignal::Graceful);
    if let Ok(status) = timeout(Duration::from_millis(grace_ms), child.wait()).await {
        return TerminationResult {
            status: status.ok(),
            snapshot: TerminationSnapshot {
                reason: reason.as_str().to_owned(),
                outcome: "terminated".to_owned(),
                attempts,
            },
        };
    }
    attempts.push(TerminationAttempt {
        attempt: "force".to_owned(),
        mechanism: "posix_process_group_signal".to_owned(),
    });
    let _ = signal_process_group(pid, ProcessTreeSignal::Force);
    match timeout(Duration::from_millis(confirmation_ms), child.wait()).await {
        Ok(Ok(status)) => TerminationResult {
            status: Some(status),
            snapshot: TerminationSnapshot {
                reason: reason.as_str().to_owned(),
                outcome: "terminated".to_owned(),
                attempts,
            },
        },
        Ok(Err(_)) | Err(_) => TerminationResult {
            status: None,
            snapshot: TerminationSnapshot {
                reason: reason.as_str().to_owned(),
                outcome: "uncertain".to_owned(),
                attempts,
            },
        },
    }
}

#[cfg(unix)]
async fn terminate_group_after_root(
    pid: u32,
    reason: TerminationReason,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationSnapshot {
    let mut attempts = vec![TerminationAttempt {
        attempt: "graceful".to_owned(),
        mechanism: "posix_process_group_signal".to_owned(),
    }];
    let _ = signal_process_group(pid, ProcessTreeSignal::Graceful);
    if wait_for_group_exit(pid, grace_ms).await {
        return TerminationSnapshot {
            reason: reason.as_str().to_owned(),
            outcome: "terminated".to_owned(),
            attempts,
        };
    }
    attempts.push(TerminationAttempt {
        attempt: "force".to_owned(),
        mechanism: "posix_process_group_signal".to_owned(),
    });
    let _ = signal_process_group(pid, ProcessTreeSignal::Force);
    TerminationSnapshot {
        reason: reason.as_str().to_owned(),
        outcome: if wait_for_group_exit(pid, confirmation_ms).await {
            "terminated".to_owned()
        } else {
            "uncertain".to_owned()
        },
        attempts,
    }
}

#[cfg(unix)]
pub async fn cleanup_verified_process_group(
    pid: u32,
    _expected_identity: &str,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationSnapshot {
    terminate_group_after_root(
        pid,
        TerminationReason::OutputFailure,
        grace_ms,
        confirmation_ms,
    )
    .await
}

#[cfg(windows)]
pub async fn cleanup_verified_process_group(
    pid: u32,
    expected_identity: &str,
    _grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationSnapshot {
    let deadline = Instant::now() + Duration::from_millis(confirmation_ms);
    let disappeared = loop {
        match process_start_identity(pid) {
            Ok(Some(actual)) if actual == expected_identity => {}
            Ok(_) => break true,
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            break false;
        }
        sleep(Duration::from_millis(20)).await;
    };
    TerminationSnapshot {
        reason: TerminationReason::OrphanCleanup.as_str().to_owned(),
        outcome: if disappeared {
            "terminated"
        } else {
            "uncertain"
        }
        .to_owned(),
        attempts: vec![TerminationAttempt {
            attempt: "identity_check".to_owned(),
            mechanism: "windows_job_object_close_observation".to_owned(),
        }],
    }
}

#[cfg(unix)]
async fn wait_for_group_exit(pid: u32, milliseconds: u64) -> bool {
    if !process_group_exists(pid) {
        return true;
    }
    let deadline = Instant::now() + Duration::from_millis(milliseconds);
    while Instant::now() < deadline {
        sleep(Duration::from_millis(20)).await;
        if !process_group_exists(pid) {
            return true;
        }
    }
    !process_group_exists(pid)
}

fn read_inherited_token(token_handle: BootstrapHandle) -> Result<Vec<u8>, ProtocolError> {
    read_inherited_secret(token_handle, 32).map_err(|error| {
        let code = if error.kind() == io::ErrorKind::InvalidInput {
            "INVALID_WORKER_ARGUMENT"
        } else {
            "WORKER_AUTHENTICATION_FAILED"
        };
        ProtocolError::new(
            code,
            format!("Could not read inherited Worker token: {error}"),
        )
    })
}

fn fault_point(name: &str) {
    if std::env::var("KODA_EXEC_TEST_FAULT_POINT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn identity_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "PROCESS_IDENTITY_UNAVAILABLE",
        format!("Could not read process start identity: {error}"),
    )
}

fn worker_socket_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "WORKER_SOCKET_FAILED",
        format!("Could not create Worker Socket: {error}"),
    )
}

fn json_io_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn string_io_error(error: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn pty_input_queue_enforces_its_byte_budget_before_admission() {
        let root = std::env::temp_dir().join(format!("koda-pty-input-{}", Uuid::new_v4().simple()));
        let output = PtyOutputStore::open(&root, 65_536).expect("output store");
        let runtime = PtyRuntime::new("job", vec![7; 32], output);
        for _ in 0..4 {
            runtime
                .enqueue_input(vec![7; MAX_PTY_INPUT_BYTES])
                .expect("bounded input");
        }

        assert_eq!(
            runtime
                .enqueue_input(vec![7])
                .expect_err("queue byte limit")
                .code,
            "PTY_INPUT_BACKPRESSURE"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
