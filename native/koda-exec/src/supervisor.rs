use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::attachment::{create_stateless_attachment, verify_capability};
use crate::durable::{JobRecord, JobStore};
use crate::execution_policy::ExecutionCapabilities;
use crate::execution_security;
use crate::framing::{read_json_frame, write_json_frame};
use crate::internal_protocol::{
    WORKER_PROTOCOL_VERSION, WorkerHelloParams, WorkerHelloResult, WorkerRequest, WorkerResponse,
    WorkerTerminateParams, decode_base64, encode_base64, new_nonce, worker_proof,
};
use crate::platform::bootstrap::spawn_worker_process;
use crate::platform::identity::process_identity_matches;
use crate::platform::{
    LocalStream, connect_local_endpoint, remove_local_endpoint, verify_local_peer,
};
use crate::protocol::{
    AttachmentAcquireInputParams, AttachmentCredentials, AttachmentDetachParams,
    AttachmentDetachResult, AttachmentOpenParams, AttachmentReadParams, AttachmentReadResult,
    AttachmentRenewParams, InputLeaseResult, InputWriteParams, InputWriteResult, IoMode,
    JobFailure, JobSnapshot, JobState, JobSummary, ListJobsParams, ListJobsResult,
    MAX_PTY_INPUT_BYTES, OutputReadResult, OutputStream, ProtocolError, ReadOutputParams,
    StartParams, TerminalResizeParams, TerminalResizeResult, TerminateParams, TerminationAttempt,
    TerminationReason, TerminationSnapshot, validate_attachment_credentials,
    validate_attachment_read, validate_identifier, validate_lease, validate_output_read,
    validate_start, validate_terminal_size,
};
use crate::pty_output::PtyOutputStore;

const MAX_SCANNED_JOBS: usize = 10_000;
const MAX_LIST_JOBS: u32 = 100;
const DEFAULT_LIST_JOBS: u32 = 50;
const RETAIN_TERMINAL_JOBS: usize = 1_000;
const RETAIN_TERMINAL_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;
const START_WAIT_ATTEMPTS: usize = 100;

