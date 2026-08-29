use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::internal_protocol::{attachment_proof, decode_base64, encode_base64, new_nonce};
use crate::protocol::{
    AttachmentCredentials, DEFAULT_INPUT_LEASE_MS, InputLeaseResult, ProtocolError,
};

const MAX_ATTACHMENTS: usize = 128;

struct InputLease {
    attachment_id: String,
    lease_token: String,
    fence: u64,
    expires_at: Instant,
    expires_at_ms: u64,
}

pub struct AttachmentRegistry {
    job_id: String,
    token: Vec<u8>,
    attachments: HashSet<String>,
    lease: Option<InputLease>,
    next_fence: u64,
    lease_duration: Duration,
}

impl AttachmentRegistry {
    pub fn new(job_id: String, token: Vec<u8>) -> Self {
        Self::with_lease_duration(job_id, token, Duration::from_millis(DEFAULT_INPUT_LEASE_MS))
    }

    fn with_lease_duration(job_id: String, token: Vec<u8>, lease_duration: Duration) -> Self {
        Self {
            job_id,
            token,
            attachments: HashSet::new(),
            lease: None,
            next_fence: 1,
            lease_duration,
        }
    }

    pub fn open(&mut self) -> Result<AttachmentCredentials, ProtocolError> {
        if self.attachments.len() >= MAX_ATTACHMENTS {
            return Err(ProtocolError::new(
                "ATTACHMENT_LIMIT_EXCEEDED",
                format!("A PTY job may have at most {MAX_ATTACHMENTS} live attachments."),
            ));
        }
        let attachment_id = Uuid::new_v4().simple().to_string();
        let capability_token = capability_token(&self.token, &self.job_id, &attachment_id)?;
        self.attachments.insert(attachment_id.clone());
        Ok(AttachmentCredentials {
            job_id: self.job_id.clone(),
            attachment_id,
            capability_token,
        })
    }

    pub fn verify(&self, attachment_id: &str, capability: &str) -> Result<(), ProtocolError> {
        if !self.attachments.contains(attachment_id)
            || !verify_capability(&self.token, &self.job_id, attachment_id, capability)
        {
            return Err(ProtocolError::new(
                "ATTACHMENT_NOT_FOUND",
                "The PTY attachment does not exist or its capability is invalid.",
            ));
        }
        Ok(())
    }

    pub fn acquire_input(
        &mut self,
        attachment_id: &str,
        capability: &str,
    ) -> Result<InputLeaseResult, ProtocolError> {
        self.verify(attachment_id, capability)?;
        self.expire_lease();
        if let Some(lease) = &mut self.lease {
            if lease.attachment_id != attachment_id {
                return Err(ProtocolError::new(
                    "INPUT_LEASE_HELD",
                    "Another PTY attachment currently owns input.",
                ));
            }
            renew_lease(lease, self.lease_duration);
            return Ok(lease_result(&self.job_id, lease));
        }
        let fence = self.next_fence;
        self.next_fence = self.next_fence.checked_add(1).ok_or_else(|| {
            ProtocolError::new("INPUT_FENCE_EXHAUSTED", "PTY input fence is exhausted.")
        })?;
        let mut lease = InputLease {
            attachment_id: attachment_id.to_owned(),
            lease_token: encode_base64(&new_nonce()),
            fence,
            expires_at: Instant::now(),
            expires_at_ms: 0,
        };
        renew_lease(&mut lease, self.lease_duration);
        let result = lease_result(&self.job_id, &lease);
        self.lease = Some(lease);
        Ok(result)
    }

    pub fn renew_input(
        &mut self,
        attachment_id: &str,
        capability: &str,
        lease_token: &str,
        fence: u64,
    ) -> Result<InputLeaseResult, ProtocolError> {
        self.validate_input(attachment_id, capability, lease_token, fence)?;
        let lease = self
            .lease
            .as_mut()
            .expect("validated PTY input lease exists");
        renew_lease(lease, self.lease_duration);
        Ok(lease_result(&self.job_id, lease))
    }

    pub fn validate_input(
        &mut self,
        attachment_id: &str,
        capability: &str,
        lease_token: &str,
        fence: u64,
    ) -> Result<(), ProtocolError> {
        self.verify(attachment_id, capability)?;
        self.expire_lease();
        let Some(lease) = &self.lease else {
            return Err(ProtocolError::new(
                "INPUT_LEASE_EXPIRED",
                "The PTY input lease has expired or was released.",
            ));
        };
        if fence != lease.fence {
            return Err(ProtocolError::new(
                "STALE_INPUT_FENCE",
                "The PTY input fence is stale.",
            ));
        }
        if lease.attachment_id != attachment_id
            || !constant_time_equal(lease.lease_token.as_bytes(), lease_token.as_bytes())
        {
            return Err(ProtocolError::new(
                "INPUT_LEASE_EXPIRED",
                "The PTY input lease does not belong to this attachment.",
            ));
        }
        Ok(())
    }

