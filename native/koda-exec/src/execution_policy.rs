//! Versioned execution-policy, capability, and retained-evidence contracts.
//! Public types stay independent of platform detection and process creation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const EXECUTION_WORKSPACE_MAX_BYTES: usize = 4096;
pub const EXECUTION_SECURITY_MAX_BYTES: usize = 16384;
pub const EXECUTION_SANDBOX_RUNTIME_PATH_MAX_BYTES: usize = 4096;
pub const EXECUTION_SANDBOX_RUNTIME_VERSION_MAX_BYTES: usize = 256;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionPolicyError {
    InvalidExecutionPolicy,
    ExecutionPolicyUnavailable,
    ExecutionPolicyChanged,
    IncompatibleProtocol,
    ExecutionSecurityCorrupt,
}

impl ExecutionPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidExecutionPolicy => "INVALID_EXECUTION_POLICY",
            Self::ExecutionPolicyUnavailable => "EXECUTION_POLICY_UNAVAILABLE",
            Self::ExecutionPolicyChanged => "EXECUTION_POLICY_CHANGED",
            Self::IncompatibleProtocol => "INCOMPATIBLE_PROTOCOL",
            Self::ExecutionSecurityCorrupt => "EXECUTION_SECURITY_CORRUPT",
        }
    }
}

impl std::fmt::Display for ExecutionPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidExecutionPolicy => "Execution policy configuration is invalid.",
            Self::ExecutionPolicyUnavailable => {
                "The selected backend cannot enforce the requested execution policy."
            }
            Self::ExecutionPolicyChanged => "The prepared execution security contract has changed.",
            Self::IncompatibleProtocol => "The executor protocol is incompatible.",
            Self::ExecutionSecurityCorrupt => {
                "Execution security evidence is invalid or inconsistent."
            }
        })
    }
}

impl std::error::Error for ExecutionPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemPolicy {
    Unrestricted,
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Inherit,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessIsolationPolicy {
    Inherit,
    Required,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentPolicy {
    Explicit,
}

// Declaration order is the policy fingerprint's fixed JSON field order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionPolicy {
    pub schema_version: u32,
    pub workspace_root: String,
    pub filesystem: FilesystemPolicy,
    pub network: NetworkPolicy,
    pub process_isolation: ProcessIsolationPolicy,
    pub environment: EnvironmentPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionPolicyConfig {
    pub filesystem: FilesystemPolicy,
    pub network: NetworkPolicy,
    pub process_isolation: ProcessIsolationPolicy,
    pub environment: EnvironmentPolicy,
}

impl ExecutionPolicy {
    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let policy: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        if self.schema_version != 1 || !is_execution_workspace_path(&self.workspace_root) {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
    }

    pub fn digest(&self) -> Result<String, ExecutionPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
}

/// Lexical only: the trusted caller must supply a real, canonical workspace.
/// No host-dependent normalization, Unicode normalization, or case folding.
pub fn is_execution_workspace_path(path: &str) -> bool {
    if path.len() > EXECUTION_WORKSPACE_MAX_BYTES || path.contains('\0') {
        return false;
    }
    if path.starts_with('/') && !path.starts_with("//") {
        return path == "/" || valid_parts(&path[1..].split('/').collect::<Vec<_>>());
    }
    let extended_unc;
    let windows = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        extended_unc = format!(r"\\{rest}");
        extended_unc.as_str()
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        if !is_drive_rooted(rest) {
            return false;
        }
        rest
    } else {
        path
    };
    let parts = if is_drive_rooted(windows) {
        if windows.len() == 3 {
            vec![]
        } else {
            windows[3..].split('\\').collect::<Vec<_>>()
        }
    } else if let Some(rest) = windows.strip_prefix(r"\\") {
        let mut parts: Vec<_> = rest.split('\\').collect();
        if parts.len() == 3 && parts[2].is_empty() {
            parts.pop();
        }
        if parts.len() < 2 {
            return false;
        }
        parts
    } else {
        return false;
    };
    valid_parts(&parts)
        && parts.iter().all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && (b'1'..=b'9').contains(&stem.as_bytes()[3]));
            !reserved
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c <= '\u{001f}' || "<>:\"/|?*".contains(c))
        })
}

