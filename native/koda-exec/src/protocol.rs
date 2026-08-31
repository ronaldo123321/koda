use std::collections::BTreeMap;

use crate::execution_policy::{ExecutionPolicy, ExecutionSecuritySnapshot};
use crate::secret_policy::{SecretExecutionEvidence, SecretLeaseEnvelope, SecretPolicyError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 8;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_ARGUMENTS: usize = 64;
pub const MAX_ARGUMENT_BYTES: usize = 4_096;
pub const MAX_TOTAL_ARGUMENT_BYTES: usize = 32_768;
pub const MAX_DISPLAY_NAME_BYTES: usize = 128;
pub const MAX_ENVIRONMENT_ENTRIES: usize = 128;
pub const MAX_ENVIRONMENT_BYTES: usize = 65_536;
pub const MAX_OUTPUT_LIMIT_BYTES: u64 = 67_108_864;
pub const MAX_OUTPUT_READ_BYTES: u32 = 65_536;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
pub const MAX_BACKGROUND_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1_000;
pub const MAX_TERMINATION_GRACE_MS: u64 = 10_000;
pub const MAX_TERMINATION_CONFIRMATION_MS: u64 = 30_000;
pub const DEFAULT_PTY_OUTPUT_LIMIT_BYTES: u64 = 4 * 1_048_576;
pub const MIN_PTY_OUTPUT_LIMIT_BYTES: u64 = 65_536;
pub const MAX_PTY_OUTPUT_LIMIT_BYTES: u64 = 64 * 1_048_576;
pub const MAX_PTY_DIMENSION: u16 = 500;
pub const DEFAULT_INPUT_LEASE_MS: u64 = 15_000;
pub const MAX_ATTACHMENT_READ_BYTES: u32 = 65_536;
pub const MAX_PTY_INPUT_BYTES: usize = 16_384;
pub const MAX_PENDING_PTY_INPUT_BYTES: u64 = 65_536;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub protocol_version: u32,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl Response {
    pub fn success(request_id: String, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: String, error: ProtocolError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: error.code.to_owned(),
                message: error.message,
            }),
        }
    }
}

#[derive(Debug)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelloParams {
    pub client_name: String,
    pub client_version: String,
    pub supported_versions: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StartParams {
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub environment: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
    pub termination_grace_ms: u64,
    pub termination_confirmation_ms: u64,
    #[serde(default, skip_serializing_if = "IoMode::is_default")]
    pub io_mode: IoMode,
    #[serde(default, skip_serializing_if = "JobLifecycle::is_default")]
    pub lifecycle: JobLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty: Option<PtyStartConfig>,
    // Optional only for reading v1 durable records. Current starts require it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<ExecutionPolicy>,
    /// Public, value-free secret contract. Raw values are accepted only by
    /// `StartRequest::secret_lease` and are never serialized with this record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<SecretExecutionEvidence>,
}

