use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::execution_policy::{ExecutionSecuritySnapshot, ExecutionSecurityStage};
use crate::execution_security;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::platform::{self, state_security};
use crate::protocol::{
    IoMode, JobFailure, JobSnapshot, JobState, ProtocolError, StartParams, TerminationSnapshot,
};

pub const STORE_FORMAT_VERSION: u32 = 3;
const MAX_MANIFEST_BYTES: u64 = 262_144;
const MAX_STATE_BYTES: u64 = 65_536;
const MAX_STATE_HEAD_BYTES: u64 = 4_096;
const TOKEN_BYTES: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JobManifest {
    pub format_version: u32,
    pub job_id: String,
    pub request_id: String,
    pub request_digest: String,
    pub token_sha256: String,
    pub created_at_ms: u64,
    pub start: StartParams,
    pub manifest_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<ExecutionSecuritySnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StoredJobState {
    pub format_version: u32,
    pub job_id: String,
    pub revision: u64,
    pub state: JobState,
    pub previous_state_digest: Option<String>,
    pub state_digest: String,
    pub updated_at_ms: u64,
    pub worker_pid: Option<u32>,
    pub worker_start_identity: Option<String>,
    pub command_pid: Option<u32>,
    pub command_start_identity: Option<String>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_retained_bytes: u64,
    pub stderr_retained_bytes: u64,
    pub termination: Option<TerminationSnapshot>,
    pub failure: Option<JobFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<ExecutionSecuritySnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StateHead {
    format_version: u32,
    job_id: String,
    revision: u64,
    state_digest: String,
}

#[derive(Clone, Debug)]
pub struct JobRecord {
    pub directory: PathBuf,
    pub manifest: JobManifest,
}

pub struct JobStore {
    pub jobs_root: PathBuf,
    pub quarantine_root: PathBuf,
    pub trash_root: PathBuf,
}

pub struct JobLock {
    _file: File,
}

impl JobStore {
    pub fn open(root: &Path) -> Result<Self, ProtocolError> {
        create_private_directory(root)?;
        create_private_directory(&state_security::worker_control_root())?;
        let jobs_root = root.join("jobs");
        let quarantine_root = root.join("quarantine");
        let trash_root = root.join("trash");
        create_private_directory(&jobs_root)?;
        create_private_directory(&quarantine_root)?;
        create_private_directory(&trash_root)?;
        Ok(Self {
            jobs_root,
            quarantine_root,
            trash_root,
        })
    }

    pub fn create_job(
        &self,
        request_id: &str,
        start: StartParams,
    ) -> Result<(JobRecord, Vec<u8>), ProtocolError> {
        crate::protocol::validate_start(&start)?;
        let security = execution_security::admit(&start)?;
        let directory_name = sha256_hex(request_id.as_bytes());
        let directory = self.jobs_root.join(directory_name);
        std::fs::create_dir(&directory).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::AlreadyExists {
                "JOB_QUARANTINED"
            } else {
                "STATE_DIRECTORY_UNAVAILABLE"
            };
            ProtocolError::new(
                code,
                format!(
                    "Could not reserve durable job directory '{}': {error}",
                    directory.display()
                ),
            )
        })?;
        state_security::secure_private_directory(&directory).map_err(state_io_error)?;
        sync_directory(&self.jobs_root);

        let token = random_token();
        write_new_private_file(&directory.join("control.token"), &token)?;
        create_new_private_file(&directory.join("worker.lock"))?;
        create_new_private_file(&directory.join("stdout.bin"))?;
        create_new_private_file(&directory.join("stderr.bin"))?;
        if start.io_mode == IoMode::Pty {
            create_private_directory(&directory.join("pty-output"))?;
        }

        let request_bytes = serde_json::to_vec(&start).map_err(json_encode_error)?;
        let mut manifest = JobManifest {
            format_version: STORE_FORMAT_VERSION,
            job_id: Uuid::new_v4().simple().to_string(),
            request_id: request_id.to_owned(),
            request_digest: sha256_hex(&request_bytes),
            token_sha256: sha256_hex(&token),
            created_at_ms: unix_millis(),
            start,
            manifest_digest: String::new(),
            security: Some(security.clone()),
        };
        manifest.manifest_digest = manifest_digest(&manifest)?;
        write_new_json(
            &directory.join("manifest.json"),
            &manifest,
            MAX_MANIFEST_BYTES,
        )?;

        let mut initial = StoredJobState::initial(&manifest.job_id);
        initial.security = Some(security);
        initial.state_digest = state_digest(&initial)?;
        write_new_json(&directory.join("state.json"), &initial, MAX_STATE_BYTES)?;
        write_new_json(
            &directory.join("state.head"),
            &StateHead::from_state(&initial),
            MAX_STATE_HEAD_BYTES,
        )?;
        sync_directory(&directory);
        Ok((
            JobRecord {
                directory,
                manifest,
            },
            token,
        ))
    }

    pub fn scan(&self, maximum_jobs: usize) -> Result<Vec<JobRecord>, ProtocolError> {
        let mut records = Vec::new();
        let entries = std::fs::read_dir(&self.jobs_root)
            .map_err(state_io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(state_io_error)?;
        // Preflight the whole store before quarantine/retention changes anything.
        // Unknown future formats are not corruption to relocate or reinterpret.
        for entry in &entries {
            let kind = entry.file_type().map_err(state_io_error)?;
            if kind.is_dir() && !kind.is_symlink() {
                for (name, limit) in [
                    ("manifest.json", MAX_MANIFEST_BYTES),
                    ("state.json", MAX_STATE_BYTES),
                    ("state.head", MAX_STATE_HEAD_BYTES),
                ] {
                    if let Err(error) = read_versioned_value(&entry.path().join(name), limit)
                        && error.code == "INCOMPATIBLE_STATE_VERSION"
                    {
                        return Err(error);
                    }
                }
            }
        }
        for (index, entry) in entries.into_iter().enumerate() {
            if index >= maximum_jobs {
                return Err(ProtocolError::new(
                    "JOB_STORE_LIMIT_EXCEEDED",
                    format!("Executor job store exceeds its {maximum_jobs}-entry scan limit."),
                ));
            }
            let file_type = entry.file_type().map_err(state_io_error)?;
            if !file_type.is_dir() || file_type.is_symlink() {
                self.quarantine_entry(&entry.path(), "Job-store entry is not a real directory.")?;
                continue;
            }
            match self.load_job(&entry.path()) {
                Ok(record) => records.push(record),
                Err(error) if error.code == "INCOMPATIBLE_STATE_VERSION" => return Err(error),
                Err(error) => self.quarantine_entry(
                    &entry.path(),
                    &format!("{}: {}", error.code, error.message),
                )?,
            }
        }
        Ok(records)
    }

    pub fn load_job(&self, directory: &Path) -> Result<JobRecord, ProtocolError> {
        validate_private_directory(directory)?;
        let (version, value) =
            read_versioned_value(&directory.join("manifest.json"), MAX_MANIFEST_BYTES)?;
        validate_security_fields(&value, version, true)?;
        let manifest: JobManifest =
            serde_json::from_value(value).map_err(|_| record_decode_error(version))?;
        validate_manifest(&manifest)?;
        let expected_directory = sha256_hex(manifest.request_id.as_bytes());
        if directory.file_name().and_then(|value| value.to_str()) != Some(&expected_directory) {
            return Err(corrupt(
                "Job directory does not match its request identity.",
            ));
        }
        validate_private_file(&directory.join("control.token"), Some(TOKEN_BYTES as u64))?;
        validate_private_file(&directory.join("worker.lock"), None)?;
        validate_private_file(&directory.join("stdout.bin"), None)?;
        validate_private_file(&directory.join("stderr.bin"), None)?;
        if manifest.start.io_mode == IoMode::Pty {
            crate::pty_output::validate_directory(&directory.join("pty-output"))?;
        }
        validate_private_file(&directory.join("state.head"), None)?;
        let record = JobRecord {
            directory: directory.to_owned(),
            manifest,
        };
        let _ = record.read_state()?;
        let _ = record.read_token()?;
        Ok(record)
    }

    pub fn finish_trash_cleanup(&self) -> Result<(), ProtocolError> {
        for entry in std::fs::read_dir(&self.trash_root).map_err(state_io_error)? {
            let entry = entry.map_err(state_io_error)?;
            let file_type = entry.file_type().map_err(state_io_error)?;
            if file_type.is_dir() && !file_type.is_symlink() {
                std::fs::remove_dir_all(entry.path()).map_err(state_io_error)?;
            }
        }
        sync_directory(&self.trash_root);
        Ok(())
    }

    pub fn move_to_trash(&self, record: &JobRecord) -> Result<PathBuf, ProtocolError> {
        let target = self.trash_root.join(format!(
            "{}-{}",
            record.manifest.job_id,
            Uuid::new_v4().simple()
        ));
        std::fs::rename(&record.directory, &target).map_err(state_io_error)?;
        sync_directory(&self.jobs_root);
        sync_directory(&self.trash_root);
        Ok(target)
    }

    fn quarantine_entry(&self, source: &Path, reason: &str) -> Result<(), ProtocolError> {
        let identity = Uuid::new_v4().simple().to_string();
        let target = self.quarantine_root.join(format!("{identity}.entry"));
        std::fs::rename(source, &target).map_err(state_io_error)?;
        sync_directory(&self.jobs_root);
        sync_directory(&self.quarantine_root);
        let receipt = QuarantineReceipt {
            format_version: STORE_FORMAT_VERSION,
            quarantined_at_ms: unix_millis(),
            reason: reason.chars().take(8_192).collect(),
        };
        write_new_json(
            &self.quarantine_root.join(format!("{identity}.json")),
            &receipt,
            MAX_STATE_BYTES,
        )
    }
}

#[derive(Serialize)]
struct QuarantineReceipt {
    format_version: u32,
    quarantined_at_ms: u64,
    reason: String,
}

impl JobRecord {
    pub fn state_path(&self) -> PathBuf {
        self.directory.join("state.json")
    }

    fn state_head_path(&self) -> PathBuf {
        self.directory.join("state.head")
    }

    pub fn worker_socket_path(&self) -> Result<PathBuf, ProtocolError> {
        platform::worker_local_endpoint(&self.directory, &self.manifest.job_id)
            .map_err(state_io_error)
    }

    pub fn stdout_path(&self) -> PathBuf {
        self.directory.join("stdout.bin")
    }

    pub fn stderr_path(&self) -> PathBuf {
        self.directory.join("stderr.bin")
    }

    pub fn pty_output_path(&self) -> PathBuf {
        self.directory.join("pty-output")
    }

    pub fn lock_path(&self) -> PathBuf {
        self.directory.join("worker.lock")
    }

    pub fn read_state(&self) -> Result<StoredJobState, ProtocolError> {
        let (version, value) = read_versioned_value(&self.state_path(), MAX_STATE_BYTES)?;
        if version != self.manifest.format_version {
            return Err(execution_security::corrupt());
        }
        validate_security_fields(&value, version, false)?;
        let state: StoredJobState =
            serde_json::from_value(value).map_err(|_| record_decode_error(version))?;
        validate_state(&state, &self.manifest.job_id)?;
        validate_security_binding(&self.manifest, &state)?;
        let (head_version, value) =
            read_versioned_value(&self.state_head_path(), MAX_STATE_HEAD_BYTES)?;
        if head_version != version {
            return Err(execution_security::corrupt());
        }
        let head: StateHead =
            serde_json::from_value(value).map_err(|_| record_decode_error(version))?;
        validate_state_head(&head, &self.manifest.job_id)?;
        if head.revision == state.revision && head.state_digest == state.state_digest {
            return Ok(state);
        }
        if state.revision == head.revision.saturating_add(1)
            && state.previous_state_digest.as_deref() == Some(&head.state_digest)
        {
            if version == STORE_FORMAT_VERSION {
                write_atomic_json(
                    &self.state_head_path(),
                    &StateHead::from_state(&state),
                    MAX_STATE_HEAD_BYTES,
                )?;
            }
            return Ok(state);
        }
        Err(corrupt(
            "Job state head does not match the current or one-step committed revision.",
        ))
    }

    pub fn transition(
        &self,
        current: &StoredJobState,
        mut next: StoredJobState,
    ) -> Result<StoredJobState, ProtocolError> {
        let durable_current = self.read_state()?;
        if durable_current.revision != current.revision
            || durable_current.state_digest != current.state_digest
        {
            return Err(corrupt(
                "Job state changed before the requested transition was committed.",
            ));
        }
        validate_transition(current.state, next.state)?;
        next.format_version = current.format_version;
        validate_security_binding(&self.manifest, &next)?;
        if let Some(ExecutionSecuritySnapshot::Policy(security)) = &current.security
            && security.stage == ExecutionSecurityStage::LaunchSetup
            && current.security != next.security
        {
            return Err(execution_security::corrupt());
        }
        next.job_id = self.manifest.job_id.clone();
        next.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| corrupt("Job state revision overflowed."))?;
        next.previous_state_digest = Some(current.state_digest.clone());
        next.updated_at_ms = unix_millis();
        next.state_digest.clear();
        next.state_digest = state_digest(&next)?;
        write_atomic_json(&self.state_path(), &next, MAX_STATE_BYTES)?;
        write_atomic_json(
            &self.state_head_path(),
            &StateHead::from_state(&next),
            MAX_STATE_HEAD_BYTES,
        )?;
        Ok(next)
    }

    pub fn read_token(&self) -> Result<Vec<u8>, ProtocolError> {
        validate_private_file(
            &self.directory.join("control.token"),
            Some(TOKEN_BYTES as u64),
        )?;
        let token = std::fs::read(self.directory.join("control.token")).map_err(state_io_error)?;
        if sha256_hex(&token) != self.manifest.token_sha256 {
            return Err(corrupt(
                "Job control token does not match its manifest digest.",
            ));
        }
        Ok(token)
    }

    pub fn try_lock(&self) -> Result<Option<JobLock>, ProtocolError> {
        JobLock::try_acquire(&self.lock_path())
    }

    #[cfg(test)]
    pub fn rewrite_updated_at_for_test(&self, updated_at_ms: u64) -> Result<(), ProtocolError> {
        let mut state = self.read_state()?;
        state.updated_at_ms = updated_at_ms;
        state.state_digest.clear();
        state.state_digest = state_digest(&state)?;
        write_atomic_json(&self.state_path(), &state, MAX_STATE_BYTES)?;
        write_atomic_json(
            &self.state_head_path(),
            &StateHead::from_state(&state),
            MAX_STATE_HEAD_BYTES,
        )
    }
}

