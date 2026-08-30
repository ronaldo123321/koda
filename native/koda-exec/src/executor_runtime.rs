use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::protocol::ProtocolError;

pub struct ExecutorRuntime {
    supervisor: Arc<crate::supervisor::Supervisor>,
}

impl ExecutorRuntime {
    pub async fn open(
        state_directory: &Path,
        binary_path: PathBuf,
    ) -> Result<Arc<Self>, ProtocolError> {
        let supervisor = crate::supervisor::Supervisor::open(state_directory, binary_path).await?;
        Ok(Arc::new(Self { supervisor }))
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        request_id: String,
        method: &str,
        params: Value,
    ) -> Result<Value, ProtocolError> {
        #[cfg(windows)]
        if method == "job/start" {
            let _ = (request_id, params);
            return Err(ProtocolError::new(
                "PLATFORM_CAPABILITY_UNAVAILABLE",
                "Windows command execution remains unavailable until Phase 4B4B2 Job Object ownership is verified.",
            ));
        }

        self.supervisor.dispatch(request_id, method, params).await
    }
}
