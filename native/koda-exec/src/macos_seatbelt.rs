#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::execution_policy::{
    EnvironmentPolicy, ExecutionPolicy, ExecutionPolicyError, FilesystemPolicy, NetworkPolicy,
    ProcessIsolationPolicy,
};

pub const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";
pub const MAX_PROFILE_BYTES: usize = 32 * 1024;
pub const MAX_PARAMETER_COUNT: usize = 18;
pub const MAX_PARAMETER_PATH_BYTES: usize = 4096;
const BASE_POLICY: &str = include_str!("macos_seatbelt_base.sbpl");
const WORKSPACE_PARAMETER: &str = "WORKSPACE_ROOT";
const SCRATCH_PARAMETER: &str = "SCRATCH_ROOT";
const CONFIRMATION_MARKER: &[u8; 16] = b"KODA-SEATBELT-V1";
const CONFIRMATION_FRAME_BYTES: usize = 20;
pub const SANDBOX_CONFIRMATION_FD: i32 = 4;
pub const SANDBOX_RELEASE_FD: i32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatbeltInvocation {
    profile: String,
    parameters: Vec<(String, PathBuf)>,
}

impl SeatbeltInvocation {
    #[cfg(test)]
    pub fn profile(&self) -> &str {
        &self.profile
    }

    #[cfg(test)]
    pub fn parameters(&self) -> &[(String, PathBuf)] {
        &self.parameters
    }

