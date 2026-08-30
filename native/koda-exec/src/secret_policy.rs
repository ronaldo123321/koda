//! Value-free secret declarations and public lifecycle evidence.
//! Runtime resolution and injection remain disabled until Phase 4C3B/C3C.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const EXECUTION_SECRET_SCHEMA_VERSION: u32 = 1;
pub const EXECUTION_SECRET_MAX_DECLARATIONS: usize = 32;
pub const EXECUTION_SECRET_MAX_SELECTION: usize = 16;
pub const EXECUTION_SECRET_ALIAS_MAX_BYTES: usize = 64;
pub const EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES: usize = 128;
pub const EXECUTION_SECRET_VALUE_MIN_BYTES: usize = 8;
pub const EXECUTION_SECRET_VALUE_MAX_BYTES: usize = 8 * 1024;
pub const EXECUTION_SECRET_VALUES_MAX_BYTES: usize = 64 * 1024;
pub const EXECUTION_SECRET_LEASE_MIN_MS: u64 = 1_000;
pub const EXECUTION_SECRET_LEASE_MAX_MS: u64 = 5 * 60 * 1_000;
pub const EXECUTION_SECRET_EVIDENCE_MAX_BYTES: usize = 16_384;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretPolicyError {
    InvalidSecretDeclaration,
    SecretAliasNotConfigured,
    SecretValueUnavailable,
    SecretValueInvalid,
    SecretLeaseExpired,
    SecretPolicyUnavailable,
    SecretPolicyChanged,
    SecretReauthRequired,
    SecretInjectionFailed,
    SecretRedactionFailed,
    SecretCleanupFailed,
    SecretEvidenceCorrupt,
}

impl SecretPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSecretDeclaration => "INVALID_SECRET_DECLARATION",
            Self::SecretAliasNotConfigured => "SECRET_ALIAS_NOT_CONFIGURED",
            Self::SecretValueUnavailable => "SECRET_VALUE_UNAVAILABLE",
            Self::SecretValueInvalid => "SECRET_VALUE_INVALID",
            Self::SecretLeaseExpired => "SECRET_LEASE_EXPIRED",
            Self::SecretPolicyUnavailable => "SECRET_POLICY_UNAVAILABLE",
            Self::SecretPolicyChanged => "SECRET_POLICY_CHANGED",
            Self::SecretReauthRequired => "SECRET_REAUTH_REQUIRED",
            Self::SecretInjectionFailed => "SECRET_INJECTION_FAILED",
            Self::SecretRedactionFailed => "SECRET_REDACTION_FAILED",
            Self::SecretCleanupFailed => "SECRET_CLEANUP_FAILED",
            Self::SecretEvidenceCorrupt => "SECRET_EVIDENCE_CORRUPT",
        }
    }
}

impl std::fmt::Display for SecretPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidSecretDeclaration => "Secret declaration configuration is invalid.",
            Self::SecretAliasNotConfigured => "The requested secret alias is not configured.",
            Self::SecretValueUnavailable => "A requested secret value is unavailable.",
            Self::SecretValueInvalid => "A requested secret value is invalid.",
            Self::SecretLeaseExpired => "The secret lease expired before execution.",
            Self::SecretPolicyUnavailable => {
                "The selected backend cannot enforce the requested secret policy."
            }
            Self::SecretPolicyChanged => "The prepared secret contract has changed.",
            Self::SecretReauthRequired => "The secret must be resolved and approved again.",
            Self::SecretInjectionFailed => "The secret could not be injected safely.",
            Self::SecretRedactionFailed => "Command output could not be redacted safely.",
            Self::SecretCleanupFailed => "Secret cleanup could not be confirmed.",
            Self::SecretEvidenceCorrupt => "Secret execution evidence is invalid or inconsistent.",
        })
    }
}