impl StoredJobState {
    pub fn initial(job_id: &str) -> Self {
        Self {
            format_version: STORE_FORMAT_VERSION,
            job_id: job_id.to_owned(),
            revision: 1,
            state: JobState::Accepted,
            previous_state_digest: None,
            state_digest: String::new(),
            updated_at_ms: unix_millis(),
            worker_pid: None,
            worker_start_identity: None,
            command_pid: None,
            command_start_identity: None,
            exit_code: None,
            signal: None,
            timed_out: false,
            duration_ms: 0,
            stdout_bytes: 0,
            stderr_bytes: 0,
            stdout_retained_bytes: 0,
            stderr_retained_bytes: 0,
            termination: None,
            failure: None,
            security: None,
        }
    }

    pub fn snapshot(&self, start: &StartParams) -> JobSnapshot {
        JobSnapshot {
            job_id: self.job_id.clone(),
            state: self.state,
            io_mode: start.io_mode,
            lifecycle: start.lifecycle,
            pid: self.command_pid,
            exit_code: self.exit_code,
            signal: self.signal.clone(),
            timed_out: self.timed_out,
            duration_ms: self.duration_ms,
            stdout_bytes: self.stdout_bytes,
            stderr_bytes: self.stderr_bytes,
            stdout_retained_bytes: self.stdout_retained_bytes,
            stderr_retained_bytes: self.stderr_retained_bytes,
            stdout_truncated: self.stdout_bytes > self.stdout_retained_bytes,
            stderr_truncated: self.stderr_bytes > self.stderr_retained_bytes,
            termination: self.termination.clone(),
            failure: self.failure.clone(),
            security: self
                .security
                .clone()
                .unwrap_or_else(execution_security::legacy_unknown),
        }
    }
}