pub struct Supervisor {
    store: JobStore,
    binary_path: PathBuf,
    execution_capabilities: ExecutionCapabilities,
    protected_linux_execution_enabled: bool,
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
    pub async fn open(
        state_dir: &Path,
        binary_path: PathBuf,
        execution_capabilities: ExecutionCapabilities,
        protected_linux_execution_enabled: bool,
    ) -> Result<Arc<Self>, ProtocolError> {
        let store = JobStore::open(state_dir)?;
        let mut records = store.scan(MAX_SCANNED_JOBS)?;
        // A v1 Worker launches autonomously: never pretend a new Supervisor can
        // fence an in-flight old launch. Require it to settle under the old owner.
        for record in &records {
            let state = record.read_state()?;
            if record.manifest.format_version == 1
                && is_precommand(state.state)
                && record.try_lock()?.is_none()
            {
                return Err(ProtocolError::new(
                    "INCOMPATIBLE_PROTOCOL",
                    "A legacy Worker is still starting. Finish or cancel it with the old executor before upgrading.",
                ));
            }
        }
        store.finish_trash_cleanup()?;
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
            execution_capabilities,
            protected_linux_execution_enabled,
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
                let params = crate::protocol::parse_start_params(params)?;
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
            "attach/open" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.open_attachment(params).await?)
            }
            "attach/read" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.read_attachment(params).await?)
            }
            "attach/acquire-input" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.acquire_input(params).await?)
            }
            "attach/renew" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.renew_input(params).await?)
            }
            "attach/detach" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.detach_attachment(params).await?)
            }
            "input/write" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.write_input(params).await?)
            }
            "terminal/resize" => {
                let params = crate::protocol::parse_params(params)?;
                encode(self.resize_terminal(params).await?)
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
        if self.execution_capabilities.schema_version == 3
            && !self.protected_linux_execution_enabled
            && params
                .policy
                .as_ref()
                .is_some_and(crate::linux_bubblewrap::requires_bubblewrap)
        {
            return Err(ProtocolError::new(
                "EXECUTION_POLICY_UNAVAILABLE",
                "Protected Linux user execution remains disabled until Phase 4C2B3 enforcement is active.",
            ));
        }
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

        let (record, _) = self.store.create_job_with_capabilities(
            &request_id,
            params,
            &self.execution_capabilities,
        )?;
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
            return Ok(state.snapshot(&record.manifest.start));
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
            return Ok(current.snapshot(&record.manifest.start));
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
        let mut snapshot = record.read_state()?.snapshot(&record.manifest.start);
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
                    display_name: record.manifest.start.display_name,
                    cwd: record.manifest.start.cwd,
                    state: state.state,
                    io_mode: record.manifest.start.io_mode,
                    lifecycle: record.manifest.start.lifecycle,
                    created_at_ms: record.manifest.created_at_ms,
                    updated_at_ms: state.updated_at_ms,
                    pid: state.command_pid,
                    security: state
                        .security
                        .clone()
                        .unwrap_or_else(execution_security::legacy_unknown),
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

    pub async fn open_attachment(
        self: &Arc<Self>,
        params: AttachmentOpenParams,
    ) -> Result<AttachmentCredentials, ProtocolError> {
        validate_identifier(&params.job_id, "job_id")?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        if record.read_state()?.state.is_terminal() {
            return create_stateless_attachment(&record.read_token()?, &params.job_id);
        }
        match self
            .call_live_worker::<AttachmentCredentials>(&record, "worker/attach/open", json!({}))
            .await
        {
            Ok(result) => Ok(result),
            Err(error) if error.code == "JOB_TERMINAL" => {
                create_stateless_attachment(&record.read_token()?, &params.job_id)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn read_attachment(
        self: &Arc<Self>,
        params: AttachmentReadParams,
    ) -> Result<AttachmentReadResult, ProtocolError> {
        validate_attachment_read(&params)?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        if record.read_state()?.state.is_terminal() {
            return read_terminal_attachment(&record, &params);
        }
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        match self
            .call_live_worker::<AttachmentReadResult>(&record, "worker/attach/read", value)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) if error.code == "JOB_TERMINAL" => {
                read_terminal_attachment(&record, &params)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn acquire_input(
        self: &Arc<Self>,
        params: AttachmentAcquireInputParams,
    ) -> Result<InputLeaseResult, ProtocolError> {
        validate_attachment_credentials(
            &params.job_id,
            &params.attachment_id,
            &params.capability_token,
        )?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        self.call_live_worker(&record, "worker/attach/acquire-input", value)
            .await
    }

    pub async fn renew_input(
        self: &Arc<Self>,
        params: AttachmentRenewParams,
    ) -> Result<InputLeaseResult, ProtocolError> {
        validate_attachment_credentials(
            &params.job_id,
            &params.attachment_id,
            &params.capability_token,
        )?;
        validate_lease(&params.lease_token, params.fence)?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        self.call_live_worker(&record, "worker/attach/renew", value)
            .await
    }

    pub async fn write_input(
        self: &Arc<Self>,
        params: InputWriteParams,
    ) -> Result<InputWriteResult, ProtocolError> {
        validate_attachment_credentials(
            &params.job_id,
            &params.attachment_id,
            &params.capability_token,
        )?;
        validate_lease(&params.lease_token, params.fence)?;
        let bytes = decode_base64(&params.data_base64)
            .map_err(|error| ProtocolError::new("INVALID_REQUEST", error))?;
        if bytes.is_empty() || bytes.len() > MAX_PTY_INPUT_BYTES {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                format!("PTY input must contain 1-{MAX_PTY_INPUT_BYTES} bytes."),
            ));
        }
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        self.call_live_worker(&record, "worker/input/write", value)
            .await
    }

    pub async fn resize_terminal(
        self: &Arc<Self>,
        params: TerminalResizeParams,
    ) -> Result<TerminalResizeResult, ProtocolError> {
        validate_attachment_credentials(
            &params.job_id,
            &params.attachment_id,
            &params.capability_token,
        )?;
        validate_lease(&params.lease_token, params.fence)?;
        validate_terminal_size(params.rows, params.cols)?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        self.call_live_worker(&record, "worker/terminal/resize", value)
            .await
    }

    pub async fn detach_attachment(
        self: &Arc<Self>,
        params: AttachmentDetachParams,
    ) -> Result<AttachmentDetachResult, ProtocolError> {
        validate_attachment_credentials(
            &params.job_id,
            &params.attachment_id,
            &params.capability_token,
        )?;
        let record = self.find_job(&params.job_id).await?;
        ensure_pty_job(&record)?;
        if record.read_state()?.state.is_terminal() {
            ensure_terminal_capability(&record, &params)?;
            return Ok(AttachmentDetachResult {
                job_id: params.job_id,
                detached: true,
            });
        }
        let value = serde_json::to_value(&params).map_err(internal_json_error)?;
        match self
            .call_live_worker(&record, "worker/attach/detach", value)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) if error.code == "JOB_TERMINAL" => {
                ensure_terminal_capability(&record, &params)?;
                Ok(AttachmentDetachResult {
                    job_id: params.job_id,
                    detached: true,
                })
            }
            Err(error) => Err(error),
        }
    }

    async fn call_live_worker<T>(
        self: &Arc<Self>,
        record: &JobRecord,
        method: &str,
        params: Value,
    ) -> Result<T, ProtocolError>
    where
        T: DeserializeOwned,
    {
        if record.read_state()?.state.is_terminal() {
            return Err(ProtocolError::new(
                "JOB_TERMINAL",
                "The PTY job is already terminal.",
            ));
        }
        match worker_value(record, method, params.clone()).await {
            Ok(value) => decode_worker_value(value),
            Err(error) if error.code == "WORKER_UNAVAILABLE" => {
                let snapshot = self.reconcile(record).await?;
                if snapshot.state.is_terminal() {
                    return Err(ProtocolError::new(
                        "JOB_TERMINAL",
                        "The PTY job became terminal while routing the request.",
                    ));
                }
                decode_worker_value(worker_value(record, method, params).await?)
            }
            Err(error) => Err(error),
        }
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
        if record.manifest.format_version == 1 {
            return Err(ProtocolError::new(
                "INVALID_EXECUTION_POLICY",
                "Legacy jobs cannot start a new Worker; submit a fresh approved request.",
            ));
        }
        let token_path = record.directory.join("control.token");
        spawn_worker_process(&self.binary_path, &record.directory, &token_path)
            .map_err(worker_spawn_io_error)
    }

    async fn wait_for_start(&self, record: &JobRecord) -> Result<JobSnapshot, ProtocolError> {
        for _ in 0..START_WAIT_ATTEMPTS {
            if let Ok(snapshot) = worker_snapshot(record, "worker/status", json!({})).await
                && !matches!(snapshot.state, JobState::Accepted | JobState::WorkerReady)
            {
                return Ok(snapshot);
            }
            let snapshot = record.read_state()?.snapshot(&record.manifest.start);
            if snapshot.state.is_terminal()
                || !matches!(snapshot.state, JobState::Accepted | JobState::WorkerReady)
            {
                return Ok(snapshot);
            }
            sleep(Duration::from_millis(20)).await;
        }
        Ok(record.read_state()?.snapshot(&record.manifest.start))
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
            return Ok(current.snapshot(&record.manifest.start));
        }
        let Some(lock) = record.try_lock()? else {
            return Ok(current.snapshot(&record.manifest.start));
        };
        let current = record.read_state()?;
        if current.state.is_terminal() {
            return Ok(current.snapshot(&record.manifest.start));
        }
        remove_stale_worker_socket(record)?;
        if matches!(current.state, JobState::Accepted | JobState::WorkerReady) {
            if record.manifest.format_version == 1 {
                let mut next = current.clone();
                next.state = JobState::StartFailed;
                next.failure = Some(JobFailure {
                    code: "INVALID_EXECUTION_POLICY".into(),
                    message:
                        "Legacy pending execution was stopped; submit a fresh approved request."
                            .into(),
                });
                return Ok(record
                    .transition(&current, next)?
                    .snapshot(&record.manifest.start));
            }
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
                    identity,
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
            message: "The Worker disappeared after command start; the owned command tree was reconciled without claiming a verified exit status.".to_owned(),
        });
        let state = record.transition(&current, next)?;
        drop(lock);
        Ok(state.snapshot(&record.manifest.start))
    }
}