    pub fn command_argv(
        &self,
        command: &[OsString],
    ) -> Result<Vec<OsString>, ExecutionPolicyError> {
        if command.is_empty() {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        let mut argv = Vec::with_capacity(5 + self.parameters.len() * 2 + command.len());
        argv.push(OsString::from(SANDBOX_EXEC_PATH));
        argv.push(OsString::from("-p"));
        argv.push(OsString::from(&self.profile));
        for (name, value) in &self.parameters {
            let text = value
                .to_str()
                .ok_or(ExecutionPolicyError::InvalidExecutionPolicy)?;
            argv.push(OsString::from(format!("-D{name}={text}")));
        }
        argv.push(OsString::from("--"));
        argv.extend(command.iter().cloned());
        Ok(argv)
    }
}

pub fn build_invocation(
    policy: &ExecutionPolicy,
    workspace_root: &Path,
    scratch_root: Option<&Path>,
) -> Result<SeatbeltInvocation, ExecutionPolicyError> {
    build_invocation_with_secret_files(policy, workspace_root, scratch_root, &[])
}

pub fn build_invocation_with_secret_files(
    policy: &ExecutionPolicy,
    workspace_root: &Path,
    scratch_root: Option<&Path>,
    secret_files: &[PathBuf],
) -> Result<SeatbeltInvocation, ExecutionPolicyError> {
    policy.validate()?;
    if policy.process_isolation != ProcessIsolationPolicy::Inherit
        || policy.environment != EnvironmentPolicy::Explicit
        || !requires_seatbelt(policy)
    {
        return Err(ExecutionPolicyError::ExecutionPolicyUnavailable);
    }

    let workspace = validate_canonical_directory(workspace_root)?;
    if workspace.to_str() != Some(policy.workspace_root.as_str()) {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }

    let scratch = match (policy.filesystem, scratch_root) {
        (FilesystemPolicy::Unrestricted | FilesystemPolicy::ReadOnly, None) => None,
        (FilesystemPolicy::WorkspaceWrite, Some(path)) => {
            let canonical = validate_private_empty_directory(path)?;
            if canonical == workspace
                || canonical.starts_with(&workspace)
                || workspace.starts_with(&canonical)
            {
                return Err(ExecutionPolicyError::InvalidExecutionPolicy);
            }
            Some(canonical)
        }
        _ => return Err(ExecutionPolicyError::InvalidExecutionPolicy),
    };

    if secret_files.len() > crate::secret_policy::EXECUTION_SECRET_MAX_SELECTION {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let secrets = secret_files
        .iter()
        .map(|path| validate_private_secret_file(path))
        .collect::<Result<Vec<_>, _>>()?;
    if secrets
        .iter()
        .any(|secret| secret.starts_with(&workspace) || workspace.starts_with(secret))
    {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }

    let mut profile = String::with_capacity(BASE_POLICY.len() + 1024);
    profile.push_str(BASE_POLICY);
    profile.push_str(
        "\n; Reference the validated workspace parameter without granting writes.\n\
         (allow file-read* (subpath (param \"WORKSPACE_ROOT\")))\n",
    );
    if policy.filesystem == FilesystemPolicy::WorkspaceWrite {
        profile.push_str(
            "; General path writes are limited to the two validated roots.\n\
             (allow file-write* (subpath (param \"WORKSPACE_ROOT\")))\n\
             (allow file-write* (subpath (param \"SCRATCH_ROOT\")))\n\
             (deny file-write-unlink (literal (param \"WORKSPACE_ROOT\")))\n\
             (deny file-write-unlink (literal (param \"SCRATCH_ROOT\")))\n",
        );
    } else if policy.filesystem == FilesystemPolicy::Unrestricted {
        profile.push_str("; Filesystem access was explicitly unrestricted.\n(allow file-write*)\n");
    }
    if policy.network == NetworkPolicy::Inherit {
        profile.push_str("; Network access was explicitly inherited.\n(allow network*)\n");
    }
    for index in 0..secrets.len() {
        profile.push_str(&format!(
            "; Exact read-only secret file grant.\n(allow file-read* (literal (param \"SECRET_FILE_{index}\")))\n"
        ));
    }
    if profile.len() > MAX_PROFILE_BYTES {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }

    let mut parameters = vec![(WORKSPACE_PARAMETER.to_owned(), workspace)];
    if let Some(scratch) = scratch {
        parameters.push((SCRATCH_PARAMETER.to_owned(), scratch));
    }
    for (index, secret) in secrets.into_iter().enumerate() {
        parameters.push((format!("SECRET_FILE_{index}"), secret));
    }
    if parameters.len() > MAX_PARAMETER_COUNT {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }

    Ok(SeatbeltInvocation {
        profile,
        parameters,
    })
}

#[cfg(unix)]
fn validate_private_secret_file(path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    use std::os::unix::fs::MetadataExt;

    validate_parameter_path(path)?;
    let invalid = || ExecutionPolicyError::InvalidExecutionPolicy;
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o777 != 0o400
    {
        return Err(invalid());
    }
    let canonical = fs::canonicalize(path).map_err(|_| invalid())?;
    if canonical != path {
        return Err(invalid());
    }
    Ok(canonical)
}

#[cfg(not(unix))]
fn validate_private_secret_file(_path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    Err(ExecutionPolicyError::ExecutionPolicyUnavailable)
}

pub fn requires_seatbelt(policy: &ExecutionPolicy) -> bool {
    policy.filesystem != FilesystemPolicy::Unrestricted || policy.network != NetworkPolicy::Inherit
}

fn validate_canonical_directory(path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    let invalid = || ExecutionPolicyError::InvalidExecutionPolicy;
    validate_parameter_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid());
    }
    let canonical = fs::canonicalize(path).map_err(|_| invalid())?;
    if canonical != path {
        return Err(invalid());
    }
    Ok(canonical)
}