impl StateHead {
    fn from_state(state: &StoredJobState) -> Self {
        Self {
            format_version: state.format_version,
            job_id: state.job_id.clone(),
            revision: state.revision,
            state_digest: state.state_digest.clone(),
        }
    }
}

impl JobLock {
    pub fn acquire(path: &Path) -> Result<Self, ProtocolError> {
        match Self::try_acquire(path)? {
            Some(lock) => Ok(lock),
            None => Err(ProtocolError::new(
                "JOB_ALREADY_OWNED",
                "Another Worker already owns this job.",
            )),
        }
    }

    pub fn try_acquire(path: &Path) -> Result<Option<Self>, ProtocolError> {
        validate_private_file(path, None)?;
        state_security::open_exclusive_lock(path)
            .map(|file| file.map(|_file| Self { _file }))
            .map_err(state_io_error)
    }
}

fn read_versioned_value(
    path: &Path,
    limit: u64,
) -> Result<(u32, serde_json::Value), ProtocolError> {
    let value: serde_json::Value = read_private_json(path, limit)?;
    let version = value
        .get("format_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| corrupt("Job record format version is invalid."))?;
    if !(1..=u64::from(STORE_FORMAT_VERSION)).contains(&version) {
        return Err(ProtocolError::new(
            "INCOMPATIBLE_STATE_VERSION",
            "Job store contains an unsupported format; leave it untouched and use a compatible executor.",
        ));
    }
    Ok((version as u32, value))
}

fn record_decode_error(version: u32) -> ProtocolError {
    if version >= 2 {
        execution_security::corrupt()
    } else {
        corrupt("Legacy job record is malformed.")
    }
}

fn validate_security_fields(
    value: &serde_json::Value,
    version: u32,
    manifest: bool,
) -> Result<(), ProtocolError> {
    // Presence is significant: explicit null is not legacy absence.
    let security = value.get("security");
    let policy = value.get("start").and_then(|start| start.get("policy"));
    let valid = if version == 1 {
        security.is_none() && (!manifest || policy.is_none())
    } else {
        security.is_some_and(|v| !v.is_null())
            && (!manifest || policy.is_some_and(|v| !v.is_null()))
    };
    if !valid {
        return Err(execution_security::corrupt());
    }
    Ok(())
}

fn validate_security_binding(
    manifest: &JobManifest,
    state: &StoredJobState,
) -> Result<(), ProtocolError> {
    if manifest.format_version == 1 {
        return if state.security.is_none() {
            Ok(())
        } else {
            Err(execution_security::corrupt())
        };
    }
    let admission = manifest
        .security
        .as_ref()
        .ok_or_else(execution_security::corrupt)?;
    let security = state
        .security
        .as_ref()
        .ok_or_else(execution_security::corrupt)?;
    execution_security::validate_retained(&manifest.start, security)?;
    let (ExecutionSecuritySnapshot::Policy(original), ExecutionSecuritySnapshot::Policy(retained)) =
        (admission, security)
    else {
        return Err(execution_security::corrupt());
    };
    if original.policy != retained.policy
        || original.schema_version != retained.schema_version
        || original.platform != retained.platform
        || original.backend != retained.backend
        || original.policy_digest != retained.policy_digest
        || original.capabilities_digest != retained.capabilities_digest
    {
        return Err(execution_security::corrupt());
    }
    if retained.stage == ExecutionSecurityStage::Admission {
        if security != admission
            || matches!(
                state.state,
                JobState::Running | JobState::Terminating | JobState::Exited
            )
        {
            return Err(execution_security::corrupt());
        }
    } else if state.command_pid.is_none()
        || state.command_start_identity.is_none()
        || matches!(state.state, JobState::Accepted | JobState::WorkerReady)
        || !matches!(
            retained.environment,
            crate::execution_policy::ExecutionEnforcementEvidence::Applied { .. }
        )
        || !matches!(
            retained.supervision,
            crate::execution_policy::ExecutionEnforcementEvidence::Applied { .. }
        )
    {
        return Err(execution_security::corrupt());
    }
    Ok(())
}

fn validate_manifest(manifest: &JobManifest) -> Result<(), ProtocolError> {
    if !matches!(manifest.format_version, 1..=STORE_FORMAT_VERSION) {
        return Err(corrupt("Job manifest format version is unsupported."));
    }
    crate::protocol::validate_identifier(&manifest.job_id, "job_id")?;
    crate::protocol::validate_identifier(&manifest.request_id, "request_id")?;
    crate::protocol::validate_start(&manifest.start)?;
    match manifest.format_version {
        1 if manifest.start.policy.is_none() && manifest.security.is_none() => {}
        2..=STORE_FORMAT_VERSION => {
            let security = manifest
                .security
                .as_ref()
                .ok_or_else(execution_security::corrupt)?;
            execution_security::validate_retained(&manifest.start, security)?;
            let ExecutionSecuritySnapshot::Policy(policy) = security else {
                return Err(execution_security::corrupt());
            };
            if manifest.format_version == 2 && policy.schema_version != 1 {
                return Err(execution_security::corrupt());
            }
            let capabilities = match policy.schema_version {
                1 => crate::execution_policy::c1_execution_capabilities(policy.backend),
                2 => crate::execution_policy::macos_seatbelt_execution_capabilities(),
                _ => return Err(execution_security::corrupt()),
            };
            let expected = crate::execution_policy::create_execution_admission_snapshot(
                &policy.policy,
                &capabilities,
            )
            .map_err(|_| execution_security::corrupt())?;
            if &expected != security {
                return Err(execution_security::corrupt());
            }
        }
        _ => return Err(execution_security::corrupt()),
    }
    let request_bytes = serde_json::to_vec(&manifest.start).map_err(json_encode_error)?;
    if manifest.request_digest != sha256_hex(&request_bytes)
        || manifest.manifest_digest != manifest_digest(manifest)?
        || !is_sha256(&manifest.token_sha256)
    {
        return Err(corrupt("Job manifest digest verification failed."));
    }
    Ok(())
}

fn validate_state(state: &StoredJobState, job_id: &str) -> Result<(), ProtocolError> {
    if !matches!(state.format_version, 1..=STORE_FORMAT_VERSION)
        || state.job_id != job_id
        || state.revision < 1
        || state.state_digest != state_digest(state)?
    {
        return Err(corrupt("Job state identity or digest verification failed."));
    }
    if state.revision == 1 && state.previous_state_digest.is_some() {
        return Err(corrupt("Initial job state has a previous digest."));
    }
    if state.revision > 1
        && !state
            .previous_state_digest
            .as_deref()
            .is_some_and(is_sha256)
    {
        return Err(corrupt("Job state previous digest is missing or invalid."));
    }
    if state.stdout_retained_bytes > state.stdout_bytes
        || state.stderr_retained_bytes > state.stderr_bytes
    {
        return Err(corrupt("Retained output bytes exceed total output bytes."));
    }
    Ok(())
}

fn validate_state_head(head: &StateHead, job_id: &str) -> Result<(), ProtocolError> {
    if !matches!(head.format_version, 1..=STORE_FORMAT_VERSION)
        || head.job_id != job_id
        || head.revision < 1
        || !is_sha256(&head.state_digest)
    {
        return Err(corrupt("Job state head is invalid."));
    }
    Ok(())
}

fn validate_transition(from: JobState, to: JobState) -> Result<(), ProtocolError> {
    let valid = match from {
        JobState::Accepted => matches!(
            to,
            JobState::WorkerReady | JobState::StartFailed | JobState::Quarantined
        ),
        JobState::WorkerReady => matches!(
            to,
            JobState::WorkerReady
                | JobState::CommandStarting
                | JobState::StartFailed
                | JobState::Quarantined
        ),
        JobState::CommandStarting => matches!(
            to,
            JobState::CommandStarting
                | JobState::Running
                | JobState::StartFailed
                | JobState::TerminationUncertain
                | JobState::Quarantined
        ),
        JobState::Starting => matches!(
            to,
            JobState::Running
                | JobState::StartFailed
                | JobState::TerminationUncertain
                | JobState::Quarantined
        ),
        JobState::Running => matches!(
            to,
            JobState::Terminating
                | JobState::Exited
                | JobState::TerminationUncertain
                | JobState::Quarantined
        ),
        JobState::Terminating => matches!(
            to,
            JobState::Exited | JobState::TerminationUncertain | JobState::Quarantined
        ),
        JobState::Exited
        | JobState::StartFailed
        | JobState::TerminationUncertain
        | JobState::Quarantined => false,
    };
    if valid {
        Ok(())
    } else {
        Err(corrupt(format!(
            "Illegal job state transition from {from:?} to {to:?}."
        )))
    }
}

fn manifest_digest(manifest: &JobManifest) -> Result<String, ProtocolError> {
    let mut digestible = manifest.clone();
    digestible.manifest_digest.clear();
    serde_json::to_vec(&digestible)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(json_encode_error)
}

fn state_digest(state: &StoredJobState) -> Result<String, ProtocolError> {
    let mut digestible = state.clone();
    digestible.state_digest.clear();
    serde_json::to_vec(&digestible)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(json_encode_error)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn random_token() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TOKEN_BYTES);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes
}

