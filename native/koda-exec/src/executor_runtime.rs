use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::execution_policy::{ExecutionCapabilities, ExecutionPolicyError};
use crate::protocol::ProtocolError;

pub struct ExecutorRuntime {
    supervisor: Arc<crate::supervisor::Supervisor>,
    execution_capabilities: ExecutionCapabilities,
}

impl ExecutorRuntime {
    pub async fn open(
        state_directory: &Path,
        binary_path: PathBuf,
    ) -> Result<Arc<Self>, ProtocolError> {
        let macos_probe_binary = binary_path.clone();
        let linux_probe_binary = binary_path.clone();
        let (macos_seatbelt, linux_bubblewrap) = tokio::try_join!(
            tokio::task::spawn_blocking(move || {
                crate::macos_seatbelt::probe(&macos_probe_binary)
            }),
            tokio::task::spawn_blocking(move || {
                crate::linux_bubblewrap::probe(&linux_probe_binary)
            })
        )
        .map_err(|_| {
            ProtocolError::new(
                ExecutionPolicyError::ExecutionPolicyUnavailable.code(),
                "The operating-system isolation capability probe could not complete.",
            )
        })?;
        if std::env::var_os("KODA_REQUIRE_MACOS_SEATBELT").as_deref()
            == Some(std::ffi::OsStr::new("1"))
            && !macos_seatbelt.is_verified()
        {
            let reason = macos_seatbelt
                .unavailable_reason()
                .map(|reason| reason.summary())
                .unwrap_or("the capability was not verified");
            return Err(ProtocolError::new(
                ExecutionPolicyError::ExecutionPolicyUnavailable.code(),
                format!("The macOS Seatbelt capability probe failed because {reason}."),
            ));
        }
        if cfg!(target_os = "linux")
            && std::env::var_os("KODA_REQUIRE_LINUX_BUBBLEWRAP").as_deref()
                == Some(std::ffi::OsStr::new("1"))
            && !linux_bubblewrap.is_verified()
        {
            let reason = linux_bubblewrap
                .unavailable_reason()
                .map(|reason| reason.summary())
                .unwrap_or("the capability was not verified");
            return Err(ProtocolError::new(
                ExecutionPolicyError::ExecutionPolicyUnavailable.code(),
                format!("The Linux Bubblewrap capability probe failed because {reason}."),
            ));
        }
        let execution_capabilities = if macos_seatbelt.is_verified() {
            crate::execution_policy::macos_seatbelt_execution_capabilities()
        } else if let Some(runtime) = linux_bubblewrap.descriptor() {
            crate::execution_policy::linux_bubblewrap_execution_capabilities(runtime).map_err(
                |_| {
                    ProtocolError::new(
                        ExecutionPolicyError::ExecutionPolicyUnavailable.code(),
                        "The verified Linux Bubblewrap capability descriptor is invalid.",
                    )
                },
            )?
        } else {
            crate::execution_security::native_capabilities()
        };
        let supervisor = crate::supervisor::Supervisor::open(
            state_directory,
            binary_path,
            execution_capabilities.clone(),
        )
        .await?;
        Ok(Arc::new(Self {
            supervisor,
            execution_capabilities,
        }))
    }

    /// Capability advertisement is bound to the startup probe retained for this
    /// Supervisor lifetime; it never broadens in place after startup.
    pub fn execution_capabilities(&self) -> ExecutionCapabilities {
        self.execution_capabilities.clone()
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        request_id: String,
        method: &str,
        params: Value,
    ) -> Result<Value, ProtocolError> {
        self.supervisor.dispatch(request_id, method, params).await
    }
}