fn is_drive_rooted(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn valid_parts(parts: &[&str]) -> bool {
    parts
        .iter()
        .all(|part| !part.is_empty() && *part != "." && *part != "..")
}

/// Explicit typed config wins; otherwise use the supplied env profile, then
/// unconfined. This function never reads ambient process environment.
pub fn resolve_execution_policy(
    workspace_root: &str,
    config: Option<ExecutionPolicyConfig>,
    environment_profile: Option<&str>,
) -> Result<ExecutionPolicy, ExecutionPolicyError> {
    let config = if let Some(config) = config {
        config
    } else {
        let (filesystem, network) = match environment_profile.unwrap_or("unconfined") {
            "unconfined" => (FilesystemPolicy::Unrestricted, NetworkPolicy::Inherit),
            "read-only" => (FilesystemPolicy::ReadOnly, NetworkPolicy::Deny),
            "workspace-write" => (FilesystemPolicy::WorkspaceWrite, NetworkPolicy::Deny),
            _ => return Err(ExecutionPolicyError::InvalidExecutionPolicy),
        };
        ExecutionPolicyConfig {
            filesystem,
            network,
            process_isolation: ProcessIsolationPolicy::Inherit,
            environment: EnvironmentPolicy::Explicit,
        }
    };
    let policy = ExecutionPolicy {
        schema_version: 1,
        workspace_root: workspace_root.into(),
        filesystem: config.filesystem,
        network: config.network,
        process_isolation: config.process_isolation,
        environment: config.environment,
    };
    policy.validate()?;
    Ok(policy)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionBackend {
    NativePosix,
    NativeWindows,
    TypescriptPosix,
    TypescriptWindows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPlatform {
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementMechanism {
    None,
    ExplicitEnvironment,
    MacosSeatbelt,
    LinuxBubblewrap,
    LinuxBubblewrapMountNamespace,
    LinuxNetworkNamespaceSeccomp,
    PosixProcessGroup,
    WindowsJobObject,
    WindowsTaskkillTree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementLayer {
    Application,
    Os,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IsolationCapability<T> {
    pub supported: Vec<T>,
    pub mechanism: EnforcementMechanism,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentCapability {
    pub supported: Vec<EnvironmentPolicy>,
    pub mechanism: EnforcementMechanism,
    pub layer: EnforcementLayer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupervisionCapability {
    pub mechanism: EnforcementMechanism,
    pub layer: EnforcementLayer,
    pub durable: bool,
}

// Declaration order is part of the cross-language capability digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxBubblewrapRuntimeDescriptor {
    pub schema_version: u32,
    pub mechanism: EnforcementMechanism,
    pub canonical_path: String,
    pub device: String,
    pub inode: String,
    pub size: u64,
    pub mtime_ns: String,
    pub sha256: String,
    pub version: String,
    pub probe_revision: u32,
}

impl LinuxBubblewrapRuntimeDescriptor {
    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let descriptor: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let valid = self.schema_version == 1
            && self.mechanism == EnforcementMechanism::LinuxBubblewrap
            && self.canonical_path.starts_with('/')
            && !self.canonical_path.starts_with("//")
            && self.canonical_path.len() <= EXECUTION_SANDBOX_RUNTIME_PATH_MAX_BYTES
            && is_execution_workspace_path(&self.canonical_path)
            && is_canonical_u64_decimal(&self.device)
            && is_canonical_u64_decimal(&self.inode)
            && self.size <= JAVASCRIPT_MAX_SAFE_INTEGER
            && is_canonical_u64_decimal(&self.mtime_ns)
            && is_sha256_hex(&self.sha256)
            && !self.version.is_empty()
            && self.version.len() <= EXECUTION_SANDBOX_RUNTIME_VERSION_MAX_BYTES
            && !self.version.chars().any(char::is_control)
            && self.probe_revision == 1;
        if !valid {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }
}

// Field order (including nested structs) is the capability digest contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionCapabilities {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<ExecutionPlatform>,
    pub backend: ExecutionBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_runtime: Option<LinuxBubblewrapRuntimeDescriptor>,
    pub filesystem: IsolationCapability<FilesystemPolicy>,
    pub network: IsolationCapability<NetworkPolicy>,
    pub process_isolation: IsolationCapability<ProcessIsolationPolicy>,
    pub environment: EnvironmentCapability,
    pub supervision: SupervisionCapability,
}

pub fn execution_supervision(backend: ExecutionBackend) -> SupervisionCapability {
    SupervisionCapability {
        mechanism: match backend {
            ExecutionBackend::NativeWindows => EnforcementMechanism::WindowsJobObject,
            ExecutionBackend::TypescriptWindows => EnforcementMechanism::WindowsTaskkillTree,
            _ => EnforcementMechanism::PosixProcessGroup,
        },
        layer: if backend == ExecutionBackend::TypescriptWindows {
            EnforcementLayer::Application
        } else {
            EnforcementLayer::Os
        },
        durable: matches!(
            backend,
            ExecutionBackend::NativePosix | ExecutionBackend::NativeWindows
        ),
    }
}

pub fn c1_execution_capabilities(backend: ExecutionBackend) -> ExecutionCapabilities {
    ExecutionCapabilities {
        schema_version: 1,
        platform: None,
        backend,
        sandbox_runtime: None,
        filesystem: IsolationCapability {
            supported: vec![FilesystemPolicy::Unrestricted],
            mechanism: EnforcementMechanism::None,
        },
        network: IsolationCapability {
            supported: vec![NetworkPolicy::Inherit],
            mechanism: EnforcementMechanism::None,
        },
        process_isolation: IsolationCapability {
            supported: vec![ProcessIsolationPolicy::Inherit],
            mechanism: EnforcementMechanism::None,
        },
        environment: EnvironmentCapability {
            supported: vec![EnvironmentPolicy::Explicit],
            mechanism: EnforcementMechanism::ExplicitEnvironment,
            layer: EnforcementLayer::Application,
        },
        supervision: execution_supervision(backend),
    }
}

/// Pure Phase 4C2A contract. Runtime advertisement remains gated by the
/// native macOS capability probe introduced in C2A2.
pub fn macos_seatbelt_execution_capabilities() -> ExecutionCapabilities {
    ExecutionCapabilities {
        schema_version: 2,
        platform: Some(ExecutionPlatform::Macos),
        backend: ExecutionBackend::NativePosix,
        sandbox_runtime: None,
        filesystem: IsolationCapability {
            supported: vec![
                FilesystemPolicy::Unrestricted,
                FilesystemPolicy::ReadOnly,
                FilesystemPolicy::WorkspaceWrite,
            ],
            mechanism: EnforcementMechanism::MacosSeatbelt,
        },
        network: IsolationCapability {
            supported: vec![NetworkPolicy::Inherit, NetworkPolicy::Deny],
            mechanism: EnforcementMechanism::MacosSeatbelt,
        },
        process_isolation: IsolationCapability {
            supported: vec![ProcessIsolationPolicy::Inherit],
            mechanism: EnforcementMechanism::None,
        },
        environment: EnvironmentCapability {
            supported: vec![EnvironmentPolicy::Explicit],
            mechanism: EnforcementMechanism::ExplicitEnvironment,
            layer: EnforcementLayer::Application,
        },
        supervision: SupervisionCapability {
            mechanism: EnforcementMechanism::PosixProcessGroup,
            layer: EnforcementLayer::Os,
            durable: true,
        },
    }
}

/// Pure Phase 4C2B contract builder. Runtime advertisement remains disabled
/// until C2B2 proves this exact descriptor through the complete Linux probe.
pub fn linux_bubblewrap_execution_capabilities(
    sandbox_runtime: &LinuxBubblewrapRuntimeDescriptor,
) -> Result<ExecutionCapabilities, ExecutionPolicyError> {
    sandbox_runtime.validate()?;
    Ok(ExecutionCapabilities {
        schema_version: 3,
        platform: Some(ExecutionPlatform::Linux),
        backend: ExecutionBackend::NativePosix,
        sandbox_runtime: Some(sandbox_runtime.clone()),
        filesystem: IsolationCapability {
            supported: vec![
                FilesystemPolicy::Unrestricted,
                FilesystemPolicy::ReadOnly,
                FilesystemPolicy::WorkspaceWrite,
            ],
            mechanism: EnforcementMechanism::LinuxBubblewrapMountNamespace,
        },
        network: IsolationCapability {
            supported: vec![NetworkPolicy::Inherit, NetworkPolicy::Deny],
            mechanism: EnforcementMechanism::LinuxNetworkNamespaceSeccomp,
        },
        process_isolation: IsolationCapability {
            supported: vec![ProcessIsolationPolicy::Inherit],
            mechanism: EnforcementMechanism::None,
        },
        environment: EnvironmentCapability {
            supported: vec![EnvironmentPolicy::Explicit],
            mechanism: EnforcementMechanism::ExplicitEnvironment,
            layer: EnforcementLayer::Application,
        },
        supervision: SupervisionCapability {
            mechanism: EnforcementMechanism::PosixProcessGroup,
            layer: EnforcementLayer::Os,
            durable: true,
        },
    })
}

impl ExecutionCapabilities {
    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let caps: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        caps.validate()?;
        Ok(caps)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let valid = match self.schema_version {
            1 => self == &c1_execution_capabilities(self.backend),
            2 => self == &macos_seatbelt_execution_capabilities(),
            3 => self
                .sandbox_runtime
                .as_ref()
                .and_then(|runtime| linux_bubblewrap_execution_capabilities(runtime).ok())
                .is_some_and(|expected| self == &expected),
            _ => false,
        };
        if !valid {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
    }

    pub fn digest(&self) -> Result<String, ExecutionPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPolicyDimension {
    Filesystem,
    Network,
    ProcessIsolation,
    Environment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnmetReason {
    NotImplemented,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnmetRequirement {
    pub dimension: ExecutionPolicyDimension,
    pub reason: UnmetReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionPolicyEvaluation {
    pub allowed: bool,
    pub unmet: Vec<UnmetRequirement>,
}

pub fn evaluate_execution_policy(
    policy: &ExecutionPolicy,
    caps: &ExecutionCapabilities,
) -> Result<ExecutionPolicyEvaluation, ExecutionPolicyError> {
    policy.validate()?;
    caps.validate()?;
    let mut unmet = vec![];
    for (dimension, supported) in [
        (
            ExecutionPolicyDimension::Filesystem,
            caps.filesystem.supported.contains(&policy.filesystem),
        ),
        (
            ExecutionPolicyDimension::Network,
            caps.network.supported.contains(&policy.network),
        ),
        (
            ExecutionPolicyDimension::ProcessIsolation,
            caps.process_isolation
                .supported
                .contains(&policy.process_isolation),
        ),
        (
            ExecutionPolicyDimension::Environment,
            caps.environment.supported.contains(&policy.environment),
        ),
    ] {
        if !supported {
            unmet.push(UnmetRequirement {
                dimension,
                reason: UnmetReason::NotImplemented,
            });
        }
    }
    Ok(ExecutionPolicyEvaluation {
        allowed: unmet.is_empty(),
        unmet,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionEnforcementEvidence {
    // Empty struct variants enforce deny_unknown_fields; serde unit variants
    // otherwise silently discard fields in internally tagged objects.
    NotRequested {},
    NotApplied {},
    Unknown {},
    Applied {
        mechanism: EnforcementMechanism,
        layer: EnforcementLayer,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionSecurityStage {
    Admission,
    LaunchSetup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySecuritySnapshot {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<ExecutionPlatform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_runtime: Option<LinuxBubblewrapRuntimeDescriptor>,
    pub stage: ExecutionSecurityStage,
    pub policy: ExecutionPolicy,
    pub policy_digest: String,
    pub capabilities_digest: String,
    pub backend: ExecutionBackend,
    pub filesystem: ExecutionEnforcementEvidence,
    pub network: ExecutionEnforcementEvidence,
    pub process_isolation: ExecutionEnforcementEvidence,
    pub environment: ExecutionEnforcementEvidence,
    pub supervision: ExecutionEnforcementEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionSecuritySnapshot {
    Policy(Box<PolicySecuritySnapshot>),
    LegacyUnknown { schema_version: u32 },
}

impl ExecutionSecuritySnapshot {
    /// Validation is required after deserialization: never surface raw serde errors.
    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let snapshot: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::ExecutionSecurityCorrupt)?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let corrupt = ExecutionPolicyError::ExecutionSecurityCorrupt;
        if serde_json::to_vec(self).map_err(|_| corrupt)?.len() > EXECUTION_SECURITY_MAX_BYTES {
            return Err(corrupt);
        }
        let snapshot = match self {
            Self::LegacyUnknown { schema_version: 1 } => return Ok(()),
            Self::LegacyUnknown { .. } => return Err(corrupt),
            Self::Policy(snapshot) => snapshot,
        };
        if snapshot.policy.digest().map_err(|_| corrupt)? != snapshot.policy_digest {
            return Err(corrupt);
        }
        let expected_capabilities = match snapshot.schema_version {
            1 if snapshot.platform.is_none() && snapshot.sandbox_runtime.is_none() => {
                c1_execution_capabilities(snapshot.backend)
            }
            2 if snapshot.platform == Some(ExecutionPlatform::Macos)
                && snapshot.sandbox_runtime.is_none()
                && snapshot.backend == ExecutionBackend::NativePosix =>
            {
                macos_seatbelt_execution_capabilities()
            }
            3 if snapshot.platform == Some(ExecutionPlatform::Linux)
                && snapshot.backend == ExecutionBackend::NativePosix =>
            {
                linux_bubblewrap_execution_capabilities(
                    snapshot.sandbox_runtime.as_ref().ok_or(corrupt)?,
                )
                .map_err(|_| corrupt)?
            }
            _ => return Err(corrupt),
        };
        if expected_capabilities.digest().map_err(|_| corrupt)? != snapshot.capabilities_digest {
            return Err(corrupt);
        }
        if snapshot.schema_version == 2 {
            return validate_macos_snapshot(snapshot);
        }
        if snapshot.schema_version == 3 {
            return validate_linux_snapshot(snapshot);
        }
        for (evidence, requested) in [
            (
                &snapshot.filesystem,
                snapshot.policy.filesystem != FilesystemPolicy::Unrestricted,
            ),
            (
                &snapshot.network,
                snapshot.policy.network != NetworkPolicy::Inherit,
            ),
            (
                &snapshot.process_isolation,
                snapshot.policy.process_isolation != ProcessIsolationPolicy::Inherit,
            ),
        ] {
            let valid = if requested {
                matches!(
                    evidence,
                    ExecutionEnforcementEvidence::NotApplied {}
                        | ExecutionEnforcementEvidence::Unknown {}
                )
            } else {
                matches!(evidence, ExecutionEnforcementEvidence::NotRequested {})
            };
            if !valid {
                return Err(corrupt);
            }
        }
        let supervision = execution_supervision(snapshot.backend);
        for (evidence, expected_mechanism, expected_layer) in [
            (
                &snapshot.environment,
                EnforcementMechanism::ExplicitEnvironment,
                EnforcementLayer::Application,
            ),
            (
                &snapshot.supervision,
                supervision.mechanism,
                supervision.layer,
            ),
        ] {
            match evidence {
                ExecutionEnforcementEvidence::NotRequested {} => return Err(corrupt),
                ExecutionEnforcementEvidence::Applied { mechanism, layer }
                    if snapshot.stage != ExecutionSecurityStage::LaunchSetup
                        || *mechanism != expected_mechanism
                        || *layer != expected_layer =>
                {
                    return Err(corrupt);
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn validate_macos_snapshot(snapshot: &PolicySecuritySnapshot) -> Result<(), ExecutionPolicyError> {
    let corrupt = ExecutionPolicyError::ExecutionSecurityCorrupt;
    for (evidence, requested) in [
        (
            &snapshot.filesystem,
            snapshot.policy.filesystem != FilesystemPolicy::Unrestricted,
        ),
        (
            &snapshot.network,
            snapshot.policy.network != NetworkPolicy::Inherit,
        ),
    ] {
        let valid = if !requested {
            matches!(evidence, ExecutionEnforcementEvidence::NotRequested {})
        } else {
            match evidence {
                ExecutionEnforcementEvidence::Unknown {} => true,
                ExecutionEnforcementEvidence::NotApplied {} => {
                    snapshot.stage == ExecutionSecurityStage::Admission
                }
                ExecutionEnforcementEvidence::Applied { mechanism, layer } => {
                    snapshot.stage == ExecutionSecurityStage::LaunchSetup
                        && *mechanism == EnforcementMechanism::MacosSeatbelt
                        && *layer == EnforcementLayer::Os
                }
                ExecutionEnforcementEvidence::NotRequested {} => false,
            }
        };
        if !valid {
            return Err(corrupt);
        }
    }
    if !matches!(
        snapshot.process_isolation,
        ExecutionEnforcementEvidence::NotRequested {}
    ) {
        return Err(corrupt);
    }
    for (evidence, expected_mechanism, expected_layer) in [
        (
            &snapshot.environment,
            EnforcementMechanism::ExplicitEnvironment,
            EnforcementLayer::Application,
        ),
        (
            &snapshot.supervision,
            EnforcementMechanism::PosixProcessGroup,
            EnforcementLayer::Os,
        ),
    ] {
        match evidence {
            ExecutionEnforcementEvidence::NotRequested {} => return Err(corrupt),
            ExecutionEnforcementEvidence::Applied { mechanism, layer }
                if snapshot.stage != ExecutionSecurityStage::LaunchSetup
                    || *mechanism != expected_mechanism
                    || *layer != expected_layer =>
            {
                return Err(corrupt);
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_linux_snapshot(snapshot: &PolicySecuritySnapshot) -> Result<(), ExecutionPolicyError> {
    let corrupt = ExecutionPolicyError::ExecutionSecurityCorrupt;
    for (evidence, requested, expected_mechanism) in [
        (
            &snapshot.filesystem,
            snapshot.policy.filesystem != FilesystemPolicy::Unrestricted,
            EnforcementMechanism::LinuxBubblewrapMountNamespace,
        ),
        (
            &snapshot.network,
            snapshot.policy.network != NetworkPolicy::Inherit,
            EnforcementMechanism::LinuxNetworkNamespaceSeccomp,
        ),
    ] {
        let valid = if !requested {
            matches!(evidence, ExecutionEnforcementEvidence::NotRequested {})
        } else {
            match evidence {
                ExecutionEnforcementEvidence::Unknown {} => true,
                ExecutionEnforcementEvidence::NotApplied {} => {
                    snapshot.stage == ExecutionSecurityStage::Admission
                }
                ExecutionEnforcementEvidence::Applied { mechanism, layer } => {
                    snapshot.stage == ExecutionSecurityStage::LaunchSetup
                        && *mechanism == expected_mechanism
                        && *layer == EnforcementLayer::Os
                }
                ExecutionEnforcementEvidence::NotRequested {} => false,
            }
        };
        if !valid {
            return Err(corrupt);
        }
    }
    if !matches!(
        snapshot.process_isolation,
        ExecutionEnforcementEvidence::NotRequested {}
    ) {
        return Err(corrupt);
    }
    for (evidence, expected_mechanism, expected_layer) in [
        (
            &snapshot.environment,
            EnforcementMechanism::ExplicitEnvironment,
            EnforcementLayer::Application,
        ),
        (
            &snapshot.supervision,
            EnforcementMechanism::PosixProcessGroup,
            EnforcementLayer::Os,
        ),
    ] {
        match evidence {
            ExecutionEnforcementEvidence::NotRequested {} => return Err(corrupt),
            ExecutionEnforcementEvidence::Applied { mechanism, layer }
                if snapshot.stage != ExecutionSecurityStage::LaunchSetup
                    || *mechanism != expected_mechanism
                    || *layer != expected_layer =>
            {
                return Err(corrupt);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Admission is not launch evidence: no applied claims are generated here.
pub fn create_execution_admission_snapshot(
    policy: &ExecutionPolicy,
    caps: &ExecutionCapabilities,
) -> Result<ExecutionSecuritySnapshot, ExecutionPolicyError> {
    if !evaluate_execution_policy(policy, caps)?.allowed {
        return Err(ExecutionPolicyError::ExecutionPolicyUnavailable);
    }
    let snapshot = ExecutionSecuritySnapshot::Policy(Box::new(PolicySecuritySnapshot {
        schema_version: caps.schema_version,
        platform: caps.platform,
        sandbox_runtime: caps.sandbox_runtime.clone(),
        stage: ExecutionSecurityStage::Admission,
        policy: policy.clone(),
        policy_digest: policy.digest()?,
        capabilities_digest: caps.digest()?,
        backend: caps.backend,
        filesystem: if policy.filesystem == FilesystemPolicy::Unrestricted {
            ExecutionEnforcementEvidence::NotRequested {}
        } else {
            ExecutionEnforcementEvidence::NotApplied {}
        },
        network: if policy.network == NetworkPolicy::Inherit {
            ExecutionEnforcementEvidence::NotRequested {}
        } else {
            ExecutionEnforcementEvidence::NotApplied {}
        },
        process_isolation: ExecutionEnforcementEvidence::NotRequested {},
        environment: ExecutionEnforcementEvidence::NotApplied {},
        supervision: ExecutionEnforcementEvidence::NotApplied {},
    }));
    snapshot.validate()?;
    Ok(snapshot)
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn is_canonical_u64_decimal(value: &str) -> bool {
    value
        .parse::<u64>()
        .is_ok_and(|parsed| parsed.to_string() == value)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests;
