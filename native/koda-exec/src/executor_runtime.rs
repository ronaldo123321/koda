use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::execution_policy::{ExecutionCapabilities, ExecutionPolicyError};
use crate::macos_seatbelt::MacosSeatbeltAvailability;
use crate::protocol::ProtocolError;

pub struct ExecutorRuntime {
    supervisor: Arc<crate::supervisor::Supervisor>,
    macos_seatbelt: MacosSeatbeltAvailability,
}

impl ExecutorRuntime {
    pub async fn open(
        state_directory: &Path,
        binary_path: PathBuf,
    ) -> Result<Arc<Self>, ProtocolError> {
        let probe_binary = binary_path.clone();
        let macos_seatbelt =
            tokio::task::spawn_blocking(move || crate::macos_seatbelt::probe(&probe_binary))
                .await
                .map_err(|_| {
                    ProtocolError::new(
                        ExecutionPolicyError::ExecutionPolicyUnavailable.code(),
                        "The macOS Seatbelt capability probe could not complete.",
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
        let execution_capabilities = if macos_seatbelt.is_verified() {
            crate::execution_policy::macos_seatbelt_execution_capabilities()
        } else {
            crate::execution_security::native_capabilities()
        };
        let supervisor = crate::supervisor::Supervisor::open(
            state_directory,
            binary_path,
            execution_capabilities,
        )
        .await?;
        Ok(Arc::new(Self {
            supervisor,
            macos_seatbelt,
        }))
    }

    /// Capability advertisement is bound to the startup probe retained for this
    /// Supervisor lifetime; it never broadens in place after startup.
    pub fn execution_capabilities(&self) -> ExecutionCapabilities {
        if self.macos_seatbelt.is_verified() {
            crate::execution_policy::macos_seatbelt_execution_capabilities()
        } else {
            crate::execution_security::native_capabilities()
        }
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
