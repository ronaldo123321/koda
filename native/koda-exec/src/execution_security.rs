//! Trusted native admission, launch evidence, and retained-evidence validation.
use std::path::{Path, PathBuf};

use crate::execution_policy::{
    EnforcementLayer, EnforcementMechanism, ExecutionBackend, ExecutionCapabilities,
    ExecutionEnforcementEvidence, ExecutionPlatform, ExecutionPolicyError,
    ExecutionSecuritySnapshot, ExecutionSecurityStage, FilesystemPolicy, NetworkPolicy,
    c1_execution_capabilities, create_execution_admission_snapshot, execution_supervision,
};
use crate::protocol::{ProtocolError, StartParams};

pub fn policy_error(error: ExecutionPolicyError) -> ProtocolError {
    ProtocolError::new(error.code(), error.to_string())
}

pub fn corrupt() -> ProtocolError {
    policy_error(ExecutionPolicyError::ExecutionSecurityCorrupt)
}

pub fn native_capabilities() -> ExecutionCapabilities {
    c1_execution_capabilities(if cfg!(windows) {
        ExecutionBackend::NativeWindows
    } else {
        ExecutionBackend::NativePosix
    })
}

pub fn admit_with_capabilities(
    start: &StartParams,
    capabilities: &ExecutionCapabilities,
) -> Result<ExecutionSecuritySnapshot, ProtocolError> {
    let policy = start
        .policy
        .as_ref()
        .ok_or_else(|| policy_error(ExecutionPolicyError::InvalidExecutionPolicy))?;
    let snapshot =
        create_execution_admission_snapshot(policy, capabilities).map_err(policy_error)?;
    validate_launch_paths(start)?;
    Ok(snapshot)
}

/// Filesystem checks belong at launch, not while observing retained old jobs.
pub fn validate_launch_paths(start: &StartParams) -> Result<(), ProtocolError> {
    let policy = start
        .policy
        .as_ref()
        .ok_or_else(|| policy_error(ExecutionPolicyError::InvalidExecutionPolicy))?;
    let root = canonical_directory(&policy.workspace_root)?;
    let cwd = canonical_directory(&start.cwd)?;
    if !cwd.starts_with(&root) {
        return Err(policy_error(ExecutionPolicyError::InvalidExecutionPolicy));
    }
    Ok(())
}

fn canonical_directory(input: &str) -> Result<PathBuf, ProtocolError> {
    let invalid = || policy_error(ExecutionPolicyError::InvalidExecutionPolicy);
    let canonical = std::fs::canonicalize(input).map_err(|_| invalid())?;
    if !canonical.is_dir() {
        return Err(invalid());
    }
    let text = canonical.to_str().ok_or_else(invalid)?;
    if comparable_path(text) != comparable_path(input) {
        return Err(invalid());
    }
    Ok(canonical)
}