struct WorkerConnection {
    stream: LocalStream,
}

impl WorkerConnection {
    async fn connect(record: &JobRecord) -> Result<Self, ProtocolError> {
        let endpoint = record.worker_socket_path()?;
        let mut stream = connect_local_endpoint(&endpoint)
            .await
            .map_err(worker_connect_error)?;
        verify_local_peer(&stream).map_err(|error| {
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
        {
            return Err(ProtocolError::new(
                "WORKER_AUTHENTICATION_FAILED",
                "Worker process identity does not match durable state.",
            ));
        }
        if !process_identity_matches(hello.worker_pid, &hello.worker_start_identity) {
            // A short-lived Worker can publish a terminal state and exit after
            // answering hello but before this liveness check. Its durable
            // identity still matched exactly, so route the caller through the
            // ordinary unavailable/reconcile path instead of misclassifying the
            // exit race as an authentication failure.
            return Err(ProtocolError::new(
                "WORKER_UNAVAILABLE",
                "Worker exited while its authenticated connection was being established.",
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
    let mut result = connection.call(method, params).await?;
    if record.manifest.format_version == 1 {
        let object = result
            .as_object_mut()
            .ok_or_else(execution_security::corrupt)?;
        if object.contains_key("security") {
            return Err(execution_security::corrupt());
        }
        object.insert(
            "security".into(),
            serde_json::to_value(execution_security::legacy_unknown())
                .map_err(internal_json_error)?,
        );
    }
    let snapshot: JobSnapshot = serde_json::from_value(result)
        .map_err(|_| ProtocolError::new("WORKER_PROTOCOL_ERROR", "Worker snapshot is invalid."))?;
    if record.manifest.format_version >= 2 {
        execution_security::validate_retained(&record.manifest.start, &snapshot.security)?;
        if record.read_state()?.security.as_ref() != Some(&snapshot.security)
            && record.manifest.security.as_ref() != Some(&snapshot.security)
        {
            return Err(execution_security::corrupt());
        }
    }
    Ok(snapshot)
}

fn is_precommand(state: JobState) -> bool {
    matches!(
        state,
        JobState::Accepted | JobState::WorkerReady | JobState::CommandStarting | JobState::Starting
    )
}

async fn worker_value(
    record: &JobRecord,
    method: &str,
    params: Value,
) -> Result<Value, ProtocolError> {
    let mut connection = WorkerConnection::connect(record).await?;
    connection.call(method, params).await
}

fn decode_worker_value<T>(value: Value) -> Result<T, ProtocolError>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|error| {
        ProtocolError::new(
            "WORKER_PROTOCOL_ERROR",
            format!("Worker result is invalid: {error}"),
        )
    })
}

fn ensure_pty_job(record: &JobRecord) -> Result<(), ProtocolError> {
    if record.manifest.start.io_mode != IoMode::Pty {
        return Err(ProtocolError::new(
            "PTY_NOT_SUPPORTED_FOR_JOB",
            "This job was not started in PTY mode.",
        ));
    }
    Ok(())
}

fn ensure_terminal_capability(
    record: &JobRecord,
    params: &AttachmentCredentials,
) -> Result<(), ProtocolError> {
    if verify_capability(
        &record.read_token()?,
        &params.job_id,
        &params.attachment_id,
        &params.capability_token,
    ) {
        Ok(())
    } else {
        Err(ProtocolError::new(
            "ATTACHMENT_NOT_FOUND",
            "The PTY attachment does not exist or its capability is invalid.",
        ))
    }
}

fn read_terminal_attachment(
    record: &JobRecord,
    params: &AttachmentReadParams,
) -> Result<AttachmentReadResult, ProtocolError> {
    if !verify_capability(
        &record.read_token()?,
        &params.job_id,
        &params.attachment_id,
        &params.capability_token,
    ) {
        return Err(ProtocolError::new(
            "ATTACHMENT_NOT_FOUND",
            "The PTY attachment does not exist or its capability is invalid.",
        ));
    }
    let limit = record
        .manifest
        .start
        .pty
        .as_ref()
        .ok_or_else(|| ProtocolError::new("JOB_STATE_CORRUPT", "PTY config is absent."))?
        .output_limit_bytes;
    PtyOutputStore::open(&record.pty_output_path(), limit)?.read(
        &params.job_id,
        params.cursor,
        params.max_bytes,
        true,
    )
}

async fn read_worker_response(
    stream: &mut LocalStream,
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
        let Some(error) = response.error else {
            return Err(ProtocolError::new(
                "WORKER_PROTOCOL_ERROR",
                "Worker request failed without an error body.",
            ));
        };
        return Err(ProtocolError::new(
            worker_error_code(&error.code),
            error.message,
        ));
    }
    Ok(response)
}

fn worker_error_code(code: &str) -> &'static str {
    match code {
        "INVALID_REQUEST" => "INVALID_REQUEST",
        "ATTACHMENT_NOT_FOUND" => "ATTACHMENT_NOT_FOUND",
        "ATTACHMENT_LIMIT_EXCEEDED" => "ATTACHMENT_LIMIT_EXCEEDED",
        "INPUT_LEASE_HELD" => "INPUT_LEASE_HELD",
        "INPUT_LEASE_EXPIRED" => "INPUT_LEASE_EXPIRED",
        "STALE_INPUT_FENCE" => "STALE_INPUT_FENCE",
        "PTY_INPUT_BACKPRESSURE" => "PTY_INPUT_BACKPRESSURE",
        "PTY_NOT_SUPPORTED_FOR_JOB" => "PTY_NOT_SUPPORTED_FOR_JOB",
        "JOB_TERMINAL" => "JOB_TERMINAL",
        "CURSOR_INVALID" => "CURSOR_INVALID",
        "PTY_OUTPUT_FAILED" => "PTY_OUTPUT_FAILED",
        "PTY_OUTPUT_CORRUPT" => "PTY_OUTPUT_CORRUPT",
        "WORKER_TERMINATION_FAILED" => "WORKER_TERMINATION_FAILED",
        "WORKER_OUTPUT_SYNC_FAILED" => "WORKER_OUTPUT_SYNC_FAILED",
        _ => "WORKER_REQUEST_FAILED",
    }
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
                // Windows cannot rename a directory while its child lock file is
                // open, even when that handle permits delete sharing. Endpoint
                // ownership already serializes Supervisors and the verified
                // terminal state is immutable, so release the recovery lock at
                // this final retention boundary before the same-volume move.
                #[cfg(windows)]
                drop(lock);
                let trash = store.move_to_trash(&record)?;
                #[cfg(unix)]
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
    remove_local_endpoint(&record.worker_socket_path()?).map_err(state_io_error)
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
                    display_name: None,
                    environment: BTreeMap::new(),
                    timeout_ms: 1_000,
                    output_limit_bytes: 1_024,
                    termination_grace_ms: 25,
                    termination_confirmation_ms: 1_000,
                    io_mode: crate::protocol::IoMode::Pipe,
                    lifecycle: crate::protocol::JobLifecycle::Foreground,
                    pty: None,
                    policy: Some(
                        crate::execution_policy::resolve_execution_policy(
                            &std::env::current_dir().unwrap().display().to_string(),
                            None,
                            None,
                        )
                        .unwrap(),
                    ),
                },
            )
            .expect("job")
            .0
    }

    fn transition(record: &JobRecord, state: JobState) {
        let current = record.read_state().expect("current");
        let mut next = current.clone();
        next.state = state;
        if state == JobState::Running {
            next.command_pid = Some(1);
            next.command_start_identity = Some("test-identity".into());
            next.security = Some(
                execution_security::launch_setup(
                    &record.manifest.start,
                    current.security.as_ref().unwrap(),
                )
                .unwrap(),
            );
        }
        record.transition(&current, next).expect("transition");
    }
}