#[derive(Debug)]
pub struct StartRequest {
    pub start: StartParams,
    pub secret_lease: Option<SecretLeaseEnvelope>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IoMode {
    #[default]
    Pipe,
    Pty,
}

impl IoMode {
    fn is_default(value: &Self) -> bool {
        *value == Self::Pipe
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobLifecycle {
    #[default]
    Foreground,
    Background,
}

impl JobLifecycle {
    fn is_default(value: &Self) -> bool {
        *value == Self::Foreground
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PtyStartConfig {
    pub rows: u16,
    pub cols: u16,
    pub term: String,
    #[serde(default = "default_pty_output_limit_bytes")]
    pub output_limit_bytes: u64,
}

fn default_pty_output_limit_bytes() -> u64 {
    DEFAULT_PTY_OUTPUT_LIMIT_BYTES
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobParams {
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadOutputParams {
    pub job_id: String,
    pub stream: OutputStream,
    pub offset: u64,
    pub max_bytes: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminateParams {
    pub job_id: String,
    pub reason: TerminationReason,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListJobsParams {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentOpenParams {
    pub job_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentCredentials {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentReadParams {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
    pub cursor: u64,
    pub max_bytes: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentAcquireInputParams {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentRenewParams {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
    pub lease_token: String,
    pub fence: u64,
}

pub type AttachmentDetachParams = AttachmentCredentials;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputWriteParams {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
    pub lease_token: String,
    pub fence: u64,
    pub data_base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalResizeParams {
    pub job_id: String,
    pub attachment_id: String,
    pub capability_token: String,
    pub lease_token: String,
    pub fence: u64,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminationReason {
    Timeout,
    Cancellation,
    OutputFailure,
    OrphanCleanup,
}

impl TerminationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Cancellation => "cancellation",
            Self::OutputFailure => "output_failure",
            Self::OrphanCleanup => "orphan_cleanup",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Accepted,
    WorkerReady,
    CommandStarting,
    Starting,
    Running,
    Terminating,
    Exited,
    StartFailed,
    TerminationUncertain,
    Quarantined,
}

impl JobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Exited | Self::StartFailed | Self::TerminationUncertain | Self::Quarantined
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TerminationAttempt {
    pub attempt: String,
    pub mechanism: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TerminationSnapshot {
    pub reason: String,
    pub outcome: String,
    pub attempts: Vec<TerminationAttempt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct JobFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct JobSnapshot {
    pub job_id: String,
    pub state: JobState,
    pub io_mode: IoMode,
    pub lifecycle: JobLifecycle,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_retained_bytes: u64,
    pub stderr_retained_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub termination: Option<TerminationSnapshot>,
    pub failure: Option<JobFailure>,
    pub security: ExecutionSecuritySnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<SecretExecutionEvidence>,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobSummary {
    pub job_id: String,
    pub display_name: Option<String>,
    pub cwd: String,
    pub state: JobState,
    pub io_mode: IoMode,
    pub lifecycle: JobLifecycle,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub pid: Option<u32>,
    pub security: ExecutionSecuritySnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<SecretExecutionEvidence>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ListJobsResult {
    pub jobs: Vec<JobSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OutputReadResult {
    pub job_id: String,
    pub stream: OutputStream,
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub retained_bytes: u64,
    pub complete: bool,
    pub truncated: bool,
    pub data_base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct InputLeaseResult {
    pub job_id: String,
    pub attachment_id: String,
    pub lease_token: String,
    pub fence: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct InputWriteResult {
    pub job_id: String,
    pub accepted_bytes: u32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TerminalResizeResult {
    pub job_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AttachmentDetachResult {
    pub job_id: String,
    pub detached: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AttachmentReadResult {
    Ok {
        job_id: String,
        cursor: u64,
        next_cursor: u64,
        earliest_cursor: u64,
        latest_cursor: u64,
        complete: bool,
        data_base64: String,
    },
    CursorExpired {
        job_id: String,
        cursor: u64,
        earliest_cursor: u64,
        latest_cursor: u64,
        complete: bool,
    },
}

pub fn parse_params<T>(value: Value) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|error| {
        ProtocolError::new(
            "INVALID_REQUEST",
            format!("Request parameters are invalid: {error}"),
        )
    })
}

pub fn parse_start_params(mut value: Value) -> Result<StartRequest, ProtocolError> {
    let object = value.as_object_mut().ok_or_else(|| {
        ProtocolError::new("INVALID_REQUEST", "Execution start parameters are invalid.")
    })?;
    let secret_value = object.remove("secret_lease");
    let policy = ExecutionPolicy::parse(object.get("policy").cloned().unwrap_or(Value::Null))
        .map_err(crate::execution_security::policy_error)?;
    let mut params: StartParams = serde_json::from_value(value).map_err(|_| {
        ProtocolError::new("INVALID_REQUEST", "Execution start parameters are invalid.")
    })?;
    params.policy = Some(policy);
    let secret_lease = secret_value
        .map(|secret| {
            serde_json::from_value::<SecretLeaseEnvelope>(secret).map_err(|_| {
                ProtocolError::new(
                    SecretPolicyError::SecretEvidenceCorrupt.code(),
                    SecretPolicyError::SecretEvidenceCorrupt.to_string(),
                )
            })
        })
        .transpose()?;
    params.secrets = secret_lease
        .as_ref()
        .map(SecretLeaseEnvelope::public_evidence);
    Ok(StartRequest {
        start: params,
        secret_lease,
    })
}

pub fn validate_request(request: &Request) -> Result<(), ProtocolError> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::new(
            "INCOMPATIBLE_PROTOCOL",
            format!(
                "Protocol version {} is unsupported; expected {}.",
                request.protocol_version, PROTOCOL_VERSION
            ),
        ));
    }
    validate_identifier(&request.request_id, "request_id")
}

pub fn validate_identifier(value: &str, name: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("{name} must use 1-128 ASCII letters, digits, underscores, or hyphens."),
        ));
    }
    Ok(())
}

pub fn validate_hello(params: &HelloParams) -> Result<(), ProtocolError> {
    if params.client_name.is_empty()
        || params.client_name.len() > 128
        || params.client_version.is_empty()
        || params.client_version.len() > 128
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "Client name and version must contain 1-128 bytes.",
        ));
    }
    if !params.supported_versions.contains(&PROTOCOL_VERSION) {
        return Err(ProtocolError::new(
            "INCOMPATIBLE_PROTOCOL",
            "The client does not support executor protocol version 7.",
        ));
    }
    Ok(())
}

pub fn validate_start(params: &StartParams) -> Result<(), ProtocolError> {
    if params.argv.is_empty() || params.argv.len() > MAX_ARGUMENTS {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("argv must contain between 1 and {MAX_ARGUMENTS} entries."),
        ));
    }
    let mut total_argument_bytes = 0usize;
    for argument in &params.argv {
        let bytes = argument.as_bytes();
        if bytes.len() > MAX_ARGUMENT_BYTES || argument.contains('\0') {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                format!(
                    "Each argument must be at most {MAX_ARGUMENT_BYTES} bytes and contain no null byte."
                ),
            ));
        }
        total_argument_bytes = total_argument_bytes.saturating_add(bytes.len());
    }
    if params.argv[0].trim().is_empty() || total_argument_bytes > MAX_TOTAL_ARGUMENT_BYTES {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!(
                "The executable must be non-empty and arguments must total at most {MAX_TOTAL_ARGUMENT_BYTES} bytes."
            ),
        ));
    }
    if params.cwd.is_empty() || params.cwd.contains('\0') || params.cwd.len() > 4_096 {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "cwd must contain 1-4096 bytes without a null byte.",
        ));
    }
    if let Some(display_name) = &params.display_name
        && (display_name.trim().is_empty()
            || display_name.len() > MAX_DISPLAY_NAME_BYTES
            || display_name.chars().any(char::is_control))
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!(
                "display_name must contain 1-{MAX_DISPLAY_NAME_BYTES} UTF-8 bytes without control characters."
            ),
        ));
    }
    let cwd = std::path::Path::new(&params.cwd);
    if !cwd.is_absolute() {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "cwd must be an absolute directory path.",
        ));
    }
    if params.environment.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("environment may contain at most {MAX_ENVIRONMENT_ENTRIES} entries."),
        ));
    }
    let environment_bytes = params
        .environment
        .iter()
        .try_fold(0usize, |total, (name, value)| {
            if name.is_empty()
                || name.contains(['=', '\0'])
                || value.contains('\0')
                || name.len() > 4_096
                || value.len() > 32_768
            {
                None
            } else {
                total.checked_add(name.len() + value.len())
            }
        })
        .ok_or_else(|| {
            ProtocolError::new(
                "INVALID_REQUEST",
                "Environment names and values exceed their structural limits.",
            )
        })?;
    if environment_bytes > MAX_ENVIRONMENT_BYTES {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("environment must total at most {MAX_ENVIRONMENT_BYTES} bytes."),
        ));
    }
    let maximum_timeout = match (params.io_mode, params.lifecycle) {
        (IoMode::Pipe, JobLifecycle::Foreground) => MAX_TIMEOUT_MS,
        (IoMode::Pipe | IoMode::Pty, JobLifecycle::Background)
        | (IoMode::Pty, JobLifecycle::Foreground) => MAX_BACKGROUND_TIMEOUT_MS,
    };
    if !(100..=maximum_timeout).contains(&params.timeout_ms)
        || !(1..=MAX_OUTPUT_LIMIT_BYTES).contains(&params.output_limit_bytes)
        || params.termination_grace_ms > MAX_TERMINATION_GRACE_MS
        || !(100..=MAX_TERMINATION_CONFIRMATION_MS).contains(&params.termination_confirmation_ms)
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "Execution limits are outside the supported ranges.",
        ));
    }
    match (params.io_mode, &params.pty) {
        (IoMode::Pipe, None) => {}
        (IoMode::Pipe, Some(_)) => {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                "pty configuration is valid only when io_mode is pty.",
            ));
        }
        (IoMode::Pty, None) => {
            return Err(ProtocolError::new(
                "INVALID_REQUEST",
                "pty configuration is required when io_mode is pty.",
            ));
        }
        (IoMode::Pty, Some(pty)) => validate_pty_config(pty)?,
    }
    if let Some(secrets) = &params.secrets {
        secrets.validate().map_err(secret_policy_error)?;
        if secrets.lifecycle != crate::secret_policy::SecretLifecycle::Resolved
            || secrets.cleanup != crate::secret_policy::SecretCleanup::NotStarted
            || secrets.redactions
                != (crate::secret_policy::SecretRedactionCounts {
                    stdout: 0,
                    stderr: 0,
                    pty: 0,
                })
        {
            return Err(secret_policy_error(
                SecretPolicyError::SecretEvidenceCorrupt,
            ));
        }
        let policy = params
            .policy
            .as_ref()
            .ok_or_else(|| secret_policy_error(SecretPolicyError::SecretPolicyUnavailable))?;
        if policy.network != crate::execution_policy::NetworkPolicy::Deny
            || !matches!(
                policy.filesystem,
                crate::execution_policy::FilesystemPolicy::ReadOnly
                    | crate::execution_policy::FilesystemPolicy::WorkspaceWrite
            )
            || secrets.targets.iter().any(|target| {
                params
                    .environment
                    .contains_key(&target.environment_variable)
            })
        {
            return Err(secret_policy_error(
                SecretPolicyError::SecretPolicyUnavailable,
            ));
        }
    }
    Ok(())
}

