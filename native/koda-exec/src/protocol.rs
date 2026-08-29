use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_ARGUMENTS: usize = 64;
pub const MAX_ARGUMENT_BYTES: usize = 4_096;
pub const MAX_TOTAL_ARGUMENT_BYTES: usize = 32_768;
pub const MAX_ENVIRONMENT_ENTRIES: usize = 128;
pub const MAX_ENVIRONMENT_BYTES: usize = 65_536;
pub const MAX_OUTPUT_LIMIT_BYTES: u64 = 67_108_864;
pub const MAX_OUTPUT_READ_BYTES: u32 = 65_536;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TERMINATION_GRACE_MS: u64 = 10_000;
pub const MAX_TERMINATION_CONFIRMATION_MS: u64 = 30_000;

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
    pub environment: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
    pub termination_grace_ms: u64,
    pub termination_confirmation_ms: u64,
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
}

#[derive(Clone, Debug, Serialize)]
pub struct JobSummary {
    pub job_id: String,
    pub state: JobState,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub pid: Option<u32>,
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
            "The client does not support executor protocol version 1.",
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
    let cwd = std::path::Path::new(&params.cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "cwd must be an existing absolute directory.",
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
    if !(100..=MAX_TIMEOUT_MS).contains(&params.timeout_ms)
        || !(1..=MAX_OUTPUT_LIMIT_BYTES).contains(&params.output_limit_bytes)
        || params.termination_grace_ms > MAX_TERMINATION_GRACE_MS
        || !(100..=MAX_TERMINATION_CONFIRMATION_MS).contains(&params.termination_confirmation_ms)
    {
        return Err(ProtocolError::new(
            "INVALID_REQUEST",
            "Execution limits are outside the supported ranges.",
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
            environment: BTreeMap::new(),
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            termination_grace_ms: 100,
            termination_confirmation_ms: 1_000,
        };

        assert_eq!(
            validate_start(&params)
                .expect_err("oversized argument")
                .code,
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn request_rejects_unknown_fields() {
        let parsed = serde_json::from_str::<Request>(
            r#"{"protocol_version":1,"request_id":"r1","method":"system/hello","params":{},"extra":true}"#,
        );

        assert!(parsed.is_err());
    }
}
