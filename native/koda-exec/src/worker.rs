use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::fs::OpenOptions;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, watch};
use tokio::time::{sleep, timeout};

use crate::durable::{JobLock, JobRecord, JobStore, StoredJobState, sha256_hex};
use crate::framing::{bind_private_socket, read_json_frame, verify_peer, write_json_frame};
use crate::internal_protocol::{
    EmptyParams, WORKER_PROTOCOL_VERSION, WorkerHelloParams, WorkerHelloResult, WorkerRequest,
    WorkerResponse, WorkerTerminateParams, decode_base64, encode_base64, parse_params,
    status_value, worker_proof,
};
use crate::process_identity::current_process_identity;
use crate::protocol::{
    JobFailure, JobSnapshot, JobState, ProtocolError, TerminationAttempt, TerminationReason,
    TerminationSnapshot,
};

const OUTPUT_BUFFER_BYTES: usize = 16_384;

pub async fn run_worker(job_directory: &Path, token_fd: RawFd) -> Result<(), ProtocolError> {
    let token = read_inherited_token(token_fd)?;
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
    let worker_identity = current_process_identity().map_err(identity_error)?;
    let listener = bind_private_socket(&record.worker_socket_path())
        .await
        .map_err(worker_socket_error)?;
    let runtime = Arc::new(WorkerRuntime::new(record, current));
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
    let _ = std::fs::remove_file(runtime.record.worker_socket_path());
    execution
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
}

impl WorkerRuntime {
    fn new(record: JobRecord, state: StoredJobState) -> Self {
        let (terminate_sender, terminate_receiver) = mpsc::channel(1);
        Self {
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
        }
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
        next.state = JobState::CommandStarting;
        *guard = self.record.transition(&guard, next)?;
        Ok(())
    }

    async fn publish_running(&self, pid: u32, identity: String) -> Result<(), ProtocolError> {
        let mut guard = self.state.lock().await;
        let mut next = guard.clone();
        next.state = JobState::Running;
        next.command_pid = Some(pid);
        next.command_start_identity = Some(identity);
        *guard = self.record.transition(&guard, next)?;
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
            next.signal = status.signal().map(signal_name);
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
        state.snapshot()
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
        sync_file(&self.record.stdout_path()).await?;
        sync_file(&self.record.stderr_path()).await?;
        Ok(self.snapshot().await)
    }
}

async fn serve_worker(
    listener: UnixListener,
    runtime: Arc<WorkerRuntime>,
    token: Vec<u8>,
    worker_identity: String,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                verify_peer(&stream)?;
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
    mut stream: UnixStream,
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

async fn execute_job(runtime: Arc<WorkerRuntime>) -> Result<(), ProtocolError> {
    runtime.publish_command_starting().await?;
    fault_point("after_command_starting");
    let params = runtime.record.manifest.start.clone();
    let (gate_read, gate_write) = create_command_gate().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not create the command start gate: {error}"),
        )
    })?;
    let gate_read_fd = gate_read.as_raw_fd();
    let gate_write_fd = gate_write.as_raw_fd();
    let bootstrap = std::env::current_exe().map_err(|error| {
        ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not locate the command bootstrap: {error}"),
        )
    })?;
    let mut command = Command::new(bootstrap);
    command
        .arg("command-bootstrap")
        .arg("--gate-fd")
        .arg("3")
        .arg("--")
        .args(&params.argv)
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&params.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    std::os::unix::process::CommandExt::process_group(command.as_std_mut(), 0);
    // SAFETY: the bootstrap receives only the dedicated gate descriptor. The
    // closure performs async-signal-safe descriptor operations before exec.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(command.as_std_mut(), move || {
            libc::close(gate_write_fd);
            if gate_read_fd != 3 {
                if libc::dup2(gate_read_fd, 3) < 0 {
                    return Err(io::Error::last_os_error());
                }
                libc::close(gate_read_fd);
            } else {
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
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
    let command_identity = crate::process_identity::process_start_identity(pid)
        .map_err(identity_error)?
        .ok_or_else(|| ProtocolError::new("COMMAND_START_FAILED", "Process identity vanished."))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = signal_process_group(pid, libc::SIGKILL);
        return runtime
            .publish_start_failed(io::Error::other("stdout was not captured"))
            .await;
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = signal_process_group(pid, libc::SIGKILL);
        return runtime
            .publish_start_failed(io::Error::other("stderr was not captured"))
            .await;
    };
    if let Err(error) = runtime.publish_running(pid, command_identity).await {
        drop(gate_write);
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
    if let Err(error) = release_command_gate(gate_write) {
        let _ = terminate_child(
            &mut child,
            pid,
            TerminationReason::OutputFailure,
            params.termination_grace_ms,
            params.termination_confirmation_ms,
        )
        .await;
        return Err(ProtocolError::new(
            "COMMAND_START_FAILED",
            format!("Could not release the command start gate: {error}"),
        ));
    }
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

pub fn run_command_bootstrap(gate_fd: RawFd, argv: Vec<String>) -> io::Result<()> {
    if argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command bootstrap argv is empty",
        ));
    }
    // SAFETY: the Worker transfers ownership of this dedicated descriptor.
    let mut gate = unsafe { std::fs::File::from_raw_fd(gate_fd) };
    let mut byte = [0u8; 1];
    gate.read_exact(&mut byte)?;
    if byte[0] != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "command bootstrap gate value is invalid",
        ));
    }
    drop(gate);
    let error = std::os::unix::process::CommandExt::exec(
        std::process::Command::new(&argv[0]).args(&argv[1..]),
    );
    Err(error)
}