fn validate_parameter_path(path: &Path) -> Result<(), ExecutionPolicyError> {
    if !path.is_absolute() {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let text = path
        .to_str()
        .ok_or(ExecutionPolicyError::InvalidExecutionPolicy)?;
    if text.len() > MAX_PARAMETER_PATH_BYTES || text.contains('\0') {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    Ok(())
}

#[cfg(unix)]
fn validate_private_empty_directory(path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    use std::os::unix::fs::MetadataExt;

    let canonical = validate_canonical_directory(path)?;
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
    // SAFETY: geteuid reads process credentials and has no preconditions.
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.uid() != expected_uid || metadata.mode() & 0o777 != 0o700 {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    if fs::read_dir(&canonical)
        .map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?
        .next()
        .is_some()
    {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    Ok(canonical)
}

#[cfg(not(unix))]
fn validate_private_empty_directory(_path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    Err(ExecutionPolicyError::ExecutionPolicyUnavailable)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatbeltUnavailableReason {
    #[cfg(not(target_os = "macos"))]
    UnsupportedPlatform,
    SystemExecutableInvalid,
    ProbeSetupFailed,
    ProfileRejected,
    ConfirmationFailed,
    ProbeContractFailed,
    ProbeTimedOut,
}

impl SeatbeltUnavailableReason {
    pub fn summary(self) -> &'static str {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::UnsupportedPlatform => "the host is not macOS",
            Self::SystemExecutableInvalid => "the system sandbox executable is unavailable",
            Self::ProbeSetupFailed => "the isolated capability probe could not be prepared",
            Self::ProfileRejected => "the fixed Seatbelt profile was rejected",
            Self::ConfirmationFailed => "the sandbox bootstrap did not confirm confinement",
            Self::ProbeContractFailed => "the isolation self-test did not enforce its contract",
            Self::ProbeTimedOut => "the isolation self-test timed out",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosSeatbeltAvailability {
    Verified,
    Unavailable(SeatbeltUnavailableReason),
}

impl MacosSeatbeltAvailability {
    pub fn is_verified(self) -> bool {
        self == Self::Verified
    }

    pub fn unavailable_reason(self) -> Option<SeatbeltUnavailableReason> {
        match self {
            Self::Verified => None,
            Self::Unavailable(reason) => Some(reason),
        }
    }
}

pub fn probe(binary_path: &Path) -> MacosSeatbeltAvailability {
    probe_platform(binary_path)
}

pub fn launch_available() -> bool {
    launch_available_platform()
}

#[cfg(target_os = "macos")]
fn launch_available_platform() -> bool {
    validate_system_sandbox_executable(Path::new(SANDBOX_EXEC_PATH)).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn launch_available_platform() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn probe_platform(_binary_path: &Path) -> MacosSeatbeltAvailability {
    MacosSeatbeltAvailability::Unavailable(SeatbeltUnavailableReason::UnsupportedPlatform)
}

pub fn confirmation_frame(pid: u32) -> [u8; CONFIRMATION_FRAME_BYTES] {
    let mut frame = [0u8; CONFIRMATION_FRAME_BYTES];
    frame[..CONFIRMATION_MARKER.len()].copy_from_slice(CONFIRMATION_MARKER);
    frame[CONFIRMATION_MARKER.len()..].copy_from_slice(&pid.to_be_bytes());
    frame
}

pub fn parse_confirmation_frame(bytes: &[u8]) -> io::Result<u32> {
    if bytes.len() != CONFIRMATION_FRAME_BYTES
        || &bytes[..CONFIRMATION_MARKER.len()] != CONFIRMATION_MARKER
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sandbox confirmation frame is invalid",
        ));
    }
    let pid_bytes: [u8; 4] = bytes[CONFIRMATION_MARKER.len()..]
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "sandbox PID is invalid"))?;
    let pid = u32::from_be_bytes(pid_bytes);
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sandbox PID is invalid",
        ));
    }
    Ok(pid)
}

#[cfg(unix)]
pub fn run_sandbox_bootstrap(
    confirmation_fd: i32,
    release_fd: i32,
    argv: Vec<String>,
) -> io::Result<()> {
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    if confirmation_fd < 3 || release_fd < 3 || confirmation_fd == release_fd || argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "sandbox bootstrap arguments are invalid",
        ));
    }
    validate_pipe_descriptor(confirmation_fd)?;
    validate_pipe_descriptor(release_fd)?;
    // SAFETY: this bootstrap exclusively owns the inherited descriptor.
    let mut confirmation = unsafe { File::from_raw_fd(confirmation_fd) };
    // SAFETY: this bootstrap exclusively owns the distinct inherited descriptor.
    let mut release = unsafe { File::from_raw_fd(release_fd) };
    confirmation.write_all(&confirmation_frame(std::process::id()))?;
    drop(confirmation);
    let mut byte = [0u8; 1];
    release.read_exact(&mut byte)?;
    if byte[0] != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox release gate value is invalid",
        ));
    }
    drop(release);

    let error = CommandExt::exec(Command::new(&argv[0]).args(&argv[1..]));
    Err(error)
}

#[cfg(windows)]
pub fn run_sandbox_bootstrap(
    _confirmation_fd: i32,
    _release_fd: i32,
    _argv: Vec<String>,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS sandbox bootstrap is unavailable",
    ))
}