// Rust's Windows canonicalize uses extended namespace prefixes; Node's realpath
// may not. Preserve the supplied spelling in all policy and request digests.
fn comparable_path(path: &str) -> PathBuf {
    if cfg!(windows) {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    Path::new(path).to_path_buf()
}

pub fn validate_retained(
    start: &StartParams,
    snapshot: &ExecutionSecuritySnapshot,
) -> Result<(), ProtocolError> {
    snapshot.validate().map_err(|_| corrupt())?;
    let ExecutionSecuritySnapshot::Policy(security) = snapshot else {
        return Err(corrupt());
    };
    if !matches!(
        security.backend,
        ExecutionBackend::NativePosix | ExecutionBackend::NativeWindows
    ) {
        return Err(corrupt());
    }
    if start.policy.as_ref() != Some(&security.policy) {
        return Err(corrupt());
    }
    // Never probe current host capabilities when reading an old job's report.
    Ok(())
}

pub fn validate_worker_admission_with_capabilities(
    start: &StartParams,
    retained: &ExecutionSecuritySnapshot,
    capabilities: &ExecutionCapabilities,
) -> Result<(), ProtocolError> {
    validate_retained(start, retained)?;
    let admitted = admit_with_capabilities(start, capabilities)?;
    let (ExecutionSecuritySnapshot::Policy(expected), ExecutionSecuritySnapshot::Policy(actual)) =
        (admitted, retained)
    else {
        return Err(corrupt());
    };
    if expected.backend != actual.backend
        || expected.capabilities_digest != actual.capabilities_digest
    {
        return Err(policy_error(ExecutionPolicyError::ExecutionPolicyChanged));
    }
    Ok(())
}

/// Called only after the native launch object was created with explicit env and
/// an owned process group/Job Object, while its gate/thread is still suspended.
#[cfg(any(test, windows))]
pub fn launch_setup(
    start: &StartParams,
    retained: &ExecutionSecuritySnapshot,
) -> Result<ExecutionSecuritySnapshot, ProtocolError> {
    let capabilities = match retained {
        ExecutionSecuritySnapshot::Policy(security) if security.schema_version == 4 => {
            crate::execution_policy::historical_resource_contract_execution_capabilities(
                &native_capabilities(),
                false,
            )
            .map_err(policy_error)?
        }
        ExecutionSecuritySnapshot::Policy(security) if security.schema_version == 5 => {
            crate::execution_policy::current_resource_execution_capabilities(&native_capabilities())
                .map_err(policy_error)?
        }
        _ => native_capabilities(),
    };
    launch_setup_with_capabilities(start, retained, &capabilities, false, false)
}

pub fn launch_setup_with_capabilities(
    start: &StartParams,
    retained: &ExecutionSecuritySnapshot,
    capabilities: &ExecutionCapabilities,
    os_sandbox_confirmed: bool,
    resources_confirmed: bool,
) -> Result<ExecutionSecuritySnapshot, ProtocolError> {
    validate_worker_admission_with_capabilities(start, retained, capabilities)?;
    let mut snapshot = retained.clone();
    let ExecutionSecuritySnapshot::Policy(security) = &mut snapshot else {
        return Err(corrupt());
    };
    let protected = security.policy.filesystem != FilesystemPolicy::Unrestricted
        || security.policy.network != NetworkPolicy::Inherit;
    let macos_contract = security.schema_version == 2
        || (matches!(security.schema_version, 4 | 5)
            && security.platform == Some(ExecutionPlatform::Macos));
    let linux_contract = security.schema_version == 3
        || (matches!(security.schema_version, 4 | 5)
            && security.platform == Some(ExecutionPlatform::Linux));
    let os_sandbox_contract = macos_contract || linux_contract;
    if !os_sandbox_contract && os_sandbox_confirmed {
        return Err(corrupt());
    }
    if os_sandbox_contract && protected && !os_sandbox_confirmed {
        return Err(policy_error(
            ExecutionPolicyError::ExecutionPolicyUnavailable,
        ));
    }
    if os_sandbox_contract && !protected && os_sandbox_confirmed {
        return Err(corrupt());
    }
    let resources_requested = security
        .policy
        .resources
        .as_ref()
        .is_some_and(|resources| !resources.is_empty());
    if resources_requested && !resources_confirmed {
        return Err(policy_error(ExecutionPolicyError::ResourceLimitApplyFailed));
    }
    if !resources_requested && resources_confirmed {
        return Err(corrupt());
    }
    if macos_contract && os_sandbox_confirmed {
        if security.policy.filesystem != FilesystemPolicy::Unrestricted {
            security.filesystem = ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::MacosSeatbelt,
                layer: EnforcementLayer::Os,
            };
        }
        if security.policy.network != NetworkPolicy::Inherit {
            security.network = ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::MacosSeatbelt,
                layer: EnforcementLayer::Os,
            };
        }
    }
    if linux_contract && os_sandbox_confirmed {
        if security.policy.filesystem != FilesystemPolicy::Unrestricted {
            security.filesystem = ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::LinuxBubblewrapMountNamespace,
                layer: EnforcementLayer::Os,
            };
        }
        if security.policy.network != NetworkPolicy::Inherit {
            security.network = ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::LinuxNetworkNamespaceSeccomp,
                layer: EnforcementLayer::Os,
            };
        }
    }
    security.stage = ExecutionSecurityStage::LaunchSetup;
    security.environment = ExecutionEnforcementEvidence::Applied {
        mechanism: EnforcementMechanism::ExplicitEnvironment,
        layer: EnforcementLayer::Application,
    };
    let supervision = execution_supervision(security.backend);
    security.supervision = ExecutionEnforcementEvidence::Applied {
        mechanism: supervision.mechanism,
        layer: supervision.layer,
    };
    if resources_requested {
        security.resources = Some(
            crate::execution_policy::create_execution_resource_applied_evidence(
                &security.policy,
                capabilities,
            )
            .map_err(policy_error)?,
        );
    }
    snapshot.validate().map_err(policy_error)?;
    Ok(snapshot)
}

