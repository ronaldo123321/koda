use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::durable::{JobRecord, JobStore};
use crate::framing::{read_json_frame, verify_peer, write_json_frame};
use crate::internal_protocol::{
    WORKER_PROTOCOL_VERSION, WorkerHelloParams, WorkerHelloResult, WorkerRequest, WorkerResponse,
    WorkerTerminateParams, decode_base64, encode_base64, new_nonce, worker_proof,
};
use crate::process_identity::process_identity_matches;
use crate::protocol::{
    JobFailure, JobSnapshot, JobState, JobSummary, ListJobsParams, ListJobsResult,
    OutputReadResult, OutputStream, ProtocolError, ReadOutputParams, StartParams, TerminateParams,
    TerminationAttempt, TerminationReason, TerminationSnapshot, validate_identifier,
    validate_output_read, validate_start,
};

const MAX_SCANNED_JOBS: usize = 10_000;
const MAX_LIST_JOBS: u32 = 100;
const DEFAULT_LIST_JOBS: u32 = 50;
const RETAIN_TERMINAL_JOBS: usize = 1_000;
const RETAIN_TERMINAL_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;
const START_WAIT_ATTEMPTS: usize = 100;

pub struct Supervisor {
    store: JobStore,
    binary_path: PathBuf,
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<String, JobRecord>,
    requests: HashMap<String, StartRequestRecord>,
}

struct StartRequestRecord {
    request_digest: String,
    job_id: String,
}

