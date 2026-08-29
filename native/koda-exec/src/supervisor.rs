use std::collections::HashMap;
use std::io;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use crate::protocol::{
    JobFailure, JobSnapshot, JobState, OutputReadResult, OutputStream, ProtocolError,
    ReadOutputParams, StartParams, TerminateParams, TerminationAttempt, TerminationReason,
    TerminationSnapshot, validate_identifier, validate_output_read, validate_start,
};

const OUTPUT_BUFFER_BYTES: usize = 16_384;

pub struct Supervisor {
    jobs_root: PathBuf,
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<String, Arc<Job>>,
    requests: HashMap<String, StartRequestRecord>,
}

struct StartRequestRecord {
    canonical_params: String,
    job_id: String,
}

struct Job {
    id: String,
    created_at: Instant,
    inner: Mutex<JobInner>,
    stdout: OutputCapture,
    stderr: OutputCapture,
    terminate: mpsc::Sender<TerminationReason>,
}

struct JobInner {
    state: JobState,
    pid: Option<u32>,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    finished_duration_ms: Option<u64>,
    termination: Option<TerminationSnapshot>,
    failure: Option<JobFailure>,
}

struct OutputCapture {
    path: PathBuf,
    limit: u64,
    total: AtomicU64,
    retained: AtomicU64,
    complete: AtomicBool,
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

impl Supervisor {
    pub fn open(state_dir: &Path) -> Result<Arc<Self>, ProtocolError> {
        let jobs_root = state_dir.join("jobs");
        create_private_directory(state_dir)?;
        create_private_directory(&jobs_root)?;
        Ok(Arc::new(Self {
            jobs_root,
            registry: Mutex::new(Registry::default()),
        }))
    }

    pub async fn start(
        self: &Arc<Self>,
        request_id: String,
        params: StartParams,
    ) -> Result<JobSnapshot, ProtocolError> {
        validate_start(&params)?;
        let canonical_params = serde_json::to_string(&params).map_err(|error| {
            ProtocolError::new(
                "INVALID_REQUEST",
                format!("Could not canonicalize the execution request: {error}"),
            )
        })?;

        let mut registry = self.registry.lock().await;
        if let Some(existing) = registry.requests.get(&request_id) {
            if existing.canonical_params != canonical_params {
                return Err(ProtocolError::new(
                    "IDEMPOTENCY_CONFLICT",
                    "The request ID was already used with different execution parameters.",
                ));
            }
            let job = registry.jobs.get(&existing.job_id).ok_or_else(|| {
                ProtocolError::new(
                    "INTERNAL_ERROR",
                    "The idempotency record refers to a missing job.",
                )
            })?;
            return Ok(job.snapshot().await);
        }

        let job_id = Uuid::new_v4().simple().to_string();
        let job_directory = self.jobs_root.join(&job_id);
        create_private_directory(&job_directory)?;
        let stdout_path = job_directory.join("stdout.bin");
        let stderr_path = job_directory.join("stderr.bin");
        create_private_file(&stdout_path)?;
        create_private_file(&stderr_path)?;
        let (terminate, terminate_receiver) = mpsc::channel(1);
        let job = Arc::new(Job {
            id: job_id.clone(),
            created_at: Instant::now(),
            inner: Mutex::new(JobInner {
                state: JobState::Starting,
                pid: None,
                exit_code: None,
                signal: None,
                timed_out: false,
                finished_duration_ms: None,
                termination: None,
                failure: None,
            }),
            stdout: OutputCapture::new(stdout_path, params.output_limit_bytes),
            stderr: OutputCapture::new(stderr_path, params.output_limit_bytes),
            terminate,
        });
        registry.jobs.insert(job_id.clone(), Arc::clone(&job));
        registry.requests.insert(
            request_id,
            StartRequestRecord {
                canonical_params,
                job_id,
            },
        );
        drop(registry);

        tokio::spawn(run_job(Arc::clone(&job), params, terminate_receiver));
        Ok(job.snapshot().await)
    }

    pub async fn get(&self, job_id: &str) -> Result<JobSnapshot, ProtocolError> {
        Ok(self.find_job(job_id).await?.snapshot().await)
    }