pub fn secret_policy_error(error: SecretPolicyError) -> ProtocolError {
    ProtocolError::new(error.code(), error.to_string())
}

pub fn validate_pty_config(params: &PtyStartConfig) -> Result<(), ProtocolError> {
    if !(1..=MAX_PTY_DIMENSION).contains(&params.rows)
        || !(1..=MAX_PTY_DIMENSION).contains(&params.cols)
        || !(MIN_PTY_OUTPUT_LIMIT_BYTES..=MAX_PTY_OUTPUT_LIMIT_BYTES)
            .contains(&params.output_limit_bytes)
        || params.term.is_empty()
        || params.term.len() > 64
        || !params
            .term
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "PTY dimensions, TERM, or output retention are outside supported ranges.",
        ));
    }
    Ok(())
}

pub fn validate_attachment_credentials(
    job_id: &str,
    attachment_id: &str,
    capability_token: &str,
) -> Result<(), ProtocolError> {
    validate_identifier(job_id, "job_id")?;
    validate_identifier(attachment_id, "attachment_id")?;
    validate_opaque_token(capability_token, "capability_token")
}

pub fn validate_lease(lease_token: &str, fence: u64) -> Result<(), ProtocolError> {
    validate_opaque_token(lease_token, "lease_token")?;
    if fence == 0 {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "fence must be a positive integer.",
        ));
    }
    Ok(())
}