#[cfg(unix)]
fn validate_pipe_descriptor(descriptor: i32) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat initializes `stat` for a valid descriptor and does not retain pointers.
    if unsafe { libc::fstat(descriptor, stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded and initialized the value.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "sandbox bootstrap descriptor is not a pipe",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn probe_platform(binary_path: &Path) -> MacosSeatbeltAvailability {
    match run_probe(binary_path) {
        Ok(()) => MacosSeatbeltAvailability::Verified,
        Err(reason) => MacosSeatbeltAvailability::Unavailable(reason),
    }
}

#[cfg(target_os = "macos")]
fn run_probe(binary_path: &Path) -> Result<(), SeatbeltUnavailableReason> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let sandbox = Path::new(SANDBOX_EXEC_PATH);
    validate_system_sandbox_executable(sandbox)?;
    let binary =
        fs::canonicalize(binary_path).map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    if !binary.is_file() {
        return Err(SeatbeltUnavailableReason::ProbeSetupFailed);
    }

    let probe_root =
        ProbeRoot::create().map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let workspace = probe_root.path.join("workspace");
    fs::create_dir(&workspace).map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700))
        .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let workspace =
        fs::canonicalize(workspace).map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let allowed = workspace.join("allowed.txt");
    fs::write(&allowed, b"koda-seatbelt-probe")
        .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let denied = probe_root.path.join("denied-write");
    let policy = ExecutionPolicy {
        schema_version: 1,
        workspace_root: workspace
            .to_str()
            .ok_or(SeatbeltUnavailableReason::ProbeSetupFailed)?
            .to_owned(),
        filesystem: FilesystemPolicy::ReadOnly,
        network: NetworkPolicy::Deny,
        process_isolation: ProcessIsolationPolicy::Inherit,
        environment: EnvironmentPolicy::Explicit,
    };
    let invocation = build_invocation(&policy, &workspace, None)
        .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;

    let bootstrap_command = vec![
        binary.clone().into_os_string(),
        OsString::from("sandbox-bootstrap"),
        OsString::from("--confirm-fd"),
        OsString::from(SANDBOX_CONFIRMATION_FD.to_string()),
        OsString::from("--release-fd"),
        OsString::from(SANDBOX_RELEASE_FD.to_string()),
        OsString::from("--"),
        binary.clone().into_os_string(),
        OsString::from("seatbelt-probe"),
        OsString::from("--allowed"),
        allowed.into_os_string(),
        OsString::from("--denied"),
        denied.into_os_string(),
    ];
    let argv = invocation
        .command_argv(&bootstrap_command)
        .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let (confirmation_read, confirmation_write) =
        crate::platform::bootstrap::create_bootstrap_channel()
            .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let (release_read, release_write) = crate::platform::bootstrap::create_bootstrap_channel()
        .map_err(|_| SeatbeltUnavailableReason::ProbeSetupFailed)?;
    let confirmation_read_fd = confirmation_read.as_raw_fd();
    let confirmation_write_fd = confirmation_write.as_raw_fd();
    let release_read_fd = release_read.as_raw_fd();
    let release_write_fd = release_write.as_raw_fd();

    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: the closure uses only async-signal-safe descriptor operations before exec.
    unsafe {
        command.pre_exec(move || {
            // Preserve both sources before assigning fixed low descriptors so
            // one target can never clobber the other pipe's source.
            let confirmation_copy = libc::fcntl(confirmation_write_fd, libc::F_DUPFD_CLOEXEC, 10);
            let release_copy = libc::fcntl(release_read_fd, libc::F_DUPFD_CLOEXEC, 10);
            if confirmation_copy < 0
                || release_copy < 0
                || libc::dup2(confirmation_copy, SANDBOX_CONFIRMATION_FD) < 0
                || libc::dup2(release_copy, SANDBOX_RELEASE_FD) < 0
            {
                return Err(io::Error::last_os_error());
            }
            if libc::fcntl(SANDBOX_CONFIRMATION_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(SANDBOX_RELEASE_FD, libc::F_SETFD, 0) < 0
            {
                return Err(io::Error::last_os_error());
            }
            for descriptor in [
                confirmation_read_fd,
                confirmation_write_fd,
                release_read_fd,
                release_write_fd,
            ] {
                if descriptor != SANDBOX_CONFIRMATION_FD && descriptor != SANDBOX_RELEASE_FD {
                    libc::close(descriptor);
                }
            }
            libc::close(confirmation_copy);
            libc::close(release_copy);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| SeatbeltUnavailableReason::ProfileRejected)?;
    drop(confirmation_write);
    drop(release_read);

    let confirmation = match read_exact_with_timeout(
        confirmation_read.as_raw_fd(),
        CONFIRMATION_FRAME_BYTES,
        Duration::from_secs(3),
    ) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SeatbeltUnavailableReason::ConfirmationFailed);
        }
    };
    if parse_confirmation_frame(&confirmation).ok() != Some(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SeatbeltUnavailableReason::ConfirmationFailed);
    }
    crate::platform::bootstrap::release_gate(release_write).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        SeatbeltUnavailableReason::ConfirmationFailed
    })?;

    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SeatbeltUnavailableReason::ProbeTimedOut);
            }
            Err(_) => return Err(SeatbeltUnavailableReason::ProbeContractFailed),
        }
    };
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_end(&mut stderr);
    }
    if status.success() {
        Ok(())
    } else if stderr.starts_with(b"sandbox-exec:") {
        Err(SeatbeltUnavailableReason::ProfileRejected)
    } else {
        Err(SeatbeltUnavailableReason::ProbeContractFailed)
    }
}

