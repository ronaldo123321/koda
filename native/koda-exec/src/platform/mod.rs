#[cfg(unix)]
mod identity_unix;
#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub use unix::{
    LocalListener, LocalStream, bind_local_endpoint, connect_local_endpoint,
    prepare_local_endpoint_parent, remove_local_endpoint, validate_local_endpoint,
    verify_local_peer,
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
        job_object: false,
        pty: cfg!(unix),
        reattach: cfg!(unix),
        durable_restart_recovery: cfg!(unix),
    }
}

pub mod identity {
    pub use super::identity_unix::{
        current_process_identity, process_identity_matches, process_start_identity,
    };
}

pub mod state_security {
    pub use super::unix::{
        open_exclusive_lock, open_new_private_file, secure_private_directory, sync_directory,
        validate_private_directory, validate_private_file, worker_control_root,
    };
}

pub mod bootstrap {
    pub use super::unix::{
        await_gate_and_exec, configure_pipe_command, configure_pty_command,
        configure_worker_command, create_bootstrap_channel, raw_handle, read_inherited_secret,
        release_gate,
    };
}

pub mod process {
    pub use super::unix::{
        ProcessTreeSignal, exit_signal_name, process_group_exists, signal_process_group,
    };
}

pub mod terminal {
    pub use super::unix::{duplicate_terminal, is_terminal_eof, open_terminal, set_terminal_size};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_capabilities_match_the_verified_runtime() {
        let capabilities = capabilities();
        assert_eq!(capabilities.process_group, cfg!(unix));
        assert!(!capabilities.job_object);
        assert_eq!(capabilities.pty, cfg!(unix));
        assert_eq!(capabilities.reattach, cfg!(unix));
        assert_eq!(capabilities.durable_restart_recovery, cfg!(unix));
    }
}