pub fn legacy_unknown() -> ExecutionSecuritySnapshot {
    ExecutionSecuritySnapshot::LegacyUnknown { schema_version: 1 }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::execution_policy::{
        EnvironmentPolicy, ExecutionPolicy, LinuxBubblewrapRuntimeDescriptor,
        ProcessIsolationPolicy, linux_bubblewrap_execution_capabilities,
    };
    use crate::protocol::{IoMode, JobLifecycle};

    #[test]
    fn linux_launch_evidence_requires_confirmation_and_uses_typed_mechanisms() {
        let cwd = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let runtime = LinuxBubblewrapRuntimeDescriptor {
            schema_version: 1,
            mechanism: EnforcementMechanism::LinuxBubblewrap,
            canonical_path: "/usr/bin/bwrap".to_owned(),
            device: "1".to_owned(),
            inode: "2".to_owned(),
            size: 3,
            mtime_ns: "4".to_owned(),
            sha256: "11".repeat(32),
            version: "bubblewrap 1.0".to_owned(),
            probe_revision: 1,
        };
        let capabilities = linux_bubblewrap_execution_capabilities(&runtime).unwrap();
        let policy = ExecutionPolicy {
            schema_version: 1,
            workspace_root: cwd.to_string_lossy().into_owned(),
            filesystem: FilesystemPolicy::ReadOnly,
            network: NetworkPolicy::Deny,
            process_isolation: ProcessIsolationPolicy::Inherit,
            environment: EnvironmentPolicy::Explicit,
            resources: None,
        };
        let start = StartParams {
            argv: vec!["/usr/bin/true".to_owned()],
            cwd: cwd.to_string_lossy().into_owned(),
            display_name: None,
            environment: BTreeMap::new(),
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            termination_grace_ms: 25,
            termination_confirmation_ms: 1_000,
            io_mode: IoMode::Pipe,
            lifecycle: JobLifecycle::Foreground,
            pty: None,
            policy: Some(policy),
            secrets: None,
        };
        let admission = admit_with_capabilities(&start, &capabilities).unwrap();
        assert!(
            launch_setup_with_capabilities(&start, &admission, &capabilities, false, false)
                .is_err()
        );
        let applied =
            launch_setup_with_capabilities(&start, &admission, &capabilities, true, false).unwrap();
        let ExecutionSecuritySnapshot::Policy(applied) = applied else {
            panic!("expected policy evidence");
        };
        assert_eq!(applied.stage, ExecutionSecurityStage::LaunchSetup);
        assert_eq!(
            applied.filesystem,
            ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::LinuxBubblewrapMountNamespace,
                layer: EnforcementLayer::Os,
            }
        );
        assert_eq!(
            applied.network,
            ExecutionEnforcementEvidence::Applied {
                mechanism: EnforcementMechanism::LinuxNetworkNamespaceSeccomp,
                layer: EnforcementLayer::Os,
            }
        );
    }
}