impl std::error::Error for SecretPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretTool {
    ExecCommand,
    ExecTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretSourceKind {
    HostEnv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretTargetKind {
    FileEnv,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretSource {
    pub kind: SecretSourceKind,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretTarget {
    pub kind: SecretTargetKind,
    pub name: String,
}

// Declaration order is the value-free fingerprint's fixed JSON field order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretDeclaration {
    pub schema_version: u32,
    pub alias: String,
    pub source: SecretSource,
    pub target: SecretTarget,
    pub tools: Vec<SecretTool>,
    pub lease_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretCatalog {
    pub schema_version: u32,
    pub declarations: Vec<SecretDeclaration>,
}

impl SecretCatalog {
    pub fn parse(value: Value) -> Result<Self, SecretPolicyError> {
        let mut catalog: Self = serde_json::from_value(value)
            .map_err(|_| SecretPolicyError::InvalidSecretDeclaration)?;
        catalog.validate()?;
        for declaration in &mut catalog.declarations {
            declaration.tools.sort();
        }
        catalog
            .declarations
            .sort_by(|left, right| left.alias.cmp(&right.alias));
        Ok(catalog)
    }

    pub fn validate(&self) -> Result<(), SecretPolicyError> {
        let invalid = SecretPolicyError::InvalidSecretDeclaration;
        if self.schema_version != EXECUTION_SECRET_SCHEMA_VERSION
            || self.declarations.len() > EXECUTION_SECRET_MAX_DECLARATIONS
        {
            return Err(invalid);
        }
        let mut aliases = HashSet::new();
        let mut targets = HashSet::new();
        for declaration in &self.declarations {
            if declaration.schema_version != EXECUTION_SECRET_SCHEMA_VERSION
                || !valid_secret_alias(&declaration.alias)
                || !valid_host_environment_name(&declaration.source.name)
                || !valid_secret_file_environment_name(&declaration.target.name)
                || declaration.tools.is_empty()
                || declaration.tools.len() > 2
                || declaration.lease_ms < EXECUTION_SECRET_LEASE_MIN_MS
                || declaration.lease_ms > EXECUTION_SECRET_LEASE_MAX_MS
                || !aliases.insert(declaration.alias.as_str())
                || !targets.insert(declaration.target.name.as_str())
            {
                return Err(invalid);
            }
            let unique_tools: HashSet<_> = declaration.tools.iter().collect();
            if unique_tools.len() != declaration.tools.len() {
                return Err(invalid);
            }
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, SecretPolicyError> {
        let normalized = Self::parse(
            serde_json::to_value(self).map_err(|_| SecretPolicyError::InvalidSecretDeclaration)?,
        )?;
        serde_json::to_string(&normalized).map_err(|_| SecretPolicyError::InvalidSecretDeclaration)
    }

    pub fn digest(&self) -> Result<String, SecretPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretLifecycle {
    Resolved,
    Injected,
    Expired,
    Destroyed,
    CleanupPending,
    CleanupFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretCleanup {
    NotStarted,
    Pending,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretPublicTarget {
    pub alias: String,
    pub environment_variable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretRedactionCounts {
    pub stdout: u64,
    pub stderr: u64,
    pub pty: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretExecutionEvidence {
    pub schema_version: u32,
    pub declaration_digest: String,
    pub lease_id: String,
    pub aliases: Vec<String>,
    pub targets: Vec<SecretPublicTarget>,
    pub lifecycle: SecretLifecycle,
    pub expires_at_ms: u64,
    pub redactions: SecretRedactionCounts,
    pub cleanup: SecretCleanup,
}

/// Value-bearing lease transported only across the authenticated start and
/// Supervisor/Worker control exchanges. This type must never be embedded in a
/// durable record or diagnostic payload.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SecretLeaseEnvelope {
    pub evidence: SecretExecutionEvidence,
    pub values: Vec<Vec<u8>>,
}

impl std::fmt::Debug for SecretLeaseEnvelope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SecretLeaseEnvelope")
            .field("evidence", &self.evidence)
            .field("value_count", &self.values.len())
            .finish()
    }
}

impl SecretLeaseEnvelope {
    pub fn validate_resolved(&self, now_ms: u64) -> Result<(), SecretPolicyError> {
        self.evidence.validate()?;
        if self.evidence.lifecycle != SecretLifecycle::Resolved
            || self.evidence.cleanup != SecretCleanup::NotStarted
            || self.evidence.redactions
                != (SecretRedactionCounts {
                    stdout: 0,
                    stderr: 0,
                    pty: 0,
                })
            || self.values.len() != self.evidence.aliases.len()
        {
            return Err(SecretPolicyError::SecretEvidenceCorrupt);
        }
        if self.evidence.expires_at_ms <= now_ms {
            return Err(SecretPolicyError::SecretLeaseExpired);
        }
        let mut total = 0usize;
        for (index, value) in self.values.iter().enumerate() {
            total = total
                .checked_add(value.len())
                .ok_or(SecretPolicyError::SecretValueInvalid)?;
            if !(EXECUTION_SECRET_VALUE_MIN_BYTES..=EXECUTION_SECRET_VALUE_MAX_BYTES)
                .contains(&value.len())
                || total > EXECUTION_SECRET_VALUES_MAX_BYTES
                || self.values[..index]
                    .iter()
                    .any(|previous| previous == value)
            {
                return Err(SecretPolicyError::SecretValueInvalid);
            }
        }
        Ok(())
    }

    pub fn public_evidence(&self) -> SecretExecutionEvidence {
        self.evidence.clone()
    }

    pub fn destroy(&mut self) {
        for value in &mut self.values {
            value.fill(0);
        }
    }
}

impl Drop for SecretLeaseEnvelope {
    fn drop(&mut self) {
        self.destroy();
    }
}

impl SecretExecutionEvidence {
    pub fn parse(value: Value) -> Result<Self, SecretPolicyError> {
        let evidence: Self =
            serde_json::from_value(value).map_err(|_| SecretPolicyError::SecretEvidenceCorrupt)?;
        evidence.validate()?;
        Ok(evidence)
    }

    pub fn validate(&self) -> Result<(), SecretPolicyError> {
        let invalid = SecretPolicyError::SecretEvidenceCorrupt;
        if self.schema_version != EXECUTION_SECRET_SCHEMA_VERSION
            || !is_sha256_hex(&self.declaration_digest)
            || !is_lower_hex(&self.lease_id, 32)
            || self.aliases.is_empty()
            || self.aliases.len() > EXECUTION_SECRET_MAX_SELECTION
            || self.targets.len() != self.aliases.len()
            || self.expires_at_ms == 0
            || self.expires_at_ms > JAVASCRIPT_MAX_SAFE_INTEGER
            || [
                self.redactions.stdout,
                self.redactions.stderr,
                self.redactions.pty,
            ]
            .into_iter()
            .any(|count| count > JAVASCRIPT_MAX_SAFE_INTEGER)
        {
            return Err(invalid);
        }
        if !self.aliases.iter().all(|alias| valid_secret_alias(alias))
            || !self.aliases.windows(2).all(|pair| pair[0] < pair[1])
        {
            return Err(invalid);
        }
        let mut target_names = HashSet::new();
        for (alias, target) in self.aliases.iter().zip(&self.targets) {
            if target.alias != *alias
                || !valid_secret_file_environment_name(&target.environment_variable)
                || !target_names.insert(target.environment_variable.as_str())
            {
                return Err(invalid);
            }
        }
        let expected_cleanup = match self.lifecycle {
            SecretLifecycle::Resolved => SecretCleanup::NotStarted,
            SecretLifecycle::Injected => SecretCleanup::Pending,
            SecretLifecycle::Expired | SecretLifecycle::Destroyed => SecretCleanup::Completed,
            SecretLifecycle::CleanupPending => SecretCleanup::Pending,
            SecretLifecycle::CleanupFailed => SecretCleanup::Failed,
        };
        if self.cleanup != expected_cleanup {
            return Err(invalid);
        }
        let bytes = serde_json::to_vec(self).map_err(|_| invalid)?.len();
        if bytes > EXECUTION_SECRET_EVIDENCE_MAX_BYTES {
            return Err(invalid);
        }
        Ok(())
    }
}

pub fn normalize_secret_selection(aliases: Vec<String>) -> Result<Vec<String>, SecretPolicyError> {
    if aliases.len() > EXECUTION_SECRET_MAX_SELECTION
        || !aliases.iter().all(|alias| valid_secret_alias(alias))
        || aliases.iter().collect::<HashSet<_>>().len() != aliases.len()
    {
        return Err(SecretPolicyError::InvalidSecretDeclaration);
    }
    let mut normalized = aliases;
    normalized.sort();
    Ok(normalized)
}

fn valid_secret_alias(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= EXECUTION_SECRET_ALIAS_MAX_BYTES
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(byte))
}

fn valid_host_environment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

fn valid_secret_file_environment_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !value.starts_with("KODA_")
        && value.ends_with("_FILE")
        && bytes.len() <= EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES
        && bytes.first().is_some_and(u8::is_ascii_uppercase)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn is_sha256_hex(value: &str) -> bool {
    is_lower_hex(value, 64)
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/testkit/fixtures/execution-secrets-v1.json"
        )))
        .unwrap()
    }

    #[test]
    fn shared_catalog_bytes_and_digests_match() {
        for case in fixtures()["catalog_cases"].as_array().unwrap() {
            let catalog = SecretCatalog::parse(case["input"].clone()).unwrap();
            assert_eq!(
                catalog.canonical_json().unwrap(),
                case["canonical"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                catalog.digest().unwrap(),
                case["sha256"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn shared_invalid_catalogs_and_evidence_fail_closed() {
        for case in fixtures()["invalid_catalog_cases"].as_array().unwrap() {
            assert_eq!(
                SecretCatalog::parse(case["input"].clone()).unwrap_err(),
                SecretPolicyError::InvalidSecretDeclaration,
                "{}",
                case["name"]
            );
        }
        for case in fixtures()["evidence_cases"].as_array().unwrap() {
            let result = SecretExecutionEvidence::parse(case["input"].clone());
            if case["valid"].as_bool().unwrap() {
                result.unwrap();
            } else {
                assert_eq!(
                    result.unwrap_err(),
                    SecretPolicyError::SecretEvidenceCorrupt,
                    "{}",
                    case["name"]
                );
            }
        }
        let error = SecretCatalog::parse(json!({
            "schema_version": 1,
            "declarations": [{ "secret": "fixture-secret-marker" }]
        }))
        .unwrap_err();
        assert!(!error.to_string().contains("fixture-secret-marker"));
    }

    #[test]
    fn all_error_codes_are_stable_and_messages_do_not_echo_values() {
        let errors = [
            SecretPolicyError::InvalidSecretDeclaration,
            SecretPolicyError::SecretAliasNotConfigured,
            SecretPolicyError::SecretValueUnavailable,
            SecretPolicyError::SecretValueInvalid,
            SecretPolicyError::SecretLeaseExpired,
            SecretPolicyError::SecretPolicyUnavailable,
            SecretPolicyError::SecretPolicyChanged,
            SecretPolicyError::SecretReauthRequired,
            SecretPolicyError::SecretInjectionFailed,
            SecretPolicyError::SecretRedactionFailed,
            SecretPolicyError::SecretCleanupFailed,
            SecretPolicyError::SecretEvidenceCorrupt,
        ];
        let mut codes = HashSet::new();
        for error in errors {
            assert!(codes.insert(error.code()));
            assert!(!error.to_string().contains("fixture-secret-marker"));
        }
        let fixture = fixtures();
        let expected = fixture["error_codes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(codes, expected.iter().copied().collect());
    }

    #[test]
    fn shared_resource_limits_match_typescript() {
        let fixture = fixtures();
        let limits = &fixture["limits"];
        assert_eq!(
            limits["max_declarations"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_MAX_DECLARATIONS
        );
        assert_eq!(
            limits["max_selection"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_MAX_SELECTION
        );
        assert_eq!(
            limits["alias_max_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_ALIAS_MAX_BYTES
        );
        assert_eq!(
            limits["environment_name_max_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES
        );
        assert_eq!(
            limits["value_min_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_VALUE_MIN_BYTES
        );
        assert_eq!(
            limits["value_max_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_VALUE_MAX_BYTES
        );
        assert_eq!(
            limits["values_max_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_VALUES_MAX_BYTES
        );
        assert_eq!(
            limits["lease_min_ms"].as_u64().unwrap(),
            EXECUTION_SECRET_LEASE_MIN_MS
        );
        assert_eq!(
            limits["lease_max_ms"].as_u64().unwrap(),
            EXECUTION_SECRET_LEASE_MAX_MS
        );
        assert_eq!(
            limits["evidence_max_bytes"].as_u64().unwrap() as usize,
            EXECUTION_SECRET_EVIDENCE_MAX_BYTES
        );
    }
}
