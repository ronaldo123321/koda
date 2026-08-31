//! Versioned execution-policy, capability, and retained-evidence contracts.
//! Public types stay independent of platform detection and process creation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const EXECUTION_WORKSPACE_MAX_BYTES: usize = 4096;
pub const EXECUTION_SECURITY_MAX_BYTES: usize = 16384;
pub const EXECUTION_SANDBOX_RUNTIME_PATH_MAX_BYTES: usize = 4096;
pub const EXECUTION_SANDBOX_RUNTIME_VERSION_MAX_BYTES: usize = 256;
pub const EXECUTION_RESOURCE_LIMIT_MAX: u64 = 9_007_199_254_740_991;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = EXECUTION_RESOURCE_LIMIT_MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionPolicyError {
    InvalidExecutionPolicy,
    ExecutionPolicyUnavailable,
    ResourceLimitUnavailable,
    ExecutionPolicyChanged,
    IncompatibleProtocol,
    ExecutionSecurityCorrupt,
}

impl ExecutionPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidExecutionPolicy => "INVALID_EXECUTION_POLICY",
            Self::ExecutionPolicyUnavailable => "EXECUTION_POLICY_UNAVAILABLE",
            Self::ResourceLimitUnavailable => "RESOURCE_LIMIT_UNAVAILABLE",
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
            Self::ResourceLimitUnavailable => {
                "The selected backend cannot enforce the requested resource limit."
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionResourceLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_cpu_time_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_address_space_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_process_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_open_files: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_file_size_bytes: Option<u64>,
}

impl ExecutionResourceLimits {
    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let limits: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        limits.validate()?;
        Ok(limits)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        if self
            .values()
            .into_iter()
            .flatten()
            .any(|value| *value == 0 || *value > EXECUTION_RESOURCE_LIMIT_MAX)
        {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.values().into_iter().all(|value| value.is_none())
    }

    fn values(&self) -> [Option<&u64>; 5] {
        [
            self.process_cpu_time_ms.as_ref(),
            self.process_address_space_bytes.as_ref(),
            self.job_process_count.as_ref(),
            self.process_open_files.as_ref(),
            self.process_file_size_bytes.as_ref(),
        ]
    }

