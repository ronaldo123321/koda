use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::protocol::ProtocolError;

pub struct ExecutorRuntime {
    #[cfg(unix)]
    supervisor: Arc<crate::supervisor::Supervisor>,
}

impl ExecutorRuntime {
    pub async fn open(
        state_directory: &Path,
        binary_path: PathBuf,
    ) -> Result<Arc<Self>, ProtocolError> {
        #[cfg(unix)]
        {
            let supervisor =
                crate::supervisor::Supervisor::open(state_directory, binary_path).await?;
            Ok(Arc::new(Self { supervisor }))
        }

        #[cfg(windows)]
        {
            let _ = binary_path;
            crate::platform::state_security::prepare_state_root(state_directory).map_err(
                |error| {
                    ProtocolError::new(
                        "STATE_SECURITY_UNAVAILABLE",
                        format!("Could not secure executor state: {error}"),
                    )
                },
            )?;
            Ok(Arc::new(Self {}))
        }
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        request_id: String,
        method: &str,
        params: Value,
    ) -> Result<Value, ProtocolError> {
        #[cfg(unix)]
        {
            self.supervisor.dispatch(request_id, method, params).await
        }

        #[cfg(windows)]
        {
            let _ = (request_id, params);
            Err(ProtocolError::new(
                "PLATFORM_CAPABILITY_UNAVAILABLE",
                format!(
                    "Executor method '{method}' is unavailable until Windows Job Object ownership is enabled."
                ),
            ))
        }
    }
}
