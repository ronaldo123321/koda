#[cfg(unix)]
mod identity_unix;
#[cfg(windows)]
mod identity_windows;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{
    LocalListener, LocalStream, accept_local_connection, bind_local_endpoint,
    connect_local_endpoint, default_local_endpoint, prepare_local_endpoint_parent,
    remove_local_endpoint, validate_local_endpoint, verify_local_peer, worker_local_endpoint,
};
#[cfg(windows)]
pub use windows::{
    LocalListener, LocalStream, accept_local_connection, bind_local_endpoint,
    connect_local_endpoint, default_local_endpoint, prepare_local_endpoint_parent,
    remove_local_endpoint, validate_local_endpoint, verify_local_peer, worker_local_endpoint,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformCapabilities {
    pub process_group: bool,
    pub job_object: bool,
    pub pty: bool,
    pub reattach: bool,
    pub durable_restart_recovery: bool,
}

pub const fn capabilities() -> PlatformCapabilities {
    PlatformCapabilities {
        process_group: cfg!(unix),
        job_object: cfg!(windows),
        pty: cfg!(any(unix, windows)),
        reattach: true,
        durable_restart_recovery: true,
    }
}

pub mod identity {
    #[cfg(unix)]
    pub use super::identity_unix::{
        current_process_identity, process_identity_matches, process_start_identity,
    };
    #[cfg(windows)]
    #[allow(unused_imports)] // Phase 4B4B consumes the full Windows identity contract.
    pub use super::identity_windows::{
        current_process_identity, process_identity_matches, process_start_identity,
    };
}

pub mod state_security {
    #[cfg(unix)]
    pub use super::unix::{
        open_exclusive_lock, open_new_private_file, replace_file, secure_private_directory,
        sync_directory, validate_private_directory, validate_private_file, worker_control_root,
    };
    #[cfg(windows)]
    #[allow(unused_imports)] // Phase 4B4B moves durable state onto this backend.
    pub use super::windows::{
        open_exclusive_lock, open_new_private_file, prepare_state_root, replace_file,
        secure_private_directory, sync_directory, validate_private_directory,
        validate_private_file, worker_control_root,
    };
}

#[cfg(unix)]
pub mod bootstrap {
    pub use super::unix::{
        BootstrapHandle, BootstrapRead, BootstrapWrite, SandboxBootstrapChannels,
        await_gate_and_exec, configure_pipe_command, configure_pty_command,
        create_bootstrap_channel, read_inherited_secret, release_gate, spawn_worker_process,
    };
}

#[cfg(windows)]
pub mod bootstrap {
    pub use super::windows::{BootstrapHandle, read_inherited_secret, spawn_worker_process};
}

#[cfg(unix)]
pub mod process {
    pub use super::unix::{
        ProcessTreeSignal, exit_signal_name, process_group_exists, signal_process_group,
    };
}

#[cfg(windows)]
pub mod process {
    pub use super::windows::{
        ManagedProcessTree, SuspendedManagedProcess, SuspendedManagedPtyProcess,
    };
}

#[cfg(unix)]
pub mod terminal {
    pub use super::unix::{duplicate_terminal, is_terminal_eof, open_terminal, set_terminal_size};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_match_the_verified_runtime() {
        let capabilities = capabilities();
        assert_eq!(capabilities.process_group, cfg!(unix));
        assert_eq!(capabilities.job_object, cfg!(windows));
        assert!(capabilities.pty);
        assert!(capabilities.reattach);
        assert!(capabilities.durable_restart_recovery);
    }
}