fn read_private_json<T>(path: &Path, maximum_bytes: u64) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    validate_private_file(path, None)?;
    let metadata = std::fs::metadata(path).map_err(state_io_error)?;
    if metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err(corrupt(format!(
            "Durable file '{}' is empty or oversized.",
            path.display()
        )));
    }
    let file = File::open(path).map_err(state_io_error)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(state_io_error)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        corrupt(format!(
            "Durable JSON '{}' is invalid: {error}",
            path.display()
        ))
    })
}

fn write_new_json<T>(path: &Path, value: &T, maximum_bytes: u64) -> Result<(), ProtocolError>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec(value).map_err(json_encode_error)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes {
        return Err(corrupt("Encoded durable JSON exceeds its size limit."));
    }
    write_new_private_file(path, &bytes)
}

fn write_atomic_json<T>(path: &Path, value: &T, maximum_bytes: u64) -> Result<(), ProtocolError>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec(value).map_err(json_encode_error)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes {
        return Err(corrupt("Encoded durable JSON exceeds its size limit."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| corrupt("Durable state path has no parent."))?;
    let temporary = parent.join(format!(".state-{}.tmp", Uuid::new_v4().simple()));
    write_new_private_file(&temporary, &bytes)?;
    state_security::replace_file(&temporary, path).map_err(state_io_error)?;
    sync_directory(parent);
    Ok(())
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), ProtocolError> {
    let mut file = state_security::open_new_private_file(path).map_err(state_io_error)?;
    file.write_all(bytes).map_err(state_io_error)?;
    file.sync_all().map_err(state_io_error)?;
    if let Some(parent) = path.parent() {
        sync_directory(parent);
    }
    Ok(())
}

fn create_new_private_file(path: &Path) -> Result<(), ProtocolError> {
    write_new_private_file(path, &[])
}

pub(crate) fn create_private_directory(path: &Path) -> Result<(), ProtocolError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(corrupt(format!(
                "Private path '{}' is not a real directory.",
                path.display()
            )));
        }
    } else {
        std::fs::create_dir_all(path).map_err(state_io_error)?;
    }
    state_security::secure_private_directory(path).map_err(state_io_error)
}