    pub async fn terminate(&self, params: TerminateParams) -> Result<JobSnapshot, ProtocolError> {
        validate_identifier(&params.job_id, "job_id")?;
        if matches!(
            params.reason,
            TerminationReason::Timeout | TerminationReason::OrphanCleanup
        ) {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                "Clients may request only cancellation or output_failure termination.",
            ));
        }
        let job = self.find_job(&params.job_id).await?;
        if !job.inner.lock().await.state.is_terminal() {
            match job.terminate.try_send(params.reason) {
                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    return Err(ProtocolError::new(
                        "INTERNAL_ERROR",
                        "The job termination channel closed before the job reached a terminal state.",
                    ));
                }
            }
        }
        Ok(job.snapshot().await)
    }

    pub async fn read_output(
        &self,
        params: ReadOutputParams,
    ) -> Result<OutputReadResult, ProtocolError> {
        validate_output_read(&params)?;
        let job = self.find_job(&params.job_id).await?;
        let output = match params.stream {
            OutputStream::Stdout => &job.stdout,
            OutputStream::Stderr => &job.stderr,
        };
        output
            .read(&job.id, params.stream, params.offset, params.max_bytes)
            .await
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        request_id: String,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ProtocolError> {
        match method {
            "job/start" => {
                let params = crate::protocol::parse_params(params)?;
                serde_json::to_value(self.start(request_id, params).await?)
                    .map_err(internal_json_error)
            }
            "job/get" => {
                let params: crate::protocol::JobParams = crate::protocol::parse_params(params)?;
                validate_identifier(&params.job_id, "job_id")?;
                serde_json::to_value(self.get(&params.job_id).await?).map_err(internal_json_error)
            }
            "job/output/read" => {
                let params = crate::protocol::parse_params(params)?;
                serde_json::to_value(self.read_output(params).await?).map_err(internal_json_error)
            }
            "job/terminate" => {
                let params = crate::protocol::parse_params(params)?;
                serde_json::to_value(self.terminate(params).await?).map_err(internal_json_error)
            }
            _ => Err(ProtocolError::new(
                "METHOD_NOT_FOUND",
                format!("Unknown executor method: {method}"),
            )),
        }
    }

    async fn find_job(&self, job_id: &str) -> Result<Arc<Job>, ProtocolError> {
        validate_identifier(job_id, "job_id")?;
        self.registry
            .lock()
            .await
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| {
                ProtocolError::new("JOB_NOT_FOUND", format!("Job '{job_id}' was not found."))
            })
    }
}

impl Job {
    async fn snapshot(&self) -> JobSnapshot {
        let inner = self.inner.lock().await;
        JobSnapshot {
            job_id: self.id.clone(),
            state: inner.state,
            pid: inner.pid,
            exit_code: inner.exit_code,
            signal: inner.signal.clone(),
            timed_out: inner.timed_out,
            duration_ms: inner
                .finished_duration_ms
                .unwrap_or_else(|| duration_millis(self.created_at.elapsed())),
            stdout_bytes: self.stdout.total.load(Ordering::Acquire),
            stderr_bytes: self.stderr.total.load(Ordering::Acquire),
            stdout_retained_bytes: self.stdout.retained.load(Ordering::Acquire),
            stderr_retained_bytes: self.stderr.retained.load(Ordering::Acquire),
            stdout_truncated: self.stdout.total.load(Ordering::Acquire) > self.stdout.limit,
            stderr_truncated: self.stderr.total.load(Ordering::Acquire) > self.stderr.limit,
            termination: inner.termination.clone(),
            failure: inner.failure.clone(),
        }
    }

    async fn fail_start(&self, error: io::Error) {
        self.stdout.complete.store(true, Ordering::Release);
        self.stderr.complete.store(true, Ordering::Release);
        let code = if error.kind() == io::ErrorKind::NotFound {
            "COMMAND_NOT_FOUND"
        } else {
            "COMMAND_START_FAILED"
        };
        let mut inner = self.inner.lock().await;
        inner.state = JobState::StartFailed;
        inner.finished_duration_ms = Some(duration_millis(self.created_at.elapsed()));
        inner.failure = Some(JobFailure {
            code,
            message: format!("Command could not start: {error}"),
        });
    }