#[cfg(target_os = "macos")]
fn validate_system_sandbox_executable(path: &Path) -> Result<(), SeatbeltUnavailableReason> {
    use std::os::unix::fs::MetadataExt;

    if path != Path::new(SANDBOX_EXEC_PATH) {
        return Err(SeatbeltUnavailableReason::SystemExecutableInvalid);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| SeatbeltUnavailableReason::SystemExecutableInvalid)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o111 == 0
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(SeatbeltUnavailableReason::SystemExecutableInvalid);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_exact_with_timeout(
    descriptor: i32,
    length: usize,
    timeout: std::time::Duration,
) -> io::Result<Vec<u8>> {
    use std::time::Instant;

    let deadline = Instant::now() + timeout;
    let mut bytes = vec![0u8; length];
    let mut offset = 0;
    while offset < length {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "sandbox confirmation timed out",
            ));
        }
        let milliseconds = remaining.as_millis().min(i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd: descriptor,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        // SAFETY: poll receives one initialized pollfd for the bounded timeout.
        let polled = unsafe { libc::poll(&mut poll, 1, milliseconds.max(1)) };
        if polled < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if polled == 0 {
            continue;
        }
        // SAFETY: read writes at most the remaining initialized vector capacity.
        let read = unsafe {
            libc::read(
                descriptor,
                bytes[offset..].as_mut_ptr().cast::<libc::c_void>(),
                length - offset,
            )
        };
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "sandbox confirmation ended early",
            ));
        }
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        offset += read as usize;
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
pub fn wait_for_confirmation(
    read: crate::platform::bootstrap::BootstrapRead,
    expected_pid: u32,
    timeout: std::time::Duration,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let bytes = read_exact_with_timeout(read.as_raw_fd(), CONFIRMATION_FRAME_BYTES, timeout)?;
    let actual_pid = parse_confirmation_frame(&bytes)?;
    if actual_pid != expected_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox confirmation PID does not match the owned process",
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn wait_for_confirmation(
    _read: crate::platform::bootstrap::BootstrapRead,
    _expected_pid: u32,
    _timeout: std::time::Duration,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS sandbox confirmation is unavailable",
    ))
}

#[cfg(target_os = "macos")]
struct ProbeRoot {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl ProbeRoot {
    fn create() -> io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;

        let base = fs::canonicalize(std::env::temp_dir())?;
        let path = base.join(format!("koda-seatbelt-probe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(Self { path })
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProbeRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(target_os = "macos")]
pub fn run_probe_contract(allowed_path: &Path, denied_path: &Path) -> io::Result<()> {
    use std::fs::OpenOptions;
    use std::net::TcpListener;

    if fs::read(allowed_path)? != b"koda-seatbelt-probe" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sandbox probe could not read the allowed fixture",
        ));
    }
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(denied_path)
    {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(denied_path);
            return Err(io::Error::other("sandbox probe unexpectedly wrote a file"));
        }
        Err(error) if permission_denied(&error) => {}
        Err(error) => return Err(error),
    }
    match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => {
            drop(listener);
            Err(io::Error::other(
                "sandbox probe unexpectedly opened a network listener",
            ))
        }
        Err(error) if permission_denied(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn run_probe_contract(_allowed_path: &Path, _denied_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS Seatbelt probe is unavailable",
    ))
}

