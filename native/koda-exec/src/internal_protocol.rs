use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

use crate::protocol::{JobSnapshot, TerminationReason};

pub const WORKER_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerResponse {
    pub protocol_version: u32,
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WorkerError>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerHelloParams {
    pub job_id: String,
    pub nonce_base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerHelloResult {
    pub job_id: String,
    pub worker_pid: u32,
    pub worker_start_identity: String,
    pub proof_base64: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerTerminateParams {
    pub reason: TerminationReason,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

impl WorkerResponse {
    pub fn success(request_id: String, result: Value) -> Self {
        Self {
            protocol_version: WORKER_PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: String, code: &str, message: impl Into<String>) -> Self {
        Self {
            protocol_version: WORKER_PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(WorkerError {
                code: code.to_owned(),
                message: message.into(),
            }),
        }
    }
}

pub fn new_nonce() -> Vec<u8> {
    let mut nonce = Vec::with_capacity(32);
    nonce.extend_from_slice(Uuid::new_v4().as_bytes());
    nonce.extend_from_slice(Uuid::new_v4().as_bytes());
    nonce
}

pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(4)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("value is not canonical Base64".to_owned());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "value is not valid Base64".to_owned())?;
    if encode_base64(&decoded) != value {
        return Err("value is not canonical Base64".to_owned());
    }
    Ok(decoded)
}

pub fn worker_proof(
    token: &[u8],
    nonce: &[u8],
    job_id: &str,
    worker_pid: u32,
    worker_start_identity: &str,
) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(token)
        .map_err(|_| "worker token length is invalid".to_owned())?;
    mac.update(b"koda-exec-worker-v1\0");
    mac.update(nonce);
    mac.update(b"\0");
    mac.update(job_id.as_bytes());
    mac.update(b"\0");
    mac.update(worker_pid.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(worker_start_identity.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn attachment_proof(
    token: &[u8],
    job_id: &str,
    attachment_id: &str,
) -> Result<Vec<u8>, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(token)
        .map_err(|_| "worker token length is invalid".to_owned())?;
    mac.update(b"koda-exec-attachment-v1\0");
    mac.update(job_id.as_bytes());
    mac.update(b"\0");
    mac.update(attachment_id.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn parse_params<T>(value: Value) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|error| format!("invalid Worker parameters: {error}"))
}

pub fn status_value(snapshot: JobSnapshot) -> Result<Value, String> {
    serde_json::to_value(snapshot)
        .map_err(|error| format!("could not encode Worker status: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_binds_every_identity_component() {
        let token = vec![7; 32];
        let nonce = vec![9; 32];
        let proof = worker_proof(&token, &nonce, "job", 42, "start").expect("proof");
        assert_ne!(
            proof,
            worker_proof(&token, &nonce, "job", 43, "start").expect("proof")
        );
        assert_eq!(
            decode_base64(&encode_base64(&proof)).expect("base64"),
            proof
        );
    }

    #[test]
    fn attachment_proof_binds_job_and_attachment() {
        let token = vec![7; 32];
        let proof = attachment_proof(&token, "job", "attachment").expect("proof");
        assert_ne!(
            proof,
            attachment_proof(&token, "other", "attachment").expect("proof")
        );
        assert_ne!(
            proof,
            attachment_proof(&token, "job", "other").expect("proof")
        );
    }
}