impl Supervisor {
    pub async fn open(state_dir: &Path, binary_path: PathBuf) -> Result<Arc<Self>, ProtocolError> {
        let store = JobStore::open(state_dir)?;
        store.finish_trash_cleanup()?;
        let mut records = store.scan(MAX_SCANNED_JOBS)?;
        apply_retention(&store, &mut records)?;

        let mut registry = Registry::default();
        for record in records {
            let job_id = record.manifest.job_id.clone();
            let request_id = record.manifest.request_id.clone();
            if registry.jobs.contains_key(&job_id) || registry.requests.contains_key(&request_id) {
                return Err(ProtocolError::new(
                    "JOB_STATE_CORRUPT",
                    "Durable job identities are duplicated.",
                ));
            }
            registry.requests.insert(
                request_id,
                StartRequestRecord {
                    request_digest: record.manifest.request_digest.clone(),
                    job_id: job_id.clone(),
                },
            );
            registry.jobs.insert(job_id, record);
        }

        let supervisor = Arc::new(Self {
            store,
            binary_path,
            registry: Mutex::new(registry),
        });
        supervisor.recover_all().await;
        Ok(supervisor)
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        request_id: String,
        method: &str,
        params: Value,
    ) -> Result<Value, ProtocolError> {
        match method {
            "job/start" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.start(request_id, params).await?)
            }
            "job/get" => {
                let params: crate::protocol::JobParams = crate::protocol::parse_params(params)?;
                encode(self.get(&params.job_id).await?)
            }
            "job/output/read" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.read_output(params).await?)
            }
            "job/terminate" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.terminate(params).await?)
            }
            "job/list" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.list(params).await?)
            }
            _ => Err(ProtocolError::new(
                "METHOD_NOT_FOUND",
                format!("Unknown executor method: {method}"),
            )),
        }
    }

    pub async fn start(
        self: &Arc<Self>,
        request_id: String,
        params: StartParams,
    ) -> Result<JobSnapshot, ProtocolError> {
        validate_start(&params)?;
        let request_bytes = serde_json::to_vec(&params).map_err(internal_json_error)?;
        let request_digest = crate::durable::sha256_hex(&request_bytes);

        let mut registry = self.registry.lock().await;
        if let Some(existing) = registry.requests.get(&request_id) {
            if existing.request_digest != request_digest {
                return Err(ProtocolError::new(
                    "IDEMPOTENCY_CONFLICT",
                    "The request ID was already used with different execution parameters.",
                ));
            }
            let job_id = existing.job_id.clone();
            drop(registry);
            return self.get(&job_id).await;
        }

        let (record, _) = self.store.create_job(&request_id, params)?;
        let job_id = record.manifest.job_id.clone();
        registry.requests.insert(
            request_id,
            StartRequestRecord {
                request_digest,
                job_id: job_id.clone(),
            },
        );
        registry.jobs.insert(job_id, record.clone());
        drop(registry);

        fault_point("after_accepted");
        self.spawn_worker(&record)?;
        self.wait_for_start(&record).await
    }

    pub async fn get(self: &Arc<Self>, job_id: &str) -> Result<JobSnapshot, ProtocolError> {
        let record = self.find_job(job_id).await?;
        let state = record.read_state()?;
        if state.state.is_terminal() {
            return Ok(state.snapshot());
        }
        match worker_snapshot(&record, "worker/status", json!({})).await {
            Ok(snapshot) => Ok(snapshot),
            Err(error) if error.code == "WORKER_UNAVAILABLE" => self.reconcile(&record).await,
            Err(error) => Err(error),
        }
    }

    pub async fn terminate(
        self: &Arc<Self>,
        params: TerminateParams,
    ) -> Result<JobSnapshot, ProtocolError> {
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
        let record = self.find_job(&params.job_id).await?;
        let current = record.read_state()?;
        if current.state.is_terminal() {
            return Ok(current.snapshot());
        }
        let request = serde_json::to_value(WorkerTerminateParams {
            reason: params.reason,
        })
        .map_err(internal_json_error)?;
        match worker_snapshot(&record, "worker/terminate", request).await {
            Ok(snapshot) => Ok(snapshot),
            Err(error) if error.code == "WORKER_UNAVAILABLE" => {
                let snapshot = self.reconcile(&record).await?;
                if snapshot.state.is_terminal() {
                    Ok(snapshot)
                } else {
                    worker_snapshot(
                        &record,
                        "worker/terminate",
                        serde_json::to_value(WorkerTerminateParams {
                            reason: params.reason,
                        })
                        .map_err(internal_json_error)?,
                    )
                    .await
                }
            }
            Err(error) => Err(error),
        }
    }

    pub async fn read_output(
        self: &Arc<Self>,
        params: ReadOutputParams,
    ) -> Result<OutputReadResult, ProtocolError> {
        validate_output_read(&params)?;
        let record = self.find_job(&params.job_id).await?;
        let mut snapshot = record.read_state()?.snapshot();
        if !snapshot.state.is_terminal() {
            snapshot = match worker_snapshot(&record, "worker/output/sync", json!({})).await {
                Ok(snapshot) => snapshot,
                Err(error) if error.code == "WORKER_UNAVAILABLE" => self.reconcile(&record).await?,
                Err(error) => return Err(error),
            };
        }

        let (path, total_bytes, retained_bytes, truncated) = match params.stream {
            OutputStream::Stdout => (
                record.stdout_path(),
                snapshot.stdout_bytes,
                snapshot.stdout_retained_bytes,
                snapshot.stdout_truncated,
            ),
            OutputStream::Stderr => (
                record.stderr_path(),
                snapshot.stderr_bytes,
                snapshot.stderr_retained_bytes,
                snapshot.stderr_truncated,
            ),
        };
        let file_retained = tokio::fs::metadata(&path)
            .await
            .map_err(output_io_error)?
            .len();
        let retained_bytes = retained_bytes.max(file_retained);
        if params.offset > retained_bytes {
            return Err(ProtocolError::new(
                "INVALID_OUTPUT_RANGE",
                format!(
                    "Output offset {} exceeds retained length {retained_bytes}.",
                    params.offset
                ),
            ));
        }
        let readable = retained_bytes
            .saturating_sub(params.offset)
            .min(u64::from(params.max_bytes));
        let mut file = tokio::fs::File::open(path).await.map_err(output_io_error)?;
        file.seek(io::SeekFrom::Start(params.offset))
            .await
            .map_err(output_io_error)?;
        let mut bytes = Vec::with_capacity(readable as usize);
        file.take(readable)
            .read_to_end(&mut bytes)
            .await
            .map_err(output_io_error)?;
        let next_offset = params.offset.saturating_add(bytes.len() as u64);
        Ok(OutputReadResult {
            job_id: params.job_id,
            stream: params.stream,
            offset: params.offset,
            next_offset,
            total_bytes: total_bytes.max(retained_bytes),
            retained_bytes,
            complete: snapshot.state.is_terminal() && next_offset >= retained_bytes,
            truncated: truncated || total_bytes > retained_bytes,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    pub async fn list(&self, params: ListJobsParams) -> Result<ListJobsResult, ProtocolError> {
        let limit = params.limit.unwrap_or(DEFAULT_LIST_JOBS);
        if limit == 0 || limit > MAX_LIST_JOBS {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                format!("limit must be between 1 and {MAX_LIST_JOBS}."),
            ));
        }
        if let Some(cursor) = &params.cursor {
            validate_identifier(cursor, "cursor")?;
        }
        let records = self
            .registry
            .lock()
            .await
            .jobs
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut summaries = records
            .into_iter()
            .map(|record| {
                let state = record.read_state()?;
                Ok(JobSummary {
                    job_id: record.manifest.job_id,
                    state: state.state,
                    created_at_ms: record.manifest.created_at_ms,
                    updated_at_ms: state.updated_at_ms,
                    pid: state.command_pid,
                })
            })
            .collect::<Result<Vec<_>, ProtocolError>>()?;
        summaries.sort_by(|left, right| {
            right
                .created_at_ms
                .cmp(&left.created_at_ms)
                .then_with(|| right.job_id.cmp(&left.job_id))
        });
        let start = match params.cursor {
            Some(cursor) => summaries
                .iter()
                .position(|job| job.job_id == cursor)
                .map(|index| index + 1)
                .ok_or_else(|| ProtocolError::new("INVALID_REQUEST", "Cursor was not found."))?,
            None => 0,
        };
        let end = start.saturating_add(limit as usize).min(summaries.len());
        let jobs = summaries[start..end].to_vec();
        let next_cursor = if end < summaries.len() {
            jobs.last().map(|job| job.job_id.clone())
        } else {
            None
        };
        Ok(ListJobsResult { jobs, next_cursor })
    }

    async fn find_job(&self, job_id: &str) -> Result<JobRecord, ProtocolError> {
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

    fn spawn_worker(&self, record: &JobRecord) -> Result<(), ProtocolError> {
        let token_path = record.directory.join("control.token");
        let token_file = OpenOptions::new()
            .read(true)
            .open(&token_path)
            .map_err(worker_spawn_io_error)?;
        let source_fd = token_file.as_raw_fd();
        let mut command = Command::new(&self.binary_path);
        command
            .arg("worker")
            .arg("--job-dir")
            .arg(&record.directory)
            .arg("--token-fd")
            .arg("3")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        // SAFETY: the closure uses only async-signal-safe descriptor operations before exec.
        unsafe {
            command.pre_exec(move || {
                if source_fd != 3 {
                    if libc::dup2(source_fd, 3) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else {
                    let flags = libc::fcntl(3, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        command.spawn().map_err(worker_spawn_io_error)?;
        Ok(())
    }

    async fn wait_for_start(&self, record: &JobRecord) -> Result<JobSnapshot, ProtocolError> {
        for _ in 0..START_WAIT_ATTEMPTS {
            if let Ok(snapshot) = worker_snapshot(record, "worker/status", json!({})).await
                && !matches!(snapshot.state, JobState::Accepted | JobState::WorkerReady)
            {
                return Ok(snapshot);
            }
            let snapshot = record.read_state()?.snapshot();
            if snapshot.state.is_terminal()
                || !matches!(snapshot.state, JobState::Accepted | JobState::WorkerReady)
            {
                return Ok(snapshot);
            }
            sleep(Duration::from_millis(20)).await;
        }
        Ok(record.read_state()?.snapshot())
    }

    async fn recover_all(self: &Arc<Self>) {
        let records = self
            .registry
            .lock()
            .await
            .jobs
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for record in records {
            if record
                .read_state()
                .is_ok_and(|state| !state.state.is_terminal())
            {
                let _ = self.reconcile(&record).await;
            }
        }
    }

    async fn reconcile(self: &Arc<Self>, record: &JobRecord) -> Result<JobSnapshot, ProtocolError> {
        let current = record.read_state()?;
        if current.state.is_terminal() {
            return Ok(current.snapshot());
        }
        let Some(lock) = record.try_lock()? else {
            return Ok(current.snapshot());
        };
        let current = record.read_state()?;
        if current.state.is_terminal() {
            return Ok(current.snapshot());
        }
        remove_stale_worker_socket(record)?;
        if matches!(current.state, JobState::Accepted | JobState::WorkerReady) {
            drop(lock);
            self.spawn_worker(record)?;
            return self.wait_for_start(record).await;
        }

        let mut attempts = Vec::new();
        if let (Some(pid), Some(identity)) = (
            current.command_pid,
            current.command_start_identity.as_deref(),
        ) {
            if process_identity_matches(pid, identity) {
                attempts = crate::worker::cleanup_verified_process_group(
                    pid,
                    record.manifest.start.termination_grace_ms,
                    record.manifest.start.termination_confirmation_ms,
                )
                .await
                .attempts;
            } else {
                attempts.push(TerminationAttempt {
                    attempt: "identity_check".to_owned(),
                    mechanism: "process_start_identity_mismatch".to_owned(),
                });
            }
        } else {
            attempts.push(TerminationAttempt {
                attempt: "identity_check".to_owned(),
                mechanism: "command_identity_not_persisted".to_owned(),
            });
        }

        let stdout_retained = file_length(&record.stdout_path())?;
        let stderr_retained = file_length(&record.stderr_path())?;
        let mut next = current.clone();
        next.state = JobState::TerminationUncertain;
        next.stdout_retained_bytes = next.stdout_retained_bytes.max(stdout_retained);
        next.stderr_retained_bytes = next.stderr_retained_bytes.max(stderr_retained);
        next.stdout_bytes = next.stdout_bytes.max(next.stdout_retained_bytes);
        next.stderr_bytes = next.stderr_bytes.max(next.stderr_retained_bytes);
        next.termination = Some(TerminationSnapshot {
            reason: TerminationReason::OrphanCleanup.as_str().to_owned(),
            outcome: "uncertain".to_owned(),
            attempts,
        });
        next.failure = Some(JobFailure {
            code: "WORKER_LOST_AFTER_COMMAND_BOUNDARY".to_owned(),
            message: "The Worker disappeared after command start; the process group was reconciled without claiming a verified exit status.".to_owned(),
        });
        let state = record.transition(&current, next)?;
        drop(lock);
        Ok(state.snapshot())
    }
}

struct WorkerConnection {
    stream: UnixStream,
}

impl WorkerConnection {
    async fn connect(record: &JobRecord) -> Result<Self, ProtocolError> {
        let mut stream = UnixStream::connect(record.worker_socket_path())
            .await
            .map_err(worker_connect_error)?;
        verify_peer(&stream).map_err(|error| {
            ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                format!("Worker peer identity could not be verified: {error}"),
            )
        })?;
        let token = record.read_token()?;
        let nonce = new_nonce();
        let request_id = Uuid::new_v4().simple().to_string();
        let hello = WorkerRequest {
            protocol_version: WORKER_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: "worker/hello".to_owned(),
            params: serde_json::to_value(WorkerHelloParams {
                job_id: record.manifest.job_id.clone(),
                nonce_base64: encode_base64(&nonce),
            })
            .map_err(internal_json_error)?,
        };
        write_json_frame(&mut stream, &hello)
            .await
            .map_err(worker_connect_error)?;
        let response = read_worker_response(&mut stream, &request_id).await?;
        let result = response.result.ok_or_else(|| {
            ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                "Worker hello had no result.",
            )
        })?;
        let hello: WorkerHelloResult = serde_json::from_value(result).map_err(|error| {
            ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                format!("Worker hello result is invalid: {error}"),
            )
        })?;
        let state = record.read_state()?;
        if hello.job_id != record.manifest.job_id
            || state.worker_pid != Some(hello.worker_pid)
            || state.worker_start_identity.as_deref() != Some(&hello.worker_start_identity)
            || !process_identity_matches(hello.worker_pid, &hello.worker_start_identity)
        {
            return Err(ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                "Worker process identity does not match durable state.",
            ));
        }
        let proof = decode_base64(&hello.proof_base64)
            .map_err(|error| ProtocolError::new("WORKER_AUTHENTICATION_FAILED", error))?;
        let expected = worker_proof(
            &token,
            &nonce,
            &hello.job_id,
            hello.worker_pid,
            &hello.worker_start_identity,
        )
        .map_err(|error| ProtocolError::new("WORKER_AUTHENTICATION_FAILED", error))?;
        if !constant_time_equal(&proof, &expected) {
            return Err(ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                "Worker authentication proof is invalid.",
            ));
        }
        Ok(Self { stream })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, ProtocolError> {
        let request_id = Uuid::new_v4().simple().to_string();
        let request = WorkerRequest {
            protocol_version: WORKER_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            method: method.to_owned(),
            params,
        };
        write_json_frame(&mut self.stream, &request)
            .await
            .map_err(worker_connect_error)?;
        read_worker_response(&mut self.stream, &request_id)
            .await?
            .result
            .ok_or_else(|| ProtocolError::new("WORKER_PROTOCOL_ERROR", "Worker result is absent."))
    }
}

async fn worker_snapshot(
    record: &JobRecord,
    method: &str,
    params: Value,
) -> Result<JobSnapshot, ProtocolError> {
    let mut connection = WorkerConnection::connect(record).await?;
    let result = connection.call(method, params).await?;
    serde_json::from_value(result).map_err(|error| {
        ProtocolError::new(
            "WORKER_PROTOCOL_ERROR",
            format!("Worker snapshot is invalid: {error}"),
        )
    })
}

async fn read_worker_response(
    stream: &mut UnixStream,
    request_id: &str,
) -> Result<WorkerResponse, ProtocolError> {
    let response = read_json_frame::<WorkerResponse>(stream)
        .await
        .map_err(worker_connect_error)?
        .ok_or_else(|| ProtocolError::new("WORKER_UNAVAILABLE", "Worker closed the connection."))?;
    if response.protocol_version != WORKER_PROTOCOL_VERSION || response.request_id != request_id {
        return Err(ProtocolError::new(
            "WORKER_PROTOCOL_ERROR",
            "Worker response envelope does not match the request.",
        ));
    }
    if !response.ok {
        let error = response.error.map_or_else(
            || "Worker request failed without an error body.".to_owned(),
            |error| format!("{}: {}", error.code, error.message),
        );
        return Err(ProtocolError::new("WORKER_REQUEST_FAILED", error));
    }
    Ok(response)
}

fn apply_retention(store: &JobStore, records: &mut Vec<JobRecord>) -> Result<(), ProtocolError> {
    let now = unix_millis();
    records.sort_by_key(|record| {
        std::cmp::Reverse(
            record
                .read_state()
                .map(|state| state.updated_at_ms)
                .unwrap_or_default(),
        )
    });
    let mut retainable_terminal_count = 0usize;
    let mut retained = Vec::with_capacity(records.len());
    for record in records.drain(..) {
        let state = record.read_state()?;
        let retainable = matches!(state.state, JobState::Exited | JobState::StartFailed);
        if retainable {
            retainable_terminal_count += 1;
        }
        let expired = retainable
            && (now.saturating_sub(state.updated_at_ms) > RETAIN_TERMINAL_MILLIS
                || retainable_terminal_count > RETAIN_TERMINAL_JOBS);
        if state.state.is_terminal()
            && let Some(lock) = record.try_lock()?
        {
            remove_stale_worker_socket(&record)?;
            if expired {
                let trash = store.move_to_trash(&record)?;
                drop(lock);
                std::fs::remove_dir_all(trash).map_err(state_io_error)?;
                continue;
            }
        }
        retained.push(record);
    }
    *records = retained;
    Ok(())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&left, &right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn file_length(path: &Path) -> Result<u64, ProtocolError> {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(state_io_error)
}

fn remove_stale_worker_socket(record: &JobRecord) -> Result<(), ProtocolError> {
    let path = record.worker_socket_path();
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_socket() => {
            std::fs::remove_file(path).map_err(state_io_error)
        }
        Ok(_) => Err(ProtocolError::new(
            "JOB_STATE_CORRUPT",
            "Worker control endpoint is not a Unix Socket.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(state_io_error(error)),
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, ProtocolError> {
    serde_json::to_value(value).map_err(internal_json_error)
}

fn internal_json_error(error: serde_json::Error) -> ProtocolError {
    ProtocolError::new(
        "INTERNAL_ERROR",
        format!("Could not encode executor data: {error}"),
    )
}

fn worker_connect_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "WORKER_UNAVAILABLE",
        format!("Could not communicate with the job Worker: {error}"),
    )
}

fn worker_spawn_io_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "WORKER_START_FAILED",
        format!("Could not start the job Worker: {error}"),
    )
}

fn output_io_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "OUTPUT_READ_FAILED",
        format!("Could not read captured output: {error}"),
    )
}

fn state_io_error(error: io::Error) -> ProtocolError {
    ProtocolError::new(
        "JOB_STATE_IO_FAILED",
        format!("Could not maintain durable job state: {error}"),
    )
}

fn fault_point(name: &str) {
    if std::env::var("KODA_EXEC_TEST_FAULT_POINT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn retention_deletes_only_expired_verified_terminal_jobs() {
        let root = std::env::temp_dir().join(format!(
            "koda-supervisor-retention-{}",
            Uuid::new_v4().simple()
        ));
        let store = JobStore::open(&root).expect("store");
        let recent = create_record(&store, "recent");
        transition(&recent, JobState::WorkerReady);
        transition(&recent, JobState::CommandStarting);
        transition(&recent, JobState::Running);
        transition(&recent, JobState::Exited);

        let expired = create_record(&store, "expired");
        transition(&expired, JobState::WorkerReady);
        transition(&expired, JobState::CommandStarting);
        transition(&expired, JobState::Running);
        transition(&expired, JobState::Exited);
        expired
            .rewrite_updated_at_for_test(0)
            .expect("age expired state");

        let uncertain = create_record(&store, "uncertain");
        transition(&uncertain, JobState::WorkerReady);
        transition(&uncertain, JobState::CommandStarting);
        transition(&uncertain, JobState::TerminationUncertain);
        uncertain
            .rewrite_updated_at_for_test(0)
            .expect("age uncertain state");

        let mut records = store.scan(10).expect("scan");
        apply_retention(&store, &mut records).expect("retention");

        assert_eq!(records.len(), 2);
        assert!(
            records
                .iter()
                .any(|record| record.manifest.request_id == "recent")
        );
        assert!(
            records
                .iter()
                .any(|record| record.manifest.request_id == "uncertain")
        );
        assert!(!expired.directory.exists());
        assert_eq!(
            std::fs::read_dir(&store.trash_root).expect("trash").count(),
            0
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    fn create_record(store: &JobStore, request_id: &str) -> JobRecord {
        store
            .create_job(
                request_id,
                StartParams {
                    argv: vec!["/usr/bin/true".to_owned()],
                    cwd: std::env::current_dir().expect("cwd").display().to_string(),
                    environment: BTreeMap::new(),
                    timeout_ms: 1_000,
                    output_limit_bytes: 1_024,
                    termination_grace_ms: 25,
                    termination_confirmation_ms: 1_000,
                },
            )
            .expect("job")
            .0
    }

    fn transition(record: &JobRecord, state: JobState) {
        let current = record.read_state().expect("current");
        let mut next = current.clone();
        next.state = state;
        record.transition(&current, next).expect("transition");
    }
}