pub fn validate_attachment_read(params: &AttachmentReadParams) -> Result<(), ProtocolError> {
    validate_attachment_credentials(
        &params.job_id,
        &params.attachment_id,
        &params.capability_token,
    )?;
    if params.max_bytes == 0 || params.max_bytes > MAX_ATTACHMENT_READ_BYTES {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("max_bytes must be between 1 and {MAX_ATTACHMENT_READ_BYTES}."),
        ));
    }
    Ok(())
}

pub fn validate_terminal_size(rows: u16, cols: u16) -> Result<(), ProtocolError> {
    if !(1..=MAX_PTY_DIMENSION).contains(&rows) || !(1..=MAX_PTY_DIMENSION).contains(&cols) {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("rows and cols must be between 1 and {MAX_PTY_DIMENSION}."),
        ));
    }
    Ok(())
}

fn validate_opaque_token(value: &str, name: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("{name} must be bounded canonical Base64."),
        ));
    }
    Ok(())
}

pub fn validate_output_read(params: &ReadOutputParams) -> Result<(), ProtocolError> {
    validate_identifier(&params.job_id, "job_id")?;
    if params.max_bytes == 0 || params.max_bytes > MAX_OUTPUT_READ_BYTES {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            format!("max_bytes must be between 1 and {MAX_OUTPUT_READ_BYTES}."),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_validation_rejects_unbounded_arguments() {
        let params = StartParams {
            argv: vec!["x".repeat(MAX_ARGUMENT_BYTES + 1)],
            cwd: std::env::current_dir().expect("cwd").display().to_string(),
            display_name: None,
            environment: BTreeMap::new(),
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            termination_grace_ms: 100,
            termination_confirmation_ms: 1_000,
            io_mode: IoMode::Pipe,
            lifecycle: JobLifecycle::Foreground,
            pty: None,
            policy: None,
            secrets: None,
        };

        assert_eq!(
            validate_start(&params)
                .expect_err("oversized argument")
                .code,
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn legacy_start_defaults_to_pipe_foreground() {
        let params: StartParams = serde_json::from_value(serde_json::json!({
            "argv": ["/usr/bin/true"],
            "cwd": std::env::current_dir().expect("cwd"),
            "environment": {},
            "timeout_ms": 1_000,
            "output_limit_bytes": 1_024,
            "termination_grace_ms": 100,
            "termination_confirmation_ms": 1_000
        }))
        .expect("legacy start");

        assert_eq!(params.io_mode, IoMode::Pipe);
        assert_eq!(params.lifecycle, JobLifecycle::Foreground);
        assert!(params.pty.is_none());
        assert!(params.display_name.is_none());
        let encoded = serde_json::to_value(params).expect("legacy encoding");
        assert!(encoded.get("io_mode").is_none());
        assert!(encoded.get("lifecycle").is_none());
    }

    #[test]
    fn pty_requires_strict_configuration() {
        let params = StartParams {
            argv: vec!["/usr/bin/true".to_owned()],
            cwd: std::env::current_dir().expect("cwd").display().to_string(),
            display_name: Some("test terminal".to_owned()),
            environment: BTreeMap::new(),
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            termination_grace_ms: 100,
            termination_confirmation_ms: 1_000,
            io_mode: IoMode::Pty,
            lifecycle: JobLifecycle::Foreground,
            pty: Some(PtyStartConfig {
                rows: 24,
                cols: 80,
                term: "xterm-256color".to_owned(),
                output_limit_bytes: DEFAULT_PTY_OUTPUT_LIMIT_BYTES,
            }),
            policy: None,
            secrets: None,
        };

        validate_start(&params).expect("valid pty start");
    }

    #[test]
    fn request_rejects_unknown_fields() {
        let parsed = serde_json::from_str::<Request>(
            r#"{"protocol_version":1,"request_id":"r1","method":"system/hello","params":{},"extra":true}"#,
        );

        assert!(parsed.is_err());
    }

    #[test]
    fn protocol_v8_rejects_v7_requests_and_clients_without_fallback() {
        let request = Request {
            protocol_version: 7,
            request_id: "r1".into(),
            method: "system/hello".into(),
            params: serde_json::json!({}),
        };
        assert_eq!(
            validate_request(&request).unwrap_err().code,
            "INCOMPATIBLE_PROTOCOL"
        );
        let hello = HelloParams {
            client_name: "legacy-client".into(),
            client_version: "1.0.0".into(),
            supported_versions: vec![7],
        };
        assert_eq!(
            validate_hello(&hello).unwrap_err().code,
            "INCOMPATIBLE_PROTOCOL"
        );
    }
}