pub(crate) fn validate_private_directory(path: &Path) -> Result<(), ProtocolError> {
    match state_security::validate_private_directory(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(corrupt(format!(
                "Private directory '{}' has unsafe type, owner, or permissions.",
                path.display()
            )))
        }
        Err(error) => Err(state_io_error(error)),
    }
}

pub(crate) fn validate_private_file(
    path: &Path,
    exact_size: Option<u64>,
) -> Result<(), ProtocolError> {
    match state_security::validate_private_file(path, exact_size) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(corrupt(format!(
                "Private file '{}' has unsafe type, owner, permissions, or size.",
                path.display()
            )))
        }
        Err(error) => Err(state_io_error(error)),
    }
}

pub(crate) fn sync_directory(path: &Path) {
    state_security::sync_directory(path);
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn corrupt(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("JOB_STATE_CORRUPT", message)
}

fn state_io_error(error: std::io::Error) -> ProtocolError {
    ProtocolError::new(
        "JOB_STATE_IO_FAILED",
        format!("Durable job I/O failed: {error}"),
    )
}

fn json_encode_error(error: serde_json::Error) -> ProtocolError {
    ProtocolError::new(
        "INTERNAL_ERROR",
        format!("Could not encode durable job state: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn start() -> StartParams {
        let cwd = std::env::current_dir().expect("cwd").display().to_string();
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
                crate::execution_policy::resolve_execution_policy(&cwd, None, None).unwrap(),
            ),
        }
    }

    fn legacy_copy(record: &JobRecord) -> JobRecord {
        let mut manifest = record.manifest.clone();
        manifest.format_version = 1;
        manifest.start.policy = None;
        manifest.security = None;
        manifest.request_digest = sha256_hex(&serde_json::to_vec(&manifest.start).unwrap());
        manifest.manifest_digest = manifest_digest(&manifest).unwrap();
        let mut state = record.read_state().unwrap();
        state.format_version = 1;
        state.security = None;
        state.state_digest = state_digest(&state).unwrap();
        write_atomic_json(
            &record.directory.join("manifest.json"),
            &manifest,
            MAX_MANIFEST_BYTES,
        )
        .unwrap();
        write_atomic_json(&record.state_path(), &state, MAX_STATE_BYTES).unwrap();
        write_atomic_json(
            &record.state_head_path(),
            &StateHead::from_state(&state),
            MAX_STATE_HEAD_BYTES,
        )
        .unwrap();
        JobRecord {
            directory: record.directory.clone(),
            manifest,
        }
    }

    fn v2_copy(record: &JobRecord) -> JobRecord {
        let mut manifest = record.manifest.clone();
        manifest.format_version = 2;
        manifest.manifest_digest = manifest_digest(&manifest).unwrap();
        let mut state = record.read_state().unwrap();
        state.format_version = 2;
        state.state_digest = state_digest(&state).unwrap();
        write_atomic_json(
            &record.directory.join("manifest.json"),
            &manifest,
            MAX_MANIFEST_BYTES,
        )
        .unwrap();
        write_atomic_json(&record.state_path(), &state, MAX_STATE_BYTES).unwrap();
        write_atomic_json(
            &record.state_head_path(),
            &StateHead::from_state(&state),
            MAX_STATE_HEAD_BYTES,
        )
        .unwrap();
        JobRecord {
            directory: record.directory.clone(),
            manifest,
        }
    }

    #[test]
    fn legacy_hashes_remain_stable_and_reads_do_not_upgrade_records() {
        let root = std::env::temp_dir().join(format!("koda-legacy-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).unwrap();
        let (record, _) = store.create_job("legacy", start()).unwrap();
        let legacy = legacy_copy(&record);
        let paths = [
            legacy.directory.join("manifest.json"),
            legacy.state_path(),
            legacy.state_head_path(),
        ];
        let before: Vec<_> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();
        let loaded = store.load_job(&legacy.directory).unwrap();
        let state = loaded.read_state().unwrap();
        assert_eq!(
            state.snapshot(&loaded.manifest.start).security,
            execution_security::legacy_unknown()
        );
        for (path, bytes) in paths.iter().zip(before) {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        let mut next = state.clone();
        next.state = JobState::StartFailed;
        let next = loaded.transition(&state, next).unwrap();
        assert_eq!(next.format_version, 1);
        assert!(next.security.is_none());
        assert_eq!(
            store
                .load_job(&legacy.directory)
                .unwrap()
                .manifest
                .format_version,
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_records_remain_readable_and_transitions_do_not_upgrade_them() {
        let root = std::env::temp_dir().join(format!("koda-v2-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).unwrap();
        let (record, _) = store.create_job("v2", start()).unwrap();
        assert_eq!(record.manifest.format_version, STORE_FORMAT_VERSION);
        let previous = v2_copy(&record);
        let paths = [
            previous.directory.join("manifest.json"),
            previous.state_path(),
            previous.state_head_path(),
        ];
        let before: Vec<_> = paths
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();
        let loaded = store.load_job(&previous.directory).unwrap();
        let state = loaded.read_state().unwrap();
        let ExecutionSecuritySnapshot::Policy(security) =
            state.snapshot(&loaded.manifest.start).security
        else {
            panic!("v2 record must retain policy evidence")
        };
        assert_eq!(security.schema_version, 1);
        for (path, bytes) in paths.iter().zip(before) {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        let mut next = state.clone();
        next.state = JobState::StartFailed;
        let next = loaded.transition(&state, next).unwrap();
        assert_eq!(next.format_version, 2);
        assert_eq!(
            store
                .load_job(&previous.directory)
                .unwrap()
                .manifest
                .format_version,
            2
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_format_rejects_v2_security_evidence() {
        let root =
            std::env::temp_dir().join(format!("koda-v2-evidence-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).unwrap();
        let (record, _) = store.create_job("v2-evidence", start()).unwrap();
        let mut manifest = record.manifest.clone();
        manifest.format_version = 2;
        manifest.security = Some(
            crate::execution_policy::create_execution_admission_snapshot(
                manifest.start.policy.as_ref().unwrap(),
                &crate::execution_policy::macos_seatbelt_execution_capabilities(),
            )
            .unwrap(),
        );
        manifest.manifest_digest = manifest_digest(&manifest).unwrap();
        assert_eq!(
            validate_manifest(&manifest).unwrap_err().code,
            "EXECUTION_SECURITY_CORRUPT"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_future_formats_are_left_in_place_before_any_quarantine() {
        for name in ["manifest.json", "state.json", "state.head"] {
            let root =
                std::env::temp_dir().join(format!("koda-future-{}", Uuid::new_v4().simple()));
            let store = JobStore::open(&root).unwrap();
            let (record, _) = store.create_job("future", start()).unwrap();
            let path = record.directory.join(name);
            let mut value: serde_json::Value =
                read_private_json(&path, MAX_MANIFEST_BYTES).unwrap();
            value["format_version"] = serde_json::json!(4);
            value["future_field"] = serde_json::json!({"preserve":true});
            write_atomic_json(&path, &value, MAX_MANIFEST_BYTES).unwrap();
            let before = std::fs::read(&path).unwrap();
            assert_eq!(
                store.scan(10).unwrap_err().code,
                "INCOMPATIBLE_STATE_VERSION"
            );
            assert!(record.directory.exists());
            assert_eq!(std::fs::read(path).unwrap(), before);
            assert_eq!(
                std::fs::read_dir(&store.quarantine_root).unwrap().count(),
                0
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn new_records_never_treat_missing_or_null_security_as_legacy() {
        for name in ["manifest.json", "state.json"] {
            for null in [false, true] {
                let root = std::env::temp_dir()
                    .join(format!("koda-missing-security-{}", Uuid::new_v4().simple()));
                let store = JobStore::open(&root).unwrap();
                let (record, _) = store.create_job("missing", start()).unwrap();
                let path = record.directory.join(name);
                let mut value: serde_json::Value =
                    read_private_json(&path, MAX_MANIFEST_BYTES).unwrap();
                if null {
                    value["security"] = serde_json::Value::Null;
                } else {
                    value.as_object_mut().unwrap().remove("security");
                }
                write_atomic_json(&path, &value, MAX_MANIFEST_BYTES).unwrap();
                assert_eq!(
                    store.load_job(&record.directory).unwrap_err().code,
                    "EXECUTION_SECURITY_CORRUPT"
                );
                assert!(record.directory.exists());
                std::fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn unavailable_policy_creates_no_job_and_evidence_cannot_be_downgraded() {
        let root = std::env::temp_dir().join(format!("koda-admission-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).unwrap();
        let mut rejected = start();
        rejected.policy.as_mut().unwrap().network = crate::execution_policy::NetworkPolicy::Deny;
        assert_eq!(
            store.create_job("denied", rejected).unwrap_err().code,
            "EXECUTION_POLICY_UNAVAILABLE"
        );
        assert_eq!(std::fs::read_dir(&store.jobs_root).unwrap().count(), 0);
        let (record, _) = store.create_job("allowed", start()).unwrap();
        let initial = record.read_state().unwrap();
        let mut ready = initial.clone();
        ready.state = JobState::WorkerReady;
        let ready = record.transition(&initial, ready).unwrap();
        let mut starting = ready.clone();
        starting.state = JobState::CommandStarting;
        let starting = record.transition(&ready, starting).unwrap();
        let mut running = starting.clone();
        running.state = JobState::Running;
        running.command_pid = Some(1);
        running.command_start_identity = Some("fixture".into());
        running.security = Some(
            execution_security::launch_setup(
                &record.manifest.start,
                starting.security.as_ref().unwrap(),
            )
            .unwrap(),
        );
        let running = record.transition(&starting, running).unwrap();
        let mut downgraded = running.clone();
        downgraded.state = JobState::TerminationUncertain;
        downgraded.security = initial.security;
        assert_eq!(
            record.transition(&running, downgraded).unwrap_err().code,
            "EXECUTION_SECURITY_CORRUPT"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_and_verifies_private_durable_job() {
        let root = std::env::temp_dir().join(format!("koda-store-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).expect("store");
        let (record, token) = store.create_job("request-1", start()).expect("job");

        assert_eq!(record.read_token().expect("token"), token);
        assert_eq!(
            record.read_state().expect("state").state,
            JobState::Accepted
        );
        assert_eq!(store.scan(10).expect("scan").len(), 1);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_illegal_or_tampered_state() {
        let root = std::env::temp_dir().join(format!("koda-store-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).expect("store");
        let (record, _) = store.create_job("request-2", start()).expect("job");
        let current = record.read_state().expect("state");
        let mut illegal = current.clone();
        illegal.state = JobState::Exited;
        assert_eq!(
            record
                .transition(&current, illegal)
                .expect_err("illegal")
                .code,
            "JOB_STATE_CORRUPT"
        );

        let mut bytes = std::fs::read(record.state_path()).expect("read");
        bytes[0] ^= 1;
        std::fs::write(record.state_path(), bytes).expect("tamper");
        assert!(record.read_state().is_err());
        assert!(store.scan(10).expect("quarantine scan").is_empty());
        assert_eq!(
            std::fs::read_dir(&store.quarantine_root)
                .expect("quarantine")
                .count(),
            2
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn repairs_one_step_head_lag_but_rejects_state_rollback() {
        let root = std::env::temp_dir().join(format!("koda-store-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).expect("store");
        let (record, _) = store.create_job("request-3", start()).expect("job");
        let initial_bytes = std::fs::read(record.state_path()).expect("initial state");
        let current = record.read_state().expect("current");
        let mut next = current.clone();
        next.state = JobState::WorkerReady;
        next.revision = 2;
        next.previous_state_digest = Some(current.state_digest.clone());
        next.state_digest.clear();
        next.state_digest = state_digest(&next).expect("digest");
        write_atomic_json(&record.state_path(), &next, MAX_STATE_BYTES).expect("state only");

        assert_eq!(record.read_state().expect("repair head").revision, 2);
        std::fs::write(record.state_path(), initial_bytes).expect("rollback state");
        assert_eq!(
            record.read_state().expect_err("rollback").code,
            "JOB_STATE_CORRUPT"
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    #[cfg(unix)]
    fn quarantines_wrong_permissions_and_symlinked_entries() {
        let root = std::env::temp_dir().join(format!("koda-store-{}", Uuid::new_v4().simple()));
        let store = JobStore::open(&root).expect("store");
        let (record, _) = store.create_job("request-4", start()).expect("job");
        std::fs::set_permissions(
            record.directory.join("manifest.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .expect("permissions");
        std::os::unix::fs::symlink(&root, store.jobs_root.join("linked-job")).expect("symlink");

        assert!(store.scan(10).expect("scan").is_empty());
        assert_eq!(
            std::fs::read_dir(&store.quarantine_root)
                .expect("quarantine")
                .count(),
            4
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