#[cfg(target_os = "macos")]
fn permission_denied(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(code) if code == libc::EPERM || code == libc::EACCES)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("koda-seatbelt-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn policy(
        root: &Path,
        filesystem: FilesystemPolicy,
        network: NetworkPolicy,
    ) -> ExecutionPolicy {
        ExecutionPolicy {
            schema_version: 1,
            workspace_root: root.to_str().unwrap().to_owned(),
            filesystem,
            network,
            process_isolation: ProcessIsolationPolicy::Inherit,
            environment: EnvironmentPolicy::Explicit,
        }
    }

    #[test]
    fn confirmation_frame_is_fixed_and_rejects_malformed_input() {
        let frame = confirmation_frame(42);
        assert_eq!(parse_confirmation_frame(&frame).unwrap(), 42);
        assert!(parse_confirmation_frame(&frame[..19]).is_err());
        let mut wrong_marker = frame;
        wrong_marker[0] ^= 1;
        assert!(parse_confirmation_frame(&wrong_marker).is_err());
        assert!(parse_confirmation_frame(&confirmation_frame(0)).is_err());
    }

    #[test]
    fn bootstrap_rejects_standard_descriptors_before_exec() {
        assert!(run_sandbox_bootstrap(2, 3, vec!["/usr/bin/true".into()]).is_err());
        assert!(run_sandbox_bootstrap(3, 3, vec!["/usr/bin/true".into()]).is_err());
    }

    #[test]
    fn parameter_paths_are_absolute_utf8_and_bounded() {
        assert!(validate_parameter_path(Path::new("relative")).is_err());
        let oversized = format!("/{}", "x".repeat(MAX_PARAMETER_PATH_BYTES));
        assert!(validate_parameter_path(Path::new(&oversized)).is_err());
        assert!(validate_parameter_path(Path::new("/valid/path")).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_executable_and_probe_inputs_fail_closed() {
        assert!(validate_system_sandbox_executable(Path::new("/usr/bin/true")).is_err());
        assert!(matches!(
            probe(Path::new("/definitely/missing/koda-exec")),
            MacosSeatbeltAvailability::Unavailable(SeatbeltUnavailableReason::ProbeSetupFailed)
        ));
    }

    #[test]
    fn read_only_profile_has_no_general_write_or_network_grant() {
        let workspace = TestDirectory::new("readonly");
        let invocation = build_invocation(
            &policy(
                &workspace.0,
                FilesystemPolicy::ReadOnly,
                NetworkPolicy::Deny,
            ),
            &workspace.0,
            None,
        )
        .unwrap();
        assert!(!invocation.profile().contains("(allow file-write* (subpath"));
        assert!(!invocation.profile().contains("(allow network*)"));
        assert_eq!(invocation.parameters().len(), 1);
    }

    #[test]
    fn secret_files_are_exact_read_only_parameters_and_require_mode_0400() {
        let workspace = TestDirectory::new("secret-workspace");
        let secret_root = TestDirectory::new("secret-root");
        let secret = secret_root
            .0
            .join(uuid::Uuid::new_v4().simple().to_string());
        fs::write(&secret, b"secret-value").unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o400)).unwrap();
        let invocation = build_invocation_with_secret_files(
            &policy(
                &workspace.0,
                FilesystemPolicy::ReadOnly,
                NetworkPolicy::Deny,
            ),
            &workspace.0,
            None,
            std::slice::from_ref(&secret),
        )
        .unwrap();
        assert!(invocation.profile().contains("SECRET_FILE_0"));
        assert!(!invocation.profile().contains(secret.to_str().unwrap()));
        assert!(
            invocation
                .parameters()
                .contains(&("SECRET_FILE_0".into(), secret.clone()))
        );

        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            build_invocation_with_secret_files(
                &policy(
                    &workspace.0,
                    FilesystemPolicy::ReadOnly,
                    NetworkPolicy::Deny,
                ),
                &workspace.0,
                None,
                &[secret],
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_write_profile_has_only_validated_write_roots() {
        let workspace = TestDirectory::new("workspace");
        let scratch = TestDirectory::new("scratch");
        let invocation = build_invocation(
            &policy(
                &workspace.0,
                FilesystemPolicy::WorkspaceWrite,
                NetworkPolicy::Inherit,
            ),
            &workspace.0,
            Some(&scratch.0),
        )
        .unwrap();
        assert_eq!(
            invocation
                .profile()
                .matches("(allow file-write* (subpath")
                .count(),
            2
        );
        assert!(invocation.profile().contains("(allow network*)"));
        assert_eq!(invocation.parameters().len(), 2);
        assert!(invocation.profile().len() <= MAX_PROFILE_BYTES);
    }

    #[test]
    fn network_only_profile_preserves_unrestricted_filesystem() {
        let workspace = TestDirectory::new("network-only");
        let invocation = build_invocation(
            &policy(
                &workspace.0,
                FilesystemPolicy::Unrestricted,
                NetworkPolicy::Deny,
            ),
            &workspace.0,
            None,
        )
        .unwrap();
        assert!(invocation.profile().contains("(allow file-write*)"));
        assert!(!invocation.profile().contains("(allow network*)"));
        assert_eq!(invocation.parameters().len(), 1);
    }

    #[test]
    fn path_syntax_is_never_interpolated_into_profile() {
        let workspace = TestDirectory::new("root-\")-(allow network*)-(\"");
        let policy = policy(
            &workspace.0,
            FilesystemPolicy::ReadOnly,
            NetworkPolicy::Deny,
        );
        let invocation = build_invocation(&policy, &workspace.0, None).unwrap();
        let path = workspace.0.to_str().unwrap();
        assert!(!invocation.profile().contains(path));
        let argv = invocation
            .command_argv(&[OsString::from("/usr/bin/true")])
            .unwrap();
        assert!(argv.iter().any(|value| {
            value
                .to_str()
                .is_some_and(|value| value == format!("-DWORKSPACE_ROOT={path}"))
        }));
    }

    #[test]
    fn invalid_scratch_and_policy_combinations_fail_closed() {
        let workspace = TestDirectory::new("invalid-workspace");
        let scratch = TestDirectory::new("invalid-scratch");
        fs::write(scratch.0.join("not-empty"), b"x").unwrap();
        assert!(
            build_invocation(
                &policy(
                    &workspace.0,
                    FilesystemPolicy::WorkspaceWrite,
                    NetworkPolicy::Deny,
                ),
                &workspace.0,
                Some(&scratch.0),
            )
            .is_err()
        );
        assert!(
            build_invocation(
                &policy(
                    &workspace.0,
                    FilesystemPolicy::ReadOnly,
                    NetworkPolicy::Deny
                ),
                &workspace.0,
                Some(&scratch.0),
            )
            .is_err()
        );
        assert!(
            build_invocation(
                &policy(
                    &workspace.0,
                    FilesystemPolicy::Unrestricted,
                    NetworkPolicy::Inherit,
                ),
                &workspace.0,
                None,
            )
            .is_err()
        );

        let unsafe_scratch = TestDirectory::new("unsafe-scratch");
        fs::set_permissions(&unsafe_scratch.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            build_invocation(
                &policy(
                    &workspace.0,
                    FilesystemPolicy::WorkspaceWrite,
                    NetworkPolicy::Deny,
                ),
                &workspace.0,
                Some(&unsafe_scratch.0),
            )
            .is_err()
        );
    }

    #[test]
    fn sandbox_command_has_fixed_executable_and_no_shell_reconstruction() {
        let workspace = TestDirectory::new("argv");
        let invocation = build_invocation(
            &policy(
                &workspace.0,
                FilesystemPolicy::ReadOnly,
                NetworkPolicy::Deny,
            ),
            &workspace.0,
            None,
        )
        .unwrap();
        let command = [
            OsString::from("/bin/echo"),
            OsString::from("a; touch /tmp/x"),
        ];
        let argv = invocation.command_argv(&command).unwrap();
        assert_eq!(argv[0], std::ffi::OsStr::new(SANDBOX_EXEC_PATH));
        assert_eq!(&argv[argv.len() - 2..], command.as_slice());
    }
}