    async fn finish(
        &self,
        state: JobState,
        status: Option<std::process::ExitStatus>,
        timed_out: bool,
        termination: Option<TerminationSnapshot>,
        failure: Option<JobFailure>,
    ) {
        let mut inner = self.inner.lock().await;
        inner.state = state;
        inner.timed_out = timed_out;
        inner.finished_duration_ms = Some(duration_millis(self.created_at.elapsed()));
        inner.termination = termination;
        inner.failure = failure;
        if let Some(status) = status {
            inner.exit_code = status.code();
            inner.signal = status.signal().map(signal_name);
        }
    }
}

impl OutputCapture {
    fn new(path: PathBuf, limit: u64) -> Self {
        Self {
            path,
            limit,
            total: AtomicU64::new(0),
            retained: AtomicU64::new(0),
            complete: AtomicBool::new(false),
        }
    }

    async fn read(
        &self,
        job_id: &str,
        stream: OutputStream,
        offset: u64,
        max_bytes: u32,
    ) -> Result<OutputReadResult, ProtocolError> {
        let retained = self.retained.load(Ordering::Acquire);
        if offset > retained {
            return Err(ProtocolError::new(
                "INVALID_OUTPUT_RANGE",
                format!("Output offset {offset} exceeds the retained length {retained}."),
            ));
        }
        let length = u64::from(max_bytes).min(retained - offset) as usize;
        let mut bytes = vec![0u8; length];
        if length > 0 {
            let mut file = File::open(&self.path).await.map_err(output_read_error)?;
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(output_read_error)?;
            file.read_exact(&mut bytes)
                .await
                .map_err(output_read_error)?;
        }
        let next_offset = offset + bytes.len() as u64;
        let total = self.total.load(Ordering::Acquire);
        Ok(OutputReadResult {
            job_id: job_id.to_owned(),
            stream,
            offset,
            next_offset,
            total_bytes: total,
            retained_bytes: retained,
            complete: self.complete.load(Ordering::Acquire) && next_offset == retained,
            truncated: total > self.limit,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
}

async fn run_job(
    job: Arc<Job>,
    params: StartParams,
    mut terminate_receiver: mpsc::Receiver<TerminationReason>,
) {
    let executable = &params.argv[0];
    let mut command = Command::new(executable);
    command
        .args(&params.argv[1..])
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&params.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    std::os::unix::process::CommandExt::process_group(command.as_std_mut(), 0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            job.fail_start(error).await;
            return;
        }
    };
    let Some(pid) = child.id() else {
        job.fail_start(io::Error::other(
            "the operating system returned no process ID",
        ))
        .await;
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = signal_process_group(pid, libc::SIGKILL);
        job.fail_start(io::Error::other("stdout was not captured"))
            .await;
        return;
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = signal_process_group(pid, libc::SIGKILL);
        job.fail_start(io::Error::other("stderr was not captured"))
            .await;
        return;
    };
    {
        let mut inner = job.inner.lock().await;
        inner.state = JobState::Running;
        inner.pid = Some(pid);
    }

    let (output_failure_sender, mut output_failure_receiver) = mpsc::channel(1);
    let stdout_job = Arc::clone(&job);
    let stdout_failure_sender = output_failure_sender.clone();
    let stdout_task = tokio::spawn(async move {
        if let Err(error) = capture_output(stdout, &stdout_job.stdout).await {
            let _ = stdout_failure_sender.send(error.to_string()).await;
        }
    });
    let stderr_job = Arc::clone(&job);
    let stderr_task = tokio::spawn(async move {
        if let Err(error) = capture_output(stderr, &stderr_job.stderr).await {
            let _ = output_failure_sender.send(error.to_string()).await;
        }
    });

    let trigger = tokio::select! {
        status = child.wait() => JobTrigger::Exited(status),
        reason = terminate_receiver.recv() => {
            JobTrigger::Terminate(reason.unwrap_or(TerminationReason::Cancellation))
        }
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
                code: "COMMAND_WAIT_FAILED",
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
            {
                let mut inner = job.inner.lock().await;
                inner.state = JobState::Terminating;
            }
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
            {
                let mut inner = job.inner.lock().await;
                inner.state = JobState::Terminating;
            }
            failure = Some(JobFailure {
                code: "OUTPUT_CAPTURE_FAILED",
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
    job.stdout.complete.store(true, Ordering::Release);
    job.stderr.complete.store(true, Ordering::Release);
    job.finish(state, status, timed_out, termination, failure)
        .await;
}

async fn capture_output<R>(mut source: R, output: &OutputCapture) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut destination = OpenOptions::new().append(true).open(&output.path).await?;
    let mut buffer = vec![0u8; OUTPUT_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            destination.sync_all().await?;
            return Ok(());
        }
        output.total.fetch_add(count as u64, Ordering::AcqRel);
        let retained = output.retained.load(Ordering::Acquire);
        let writable = count.min(output.limit.saturating_sub(retained) as usize);
        if writable > 0 {
            destination.write_all(&buffer[..writable]).await?;
            destination.flush().await?;
            output.retained.fetch_add(writable as u64, Ordering::AcqRel);
        }
    }
}

async fn terminate_child(
    child: &mut Child,
    pid: u32,
    reason: TerminationReason,
    grace_ms: u64,
    confirmation_ms: u64,
) -> TerminationResult {
    let mut attempts = Vec::new();
    attempts.push(TerminationAttempt {
        attempt: "graceful",
        mechanism: "posix_process_group_signal",
    });
    let _ = signal_process_group(pid, libc::SIGTERM);
    if let Ok(status) = timeout(Duration::from_millis(grace_ms), child.wait()).await {
        return TerminationResult {
            status: status.ok(),
            snapshot: TerminationSnapshot {
                reason: reason.as_str(),
                outcome: "terminated",
                attempts,
            },
        };
    }

    attempts.push(TerminationAttempt {
        attempt: "force",
        mechanism: "posix_process_group_signal",
    });
    let _ = signal_process_group(pid, libc::SIGKILL);
    match timeout(Duration::from_millis(confirmation_ms), child.wait()).await {
        Ok(Ok(status)) => TerminationResult {
            status: Some(status),
            snapshot: TerminationSnapshot {
                reason: reason.as_str(),
                outcome: "terminated",
                attempts,
            },
        },
        Ok(Err(_)) | Err(_) => TerminationResult {
            status: None,
            snapshot: TerminationSnapshot {
                reason: reason.as_str(),
                outcome: "uncertain",
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
        attempt: "graceful",
        mechanism: "posix_process_group_signal",
    }];
    let _ = signal_process_group(pid, libc::SIGTERM);
    if wait_for_group_exit(pid, grace_ms).await {
        return TerminationSnapshot {
            reason: reason.as_str(),
            outcome: "terminated",
            attempts,
        };
    }
    attempts.push(TerminationAttempt {
        attempt: "force",
        mechanism: "posix_process_group_signal",
    });
    let _ = signal_process_group(pid, libc::SIGKILL);
    TerminationSnapshot {
        reason: reason.as_str(),
        outcome: if wait_for_group_exit(pid, confirmation_ms).await {
            "terminated"
        } else {
            "uncertain"
        },
        attempts,
    }
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

fn create_private_directory(path: &Path) -> Result<(), ProtocolError> {
    std::fs::create_dir_all(path).map_err(|error| {
        ProtocolError::new(
            "STATE_DIRECTORY_UNAVAILABLE",
            format!(
                "Could not create private state directory '{}': {error}",
                path.display()
            ),
        )
    })?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        ProtocolError::new(
            "STATE_DIRECTORY_UNAVAILABLE",
            format!(
                "Could not protect state directory '{}': {error}",
                path.display()
            ),
        )
    })
}

fn create_private_file(path: &Path) -> Result<(), ProtocolError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map(|_| ())
        .map_err(|error| {
            ProtocolError::new(
                "STATE_DIRECTORY_UNAVAILABLE",
                format!(
                    "Could not create private output file '{}': {error}",
                    path.display()
                ),
            )
        })
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn internal_json_error(error: serde_json::Error) -> ProtocolError {
    ProtocolError::new(
        "INTERNAL_ERROR",
        format!("Could not encode the executor response: {error}"),
    )
}

fn output_read_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "OUTPUT_READ_FAILED",
        format!("Could not read retained command output: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!("koda-exec-test-{}", Uuid::new_v4().simple()))
    }

    fn command(script: &str) -> StartParams {
        StartParams {
            argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()],
            cwd: std::env::current_dir().expect("cwd").display().to_string(),
            environment: BTreeMap::new(),
            timeout_ms: 2_000,
            output_limit_bytes: 1_024,
            termination_grace_ms: 25,
            termination_confirmation_ms: 1_000,
        }
    }

    async fn wait_terminal(supervisor: &Supervisor, job_id: &str) -> JobSnapshot {
        for _ in 0..200 {
            let snapshot = supervisor.get(job_id).await.expect("job");
            if snapshot.state.is_terminal() {
                return snapshot;
            }
            sleep(Duration::from_millis(10)).await;
        }
        panic!("job did not finish");
    }

    #[tokio::test]
    async fn duplicate_start_is_idempotent_and_conflicts_fail() {
        let root = temporary_directory();
        let supervisor = Supervisor::open(&root).expect("supervisor");
        let first = supervisor
            .start("request-1".to_owned(), command("printf one"))
            .await
            .expect("start");
        let duplicate = supervisor
            .start("request-1".to_owned(), command("printf one"))
            .await
            .expect("duplicate");
        assert_eq!(first.job_id, duplicate.job_id);

        let error = supervisor
            .start("request-1".to_owned(), command("printf two"))
            .await
            .expect_err("conflict");
        assert_eq!(error.code, "IDEMPOTENCY_CONFLICT");
        let _ = wait_terminal(&supervisor, &first.job_id).await;
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn captures_bounded_output_and_exact_counts() {
        let root = temporary_directory();
        let supervisor = Supervisor::open(&root).expect("supervisor");
        let mut params = command("printf 123456789");
        params.output_limit_bytes = 4;
        let started = supervisor
            .start("request-2".to_owned(), params)
            .await
            .expect("start");
        let snapshot = wait_terminal(&supervisor, &started.job_id).await;
        assert_eq!(snapshot.stdout_bytes, 9);
        assert_eq!(snapshot.stdout_retained_bytes, 4);
        assert!(snapshot.stdout_truncated);
        let output = supervisor
            .read_output(ReadOutputParams {
                job_id: started.job_id,
                stream: OutputStream::Stdout,
                offset: 0,
                max_bytes: 64,
            })
            .await
            .expect("output");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(output.data_base64)
                .expect("base64"),
            b"1234"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn timeout_terminates_the_process_group() {
        let root = temporary_directory();
        let supervisor = Supervisor::open(&root).expect("supervisor");
        let mut params = command("trap '' TERM; while :; do sleep 1; done");
        params.timeout_ms = 100;
        let started = supervisor
            .start("request-3".to_owned(), params)
            .await
            .expect("start");
        let snapshot = wait_terminal(&supervisor, &started.job_id).await;
        assert!(snapshot.timed_out);
        assert_eq!(snapshot.state, JobState::Exited);
        assert_eq!(
            snapshot.termination.as_ref().map(|value| value.reason),
            Some("timeout")
        );
        assert_eq!(
            snapshot
                .termination
                .as_ref()
                .map(|value| value.attempts.len()),
            Some(2)
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn closed_output_streams_do_not_end_a_still_running_job() {
        let root = temporary_directory();
        let supervisor = Supervisor::open(&root).expect("supervisor");
        let started = supervisor
            .start(
                "request-4".to_owned(),
                command("exec 1>&- 2>&-; sleep 0.15; exit 7"),
            )
            .await
            .expect("start");
        let snapshot = wait_terminal(&supervisor, &started.job_id).await;

        assert_eq!(snapshot.state, JobState::Exited);
        assert_eq!(snapshot.exit_code, Some(7));
        assert!(snapshot.termination.is_none());
        assert!(snapshot.failure.is_none());
        assert!(snapshot.duration_ms >= 100);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