    pub fn detach(&mut self, attachment_id: &str, capability: &str) -> Result<bool, ProtocolError> {
        self.verify(attachment_id, capability)?;
        let removed = self.attachments.remove(attachment_id);
        if self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.attachment_id == attachment_id)
        {
            self.lease = None;
        }
        Ok(removed)
    }

    fn expire_lease(&mut self) {
        if self
            .lease
            .as_ref()
            .is_some_and(|lease| Instant::now() >= lease.expires_at)
        {
            self.lease = None;
        }
    }

    #[cfg(test)]
    fn expire_lease_for_test(&mut self) {
        if let Some(lease) = &mut self.lease {
            lease.expires_at = Instant::now();
        }
    }
}

pub fn create_stateless_attachment(
    token: &[u8],
    job_id: &str,
) -> Result<AttachmentCredentials, ProtocolError> {
    let attachment_id = Uuid::new_v4().simple().to_string();
    Ok(AttachmentCredentials {
        job_id: job_id.to_owned(),
        capability_token: capability_token(token, job_id, &attachment_id)?,
        attachment_id,
    })
}

pub fn verify_capability(token: &[u8], job_id: &str, attachment_id: &str, value: &str) -> bool {
    let Ok(actual) = decode_base64(value) else {
        return false;
    };
    let Ok(expected) = attachment_proof(token, job_id, attachment_id) else {
        return false;
    };
    constant_time_equal(&actual, &expected)
}

fn capability_token(
    token: &[u8],
    job_id: &str,
    attachment_id: &str,
) -> Result<String, ProtocolError> {
    attachment_proof(token, job_id, attachment_id)
        .map(|proof| encode_base64(&proof))
        .map_err(|error| ProtocolError::new("INTERNAL_ERROR", error))
}

fn renew_lease(lease: &mut InputLease, duration: Duration) {
    lease.expires_at = Instant::now() + duration;
    lease.expires_at_ms =
        unix_millis().saturating_add(u64::try_from(duration.as_millis()).unwrap_or(u64::MAX));
}

fn lease_result(job_id: &str, lease: &InputLease) -> InputLeaseResult {
    InputLeaseResult {
        job_id: job_id.to_owned(),
        attachment_id: lease.attachment_id.clone(),
        lease_token: lease.lease_token.clone(),
        fence: lease.fence,
        expires_at_ms: lease.expires_at_ms,
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_one_fenced_writer_and_rejects_stale_owner() {
        let mut registry = AttachmentRegistry::new("job".to_owned(), vec![7; 32]);
        let first = registry.open().expect("first attachment");
        let second = registry.open().expect("second attachment");
        let lease = registry
            .acquire_input(&first.attachment_id, &first.capability_token)
            .expect("first lease");

        assert_eq!(lease.fence, 1);
        assert_eq!(
            registry
                .acquire_input(&second.attachment_id, &second.capability_token)
                .expect_err("lease held")
                .code,
            "INPUT_LEASE_HELD"
        );
        registry
            .detach(&first.attachment_id, &first.capability_token)
            .expect("detach");
        let replacement = registry
            .acquire_input(&second.attachment_id, &second.capability_token)
            .expect("replacement lease");
        assert_eq!(replacement.fence, 2);
        assert_eq!(
            registry
                .validate_input(
                    &second.attachment_id,
                    &second.capability_token,
                    &replacement.lease_token,
                    lease.fence,
                )
                .expect_err("stale fence")
                .code,
            "STALE_INPUT_FENCE"
        );
    }

    #[test]
    fn expired_lease_never_authorizes_input() {
        let mut registry = AttachmentRegistry::new("job".to_owned(), vec![7; 32]);
        let attachment = registry.open().expect("attachment");
        let lease = registry
            .acquire_input(&attachment.attachment_id, &attachment.capability_token)
            .expect("lease");
        registry.expire_lease_for_test();

        assert_eq!(
            registry
                .validate_input(
                    &attachment.attachment_id,
                    &attachment.capability_token,
                    &lease.lease_token,
                    lease.fence,
                )
                .expect_err("expired")
                .code,
            "INPUT_LEASE_EXPIRED"
        );
    }

    #[test]
    fn stateless_capability_is_hmac_bound() {
        let token = vec![7; 32];
        let attachment = create_stateless_attachment(&token, "job").expect("attachment");
        assert!(verify_capability(
            &token,
            "job",
            &attachment.attachment_id,
            &attachment.capability_token,
        ));
        assert!(!verify_capability(
            &token,
            "other",
            &attachment.attachment_id,
            &attachment.capability_token,
        ));
    }
}
