//! Trusted native admission, launch evidence, and retained-evidence validation.
use std::path::{Path, PathBuf};

use crate::execution_policy::{
    EnforcementLayer, EnforcementMechanism, ExecutionBackend, ExecutionCapabilities,
    ExecutionEnforcementEvidence, ExecutionPolicyError, ExecutionSecuritySnapshot,
    ExecutionSecurityStage, FilesystemPolicy, NetworkPolicy, c1_execution_capabilities,
    create_execution_admission_snapshot, execution_supervision,
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
    launch_setup_with_capabilities(start, retained, &native_capabilities(), false)
}

pub fn launch_setup_with_capabilities(
    start: &StartParams,
    retained: &ExecutionSecuritySnapshot,
    capabilities: &ExecutionCapabilities,
    macos_seatbelt_confirmed: bool,
) -> Result<ExecutionSecuritySnapshot, ProtocolError> {
    validate_worker_admission_with_capabilities(start, retained, capabilities)?;
    let mut snapshot = retained.clone();
    let ExecutionSecuritySnapshot::Policy(security) = &mut snapshot else {
        return Err(corrupt());
    };
    let protected = security.policy.filesystem != FilesystemPolicy::Unrestricted
        || security.policy.network != NetworkPolicy::Inherit;
    if security.schema_version == 1 && macos_seatbelt_confirmed {
        return Err(corrupt());
    }
    if security.schema_version == 2 && protected && !macos_seatbelt_confirmed {
        return Err(policy_error(
            ExecutionPolicyError::ExecutionPolicyUnavailable,
        ));
    }
    if security.schema_version == 2 && !protected && macos_seatbelt_confirmed {
        return Err(corrupt());
    }
    if security.schema_version == 2 && macos_seatbelt_confirmed {
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
    snapshot.validate().map_err(policy_error)?;
    Ok(snapshot)
}

pub fn legacy_unknown() -> ExecutionSecuritySnapshot {
    ExecutionSecuritySnapshot::LegacyUnknown { schema_version: 1 }
}