    pub fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
    }

    pub fn digest(&self) -> Result<String, ExecutionPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ExecutionResourceLimits>,
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
        let mut policy: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        if policy
            .resources
            .as_ref()
            .is_some_and(ExecutionResourceLimits::is_empty)
        {
            policy.resources = None;
        }
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let version_valid = match self.schema_version {
            1 => self.resources.is_none(),
            2 => self
                .resources
                .as_ref()
                .is_none_or(|resources| resources.validate().is_ok()),
            _ => false,
        };
        if !version_valid || !is_execution_workspace_path(&self.workspace_root) {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        let mut normalized = self.clone();
        if normalized
            .resources
            .as_ref()
            .is_some_and(ExecutionResourceLimits::is_empty)
        {
            normalized.resources = None;
        }
        serde_json::to_string(&normalized).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
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
        resources: None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceLimitBackend {
    PosixRlimit,
    LinuxCgroupV2,
    WindowsJobObject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceLimitScope {
    Process,
    JobTree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceLimitEnforcement {
    KernelHard,
    KernelAccountedHard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceLimitCapability {
    Unsupported {},
    Supported {
        backend: ResourceLimitBackend,
        scope: ResourceLimitScope,
        enforcement: ResourceLimitEnforcement,
        granularity: u64,
    },
}

impl ResourceLimitCapability {
    fn validate(&self) -> Result<(), ExecutionPolicyError> {
        if let Self::Supported { granularity, .. } = self
            && (*granularity == 0 || *granularity > EXECUTION_RESOURCE_LIMIT_MAX)
        {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionResourceCapabilities {
    pub process_cpu_time_ms: ResourceLimitCapability,
    pub process_address_space_bytes: ResourceLimitCapability,
    pub job_process_count: ResourceLimitCapability,
    pub process_open_files: ResourceLimitCapability,
    pub process_file_size_bytes: ResourceLimitCapability,
}

impl ExecutionResourceCapabilities {
    pub fn unsupported() -> Self {
        Self {
            process_cpu_time_ms: ResourceLimitCapability::Unsupported {},
            process_address_space_bytes: ResourceLimitCapability::Unsupported {},
            job_process_count: ResourceLimitCapability::Unsupported {},
            process_open_files: ResourceLimitCapability::Unsupported {},
            process_file_size_bytes: ResourceLimitCapability::Unsupported {},
        }
    }

    pub fn validate(&self) -> Result<(), ExecutionPolicyError> {
        for capability in self.values() {
            capability.validate()?;
        }
        Ok(())
    }

    pub fn parse(value: Value) -> Result<Self, ExecutionPolicyError> {
        let capabilities: Self = serde_json::from_value(value)
            .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
        capabilities.validate()?;
        Ok(capabilities)
    }

    fn values(&self) -> [&ResourceLimitCapability; 5] {
        [
            &self.process_cpu_time_ms,
            &self.process_address_space_bytes,
            &self.job_process_count,
            &self.process_open_files,
            &self.process_file_size_bytes,
        ]
    }

    pub fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
    }

    pub fn digest(&self) -> Result<String, ExecutionPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<ExecutionResourceCapabilities>,
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
        resource_limits: None,
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
        resource_limits: None,
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
        resource_limits: None,
    })
}

pub fn resource_contract_execution_capabilities(
    legacy: &ExecutionCapabilities,
) -> Result<ExecutionCapabilities, ExecutionPolicyError> {
    legacy.validate()?;
    if legacy.schema_version == 4 {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let mut capabilities = legacy.clone();
    capabilities.schema_version = 4;
    capabilities.resource_limits = Some(ExecutionResourceCapabilities::unsupported());
    capabilities.validate()?;
    Ok(capabilities)
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
            4 => {
                let legacy_version = match (self.platform, self.sandbox_runtime.as_ref()) {
                    (None, None) => Some(1),
                    (Some(ExecutionPlatform::Macos), None) => Some(2),
                    (Some(ExecutionPlatform::Linux), Some(_)) => Some(3),
                    _ => None,
                };
                legacy_version.is_some_and(|schema_version| {
                    let mut legacy = self.clone();
                    legacy.schema_version = schema_version;
                    legacy.resource_limits = None;
                    legacy.validate().is_ok()
                        && self.resource_limits
                            == Some(ExecutionResourceCapabilities::unsupported())
                })
            }
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
    ProcessCpuTimeMs,
    ProcessAddressSpaceBytes,
    JobProcessCount,
    ProcessOpenFiles,
    ProcessFileSizeBytes,
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
    if policy.schema_version == 2 {
        let resources = policy.resources.as_ref();
        let capabilities = caps.resource_limits.as_ref();
        for (dimension, requested, supported) in [
            (
                ExecutionPolicyDimension::ProcessCpuTimeMs,
                resources
                    .and_then(|value| value.process_cpu_time_ms)
                    .is_some(),
                capabilities.is_some_and(|value| {
                    matches!(
                        value.process_cpu_time_ms,
                        ResourceLimitCapability::Supported { .. }
                    )
                }),
            ),
            (
                ExecutionPolicyDimension::ProcessAddressSpaceBytes,
                resources
                    .and_then(|value| value.process_address_space_bytes)
                    .is_some(),
                capabilities.is_some_and(|value| {
                    matches!(
                        value.process_address_space_bytes,
                        ResourceLimitCapability::Supported { .. }
                    )
                }),
            ),
            (
                ExecutionPolicyDimension::JobProcessCount,
                resources
                    .and_then(|value| value.job_process_count)
                    .is_some(),
                capabilities.is_some_and(|value| {
                    matches!(
                        value.job_process_count,
                        ResourceLimitCapability::Supported { .. }
                    )
                }),
            ),
            (
                ExecutionPolicyDimension::ProcessOpenFiles,
                resources
                    .and_then(|value| value.process_open_files)
                    .is_some(),
                capabilities.is_some_and(|value| {
                    matches!(
                        value.process_open_files,
                        ResourceLimitCapability::Supported { .. }
                    )
                }),
            ),
            (
                ExecutionPolicyDimension::ProcessFileSizeBytes,
                resources
                    .and_then(|value| value.process_file_size_bytes)
                    .is_some(),
                capabilities.is_some_and(|value| {
                    matches!(
                        value.process_file_size_bytes,
                        ResourceLimitCapability::Supported { .. }
                    )
                }),
            ),
        ] {
            if requested && !supported {
                unmet.push(UnmetRequirement {
                    dimension,
                    reason: UnmetReason::NotImplemented,
                });
            }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceAppliedLimit {
    pub limit: u64,
    pub backend: ResourceLimitBackend,
    pub scope: ResourceLimitScope,
    pub enforcement: ResourceLimitEnforcement,
    pub granularity: u64,
}

impl ResourceAppliedLimit {
    fn validate(&self) -> Result<(), ExecutionPolicyError> {
        if self.limit == 0
            || self.limit > EXECUTION_RESOURCE_LIMIT_MAX
            || self.granularity == 0
            || self.granularity > EXECUTION_RESOURCE_LIMIT_MAX
        {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionResourceAppliedLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_cpu_time_ms: Option<ResourceAppliedLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_address_space_bytes: Option<ResourceAppliedLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_process_count: Option<ResourceAppliedLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_open_files: Option<ResourceAppliedLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_file_size_bytes: Option<ResourceAppliedLimit>,
}

impl ExecutionResourceAppliedLimits {
    fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let values = [
            self.process_cpu_time_ms.as_ref(),
            self.process_address_space_bytes.as_ref(),
            self.job_process_count.as_ref(),
            self.process_open_files.as_ref(),
            self.process_file_size_bytes.as_ref(),
        ];
        if values.iter().all(|value| value.is_none()) {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        for value in values.into_iter().flatten() {
            value.validate()?;
        }
        Ok(())
    }

    fn canonical_json(&self) -> Result<String, ExecutionPolicyError> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)
    }

    fn digest(&self) -> Result<String, ExecutionPolicyError> {
        Ok(sha256(&self.canonical_json()?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutionResourceEvidence {
    NotRequested {},
    NotApplied {
        requested: ExecutionResourceLimits,
        requested_digest: String,
        available: ExecutionResourceCapabilities,
        available_digest: String,
    },
    Unknown {
        requested: ExecutionResourceLimits,
        requested_digest: String,
        available: ExecutionResourceCapabilities,
        available_digest: String,
    },
    Applied {
        requested: ExecutionResourceLimits,
        requested_digest: String,
        available: ExecutionResourceCapabilities,
        available_digest: String,
        applied: ExecutionResourceAppliedLimits,
        applied_digest: String,
    },
}

impl ExecutionResourceEvidence {
    fn validate(&self) -> Result<(), ExecutionPolicyError> {
        let validate_layers = |requested: &ExecutionResourceLimits,
                               requested_digest: &str,
                               available: &ExecutionResourceCapabilities,
                               available_digest: &str|
         -> Result<(), ExecutionPolicyError> {
            requested.validate()?;
            available.validate()?;
            if requested.is_empty()
                || requested.digest()? != requested_digest
                || available.digest()? != available_digest
            {
                return Err(ExecutionPolicyError::InvalidExecutionPolicy);
            }
            Ok(())
        };
        match self {
            Self::NotRequested {} => Ok(()),
            Self::NotApplied {
                requested,
                requested_digest,
                available,
                available_digest,
            }
            | Self::Unknown {
                requested,
                requested_digest,
                available,
                available_digest,
            } => validate_layers(requested, requested_digest, available, available_digest),
            Self::Applied {
                requested,
                requested_digest,
                available,
                available_digest,
                applied,
                applied_digest,
            } => {
                validate_layers(requested, requested_digest, available, available_digest)?;
                if applied.digest()? != applied_digest.as_str() {
                    return Err(ExecutionPolicyError::InvalidExecutionPolicy);
                }
                Ok(())
            }
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ExecutionResourceEvidence>,
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
        if (snapshot.schema_version <= 3 && snapshot.policy.schema_version != 1)
            || (snapshot.schema_version == 4 && snapshot.policy.schema_version != 2)
        {
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
            4 => {
                let legacy = match (snapshot.platform, snapshot.sandbox_runtime.as_ref()) {
                    (None, None) => c1_execution_capabilities(snapshot.backend),
                    (Some(ExecutionPlatform::Macos), None)
                        if snapshot.backend == ExecutionBackend::NativePosix =>
                    {
                        macos_seatbelt_execution_capabilities()
                    }
                    (Some(ExecutionPlatform::Linux), Some(runtime))
                        if snapshot.backend == ExecutionBackend::NativePosix =>
                    {
                        linux_bubblewrap_execution_capabilities(runtime).map_err(|_| corrupt)?
                    }
                    _ => return Err(corrupt),
                };
                resource_contract_execution_capabilities(&legacy).map_err(|_| corrupt)?
            }
            _ => return Err(corrupt),
        };
        if expected_capabilities.digest().map_err(|_| corrupt)? != snapshot.capabilities_digest {
            return Err(corrupt);
        }
        if snapshot.schema_version <= 3 && snapshot.resources.is_some() {
            return Err(corrupt);
        }
        if snapshot.schema_version == 4 {
            let resources = snapshot.resources.as_ref().ok_or(corrupt)?;
            resources.validate().map_err(|_| corrupt)?;
            let requested = snapshot
                .policy
                .resources
                .as_ref()
                .is_some_and(|value| !value.is_empty());
            if requested || !matches!(resources, ExecutionResourceEvidence::NotRequested {}) {
                return Err(corrupt);
            }
        }
        if snapshot.schema_version == 2
            || (snapshot.schema_version == 4 && snapshot.platform == Some(ExecutionPlatform::Macos))
        {
            return validate_macos_snapshot(snapshot);
        }
        if snapshot.schema_version == 3
            || (snapshot.schema_version == 4 && snapshot.platform == Some(ExecutionPlatform::Linux))
        {
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
    let evaluation = evaluate_execution_policy(policy, caps)?;
    if !evaluation.allowed {
        let resource_unmet = evaluation.unmet.iter().any(|requirement| {
            matches!(
                requirement.dimension,
                ExecutionPolicyDimension::ProcessCpuTimeMs
                    | ExecutionPolicyDimension::ProcessAddressSpaceBytes
                    | ExecutionPolicyDimension::JobProcessCount
                    | ExecutionPolicyDimension::ProcessOpenFiles
                    | ExecutionPolicyDimension::ProcessFileSizeBytes
            )
        });
        return Err(if resource_unmet {
            ExecutionPolicyError::ResourceLimitUnavailable
        } else {
            ExecutionPolicyError::ExecutionPolicyUnavailable
        });
    }
    if (caps.schema_version == 4) != (policy.schema_version == 2) {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
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
        resources: if caps.schema_version == 4 {
            Some(ExecutionResourceEvidence::NotRequested {})
        } else {
            None
        },
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