fn create_command_gate() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1, -1];
    // SAFETY: pipe initializes both descriptors on success.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful pipe returned two owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: successful pipe returned two distinct owned descriptors.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_close_on_exec(read.as_raw_fd())?;
    set_close_on_exec(write.as_raw_fd())?;
    Ok((read, write))
}

fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    // SAFETY: fcntl reads and updates flags on a valid owned descriptor.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn release_command_gate(write: OwnedFd) -> io::Result<()> {
    let descriptor = write.as_raw_fd();
    let byte = 1u8;
    loop {
        // SAFETY: write consumes one byte from valid memory on a valid pipe descriptor.
        let result =
            unsafe { libc::write(descriptor, &byte as *const u8 as *const libc::c_void, 1) };
        if result == 1 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

enum JobTrigger {
    Exited(io::Result<std::process::ExitStatus>),
    Terminate(TerminationReason),
    OutputFailed(String),
}

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
        .open(path)
        .await
        .map_err(|error| error.to_string())?
        .sync_all()
        .await
        .map_err(|error| error.to_string())
}

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
    let _ = signal_process_group(pid, libc::SIGTERM);
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
    let _ = signal_process_group(pid, libc::SIGKILL);
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
    let _ = signal_process_group(pid, libc::SIGTERM);
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
    let _ = signal_process_group(pid, libc::SIGKILL);
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

pub async fn cleanup_verified_process_group(
    pid: u32,
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

fn signal_process_group(pid: u32, signal: i32) -> io::Result<()> {
    let process_group = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process ID exceeds i32"))?;
    // SAFETY: kill is called with a validated positive process-group ID and a platform signal.
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

fn process_group_exists(pid: u32) -> bool {
    let Ok(process_group) = i32::try_from(pid) else {
        return true;
    };
    // SAFETY: signal 0 performs an existence/permission check without delivering a signal.
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn read_inherited_token(token_fd: RawFd) -> Result<Vec<u8>, ProtocolError> {
    if token_fd < 3 {
        return Err(ProtocolError::new(
            "INVALID_WORKER_ARGUMENT",
            "Worker token descriptor must not overlap standard streams.",
        ));
    }
    // SAFETY: the Supervisor passes ownership of this dedicated descriptor to the Worker.
    let file = unsafe { std::fs::File::from_raw_fd(token_fd) };
    let mut token = Vec::new();
    file.take(33).read_to_end(&mut token).map_err(|error| {
        ProtocolError::new(
            "WORKER_AUTHENTICATION_FAILED",
            format!("Could not read inherited Worker token: {error}"),
        )
    })?;
    if token.len() != 32 {
        return Err(ProtocolError::new(
            "WORKER_AUTHENTICATION_FAILED",
            "Inherited Worker token must contain exactly 32 bytes.",
        ));
    }
    Ok(token)
}

fn fault_point(name: &str) {
    if std::env::var("KODA_EXEC_TEST_FAULT_POINT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".to_owned(),
        libc::SIGINT => "SIGINT".to_owned(),
        libc::SIGQUIT => "SIGQUIT".to_owned(),
        libc::SIGKILL => "SIGKILL".to_owned(),
        libc::SIGTERM => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
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
