#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::execution_policy::{
    EnvironmentPolicy, ExecutionCapabilities, ExecutionPolicy, ExecutionPolicyError,
    FilesystemPolicy, LinuxBubblewrapRuntimeDescriptor, NetworkPolicy, ProcessIsolationPolicy,
};

pub const BUBBLEWRAP_OVERRIDE: &str = "KODA_BWRAP_PATH";
pub const LINUX_SANDBOX_CONFIRMATION_FD: i32 = 4;
pub const LINUX_SANDBOX_RELEASE_FD: i32 = 5;
const PROBE_REVISION: u32 = 1;
const BUILDER_REVISION: &[u8] = b"koda-linux-bubblewrap-builder-v1";
const MAX_VERSION_BYTES: usize = 256;
const MAX_CAPTURE_BYTES: usize = 4 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CONFIRMATION_MAGIC: &[u8; 16] = b"KODA-LINUX-V001!";
const CONFIRMATION_FRAME_BYTES: usize = 112;
pub const LINUX_SANDBOX_FAULT_ENV: &str = "KODA_EXEC_TEST_FAULT_POINT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BubblewrapUnavailableReason {
    #[cfg(not(target_os = "linux"))]
    UnsupportedPlatform,
    CandidateUnavailable,
    CandidateInvalid,
    VersionInvalid,
    ProbeSetupFailed,
    ProbeSpawnFailed,
    ConfirmationFailed,
    ProbeContractFailed,
    WorkspaceWriteProbeFailed,
    ReadOnlyProbeFailed,
    NetworkInheritProbeFailed,
    ReleaseGateProbeFailed,
    ProbeTimedOut,
}

impl BubblewrapUnavailableReason {
    pub fn summary(self) -> &'static str {
        match self {
            #[cfg(not(target_os = "linux"))]
            Self::UnsupportedPlatform => "the host is not Linux",
            Self::CandidateUnavailable => "no trusted Bubblewrap candidate was found",
            Self::CandidateInvalid => "the selected Bubblewrap executable failed identity checks",
            Self::VersionInvalid => "Bubblewrap returned invalid bounded version data",
            Self::ProbeSetupFailed => "the Linux isolation probe could not be prepared",
            Self::ProbeSpawnFailed => "Bubblewrap could not start the Linux isolation probe",
            Self::ConfirmationFailed => "the Linux sandbox bootstrap did not confirm confinement",
            Self::ProbeContractFailed => {
                "the Linux isolation self-test did not enforce its contract"
            }
            Self::WorkspaceWriteProbeFailed => {
                "the workspace-write Linux isolation self-test failed"
            }
            Self::ReadOnlyProbeFailed => "the read-only Linux isolation self-test failed",
            Self::NetworkInheritProbeFailed => {
                "the inherited-network Linux isolation self-test failed"
            }
            Self::ReleaseGateProbeFailed => "the Linux user-code release-gate self-test failed",
            Self::ProbeTimedOut => "the Linux isolation self-test timed out",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxBubblewrapAvailability {
    Verified(LinuxBubblewrapRuntimeDescriptor),
    Unavailable(BubblewrapUnavailableReason),
}

impl LinuxBubblewrapAvailability {
    pub fn descriptor(&self) -> Option<&LinuxBubblewrapRuntimeDescriptor> {
        match self {
            Self::Verified(descriptor) => Some(descriptor),
            Self::Unavailable(_) => None,
        }
    }

    pub fn is_verified(&self) -> bool {
        matches!(self, Self::Verified(_))
    }

    pub fn unavailable_reason(&self) -> Option<BubblewrapUnavailableReason> {
        match self {
            Self::Verified(_) => None,
            Self::Unavailable(reason) => Some(*reason),
        }
    }
}

pub fn probe(binary_path: &Path) -> LinuxBubblewrapAvailability {
    probe_platform(binary_path)
}

pub fn requires_bubblewrap(policy: &ExecutionPolicy) -> bool {
    policy.filesystem != FilesystemPolicy::Unrestricted || policy.network != NetworkPolicy::Inherit
}

#[cfg(not(target_os = "linux"))]
fn probe_platform(_binary_path: &Path) -> LinuxBubblewrapAvailability {
    LinuxBubblewrapAvailability::Unavailable(BubblewrapUnavailableReason::UnsupportedPlatform)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BubblewrapInvocation {
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl BubblewrapInvocation {
    pub fn command_argv(&self) -> Vec<OsString> {
        let mut argv = Vec::with_capacity(self.arguments.len() + 1);
        argv.push(self.executable.as_os_str().to_owned());
        argv.extend(self.arguments.iter().cloned());
        argv
    }

    #[cfg(test)]
    fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

pub struct BubblewrapLaunch<'a> {
    pub binary_path: &'a Path,
    pub policy: &'a ExecutionPolicy,
    pub workspace_root: &'a Path,
    pub cwd: &'a Path,
    pub scratch_root: Option<&'a Path>,
    pub confirmation_digest: &'a [u8; 32],
    pub argv: &'a [OsString],
}

pub fn build_invocation(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    launch: BubblewrapLaunch<'_>,
) -> Result<BubblewrapInvocation, ExecutionPolicyError> {
    let BubblewrapLaunch {
        binary_path,
        policy,
        workspace_root,
        cwd,
        scratch_root,
        confirmation_digest,
        argv,
    } = launch;
    runtime.validate()?;
    policy.validate()?;
    if !requires_bubblewrap(policy)
        || policy.process_isolation != ProcessIsolationPolicy::Inherit
        || policy.environment != EnvironmentPolicy::Explicit
        || argv.is_empty()
    {
        return Err(ExecutionPolicyError::ExecutionPolicyUnavailable);
    }
    let executable = PathBuf::from(&runtime.canonical_path);
    if !executable.is_absolute() || !binary_path.is_absolute() {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let workspace = validate_canonical_directory(workspace_root)?;
    if workspace.to_str() != Some(policy.workspace_root.as_str()) {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let cwd = validate_canonical_directory(cwd)?;
    if !cwd.starts_with(&workspace) {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let scratch = match (policy.filesystem, scratch_root) {
        (FilesystemPolicy::WorkspaceWrite, Some(path)) => {
            let path = validate_private_empty_directory(path)?;
            if path == workspace || path.starts_with(&workspace) || workspace.starts_with(&path) {
                return Err(ExecutionPolicyError::InvalidExecutionPolicy);
            }
            Some(path)
        }
        (FilesystemPolicy::WorkspaceWrite, None) => {
            return Err(ExecutionPolicyError::InvalidExecutionPolicy);
        }
        (_, None) => None,
        (_, Some(_)) => return Err(ExecutionPolicyError::InvalidExecutionPolicy),
    };

    let mut arguments = vec![
        OsString::from("--die-with-parent"),
        OsString::from("--unshare-user"),
        OsString::from("--disable-userns"),
        OsString::from("--unshare-ipc"),
        OsString::from("--cap-drop"),
        OsString::from("ALL"),
        OsString::from("--ro-bind"),
        OsString::from("/"),
        OsString::from("/"),
        OsString::from("--remount-ro"),
        OsString::from("/"),
        OsString::from("--dev"),
        OsString::from("/dev"),
        OsString::from("--remount-ro"),
        OsString::from("/dev"),
        OsString::from("--remount-ro"),
        OsString::from("/dev/shm"),
        OsString::from("--ro-bind"),
        OsString::from("/run"),
        OsString::from("/run"),
    ];
    if policy.filesystem == FilesystemPolicy::WorkspaceWrite {
        arguments.extend([
            OsString::from("--bind"),
            workspace.as_os_str().to_owned(),
            workspace.as_os_str().to_owned(),
        ]);
        let scratch = scratch.as_ref().expect("validated workspace-write scratch");
        arguments.extend([
            OsString::from("--bind"),
            scratch.as_os_str().to_owned(),
            scratch.as_os_str().to_owned(),
        ]);
    }
    if policy.network == NetworkPolicy::Deny {
        arguments.push(OsString::from("--unshare-net"));
    }
    arguments.extend([
        OsString::from("--chdir"),
        cwd.as_os_str().to_owned(),
        OsString::from("--"),
        binary_path.as_os_str().to_owned(),
        OsString::from("linux-sandbox-bootstrap"),
        OsString::from("--confirm-fd"),
        OsString::from(LINUX_SANDBOX_CONFIRMATION_FD.to_string()),
        OsString::from("--release-fd"),
        OsString::from(LINUX_SANDBOX_RELEASE_FD.to_string()),
        OsString::from("--network"),
        OsString::from(if policy.network == NetworkPolicy::Deny {
            "deny"
        } else {
            "inherit"
        }),
        OsString::from("--digest"),
        OsString::from(hex_bytes(confirmation_digest)),
        OsString::from("--"),
    ]);
    arguments.extend(argv.iter().cloned());
    Ok(BubblewrapInvocation {
        executable,
        arguments,
    })
}

pub fn launch_confirmation_digest(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    policy: &ExecutionPolicy,
    capabilities: &ExecutionCapabilities,
) -> Result<[u8; 32], ExecutionPolicyError> {
    runtime.validate()?;
    policy.validate()?;
    capabilities.validate()?;
    if capabilities.schema_version != 3 || capabilities.sandbox_runtime.as_ref() != Some(runtime) {
        return Err(ExecutionPolicyError::ExecutionPolicyUnavailable);
    }
    let mut digest = Sha256::new();
    digest.update(BUILDER_REVISION);
    digest.update([0]);
    digest.update(policy.canonical_json()?.as_bytes());
    digest.update([0]);
    digest.update(capabilities.canonical_json()?.as_bytes());
    Ok(digest.finalize().into())
}

fn validate_canonical_directory(path: &Path) -> Result<PathBuf, ExecutionPolicyError> {
    if !path.is_absolute() || path.to_str().is_none() {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| ExecutionPolicyError::InvalidExecutionPolicy)?;
    if canonical != path {
        return Err(ExecutionPolicyError::InvalidExecutionPolicy);
    }
    Ok(canonical)
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
struct NamespaceIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxSandboxConfirmation {
    pub pid: u32,
    pub process_group_id: u32,
    mount_namespace: NamespaceIdentity,
    user_namespace: NamespaceIdentity,
    network_namespace: NamespaceIdentity,
    pub no_new_privs: bool,
    pub seccomp_mode: u8,
    pub network_denied: bool,
    pub digest: [u8; 32],
}

fn confirmation_frame(value: &LinuxSandboxConfirmation) -> [u8; CONFIRMATION_FRAME_BYTES] {
    let mut bytes = [0u8; CONFIRMATION_FRAME_BYTES];
    bytes[..16].copy_from_slice(CONFIRMATION_MAGIC);
    put_u32(&mut bytes, 16, value.pid);
    put_u32(&mut bytes, 20, value.process_group_id);
    put_namespace(&mut bytes, 24, value.mount_namespace);
    put_namespace(&mut bytes, 40, value.user_namespace);
    put_namespace(&mut bytes, 56, value.network_namespace);
    bytes[72] = u8::from(value.no_new_privs);
    bytes[73] = value.seccomp_mode;
    bytes[74] = u8::from(value.network_denied);
    bytes[80..112].copy_from_slice(&value.digest);
    bytes
}

pub fn parse_confirmation_frame(bytes: &[u8]) -> io::Result<LinuxSandboxConfirmation> {
    if bytes.len() != CONFIRMATION_FRAME_BYTES
        || &bytes[..16] != CONFIRMATION_MAGIC
        || bytes[75..80].iter().any(|byte| *byte != 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux sandbox confirmation frame is invalid",
        ));
    }
    let value = LinuxSandboxConfirmation {
        pid: get_u32(bytes, 16)?,
        process_group_id: get_u32(bytes, 20)?,
        mount_namespace: get_namespace(bytes, 24)?,
        user_namespace: get_namespace(bytes, 40)?,
        network_namespace: get_namespace(bytes, 56)?,
        no_new_privs: match bytes[72] {
            0 => false,
            1 => true,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid no_new_privs",
                ));
            }
        },
        seccomp_mode: bytes[73],
        network_denied: match bytes[74] {
            0 => false,
            1 => true,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid network mode",
                ));
            }
        },
        digest: bytes[80..112]
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid digest"))?,
    };
    if value.pid == 0 || value.process_group_id == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux sandbox process identity is invalid",
        ));
    }
    Ok(value)
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn get_u32(bytes: &[u8], offset: usize) -> io::Result<u32> {
    Ok(u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid u32 field"))?,
    ))
}

fn put_namespace(bytes: &mut [u8], offset: usize, value: NamespaceIdentity) {
    bytes[offset..offset + 8].copy_from_slice(&value.device.to_be_bytes());
    bytes[offset + 8..offset + 16].copy_from_slice(&value.inode.to_be_bytes());
}

fn get_namespace(bytes: &[u8], offset: usize) -> io::Result<NamespaceIdentity> {
    Ok(NamespaceIdentity {
        device: u64::from_be_bytes(
            bytes[offset..offset + 8]
                .try_into()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid namespace"))?,
        ),
        inode: u64::from_be_bytes(
            bytes[offset + 8..offset + 16]
                .try_into()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid namespace"))?,
        ),
    })
}

#[cfg(target_os = "linux")]
pub fn run_sandbox_bootstrap(
    confirmation_fd: i32,
    release_fd: i32,
    network_denied: bool,
    digest_hex: &str,
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
            "Linux sandbox bootstrap arguments are invalid",
        ));
    }
    validate_pipe_descriptor(confirmation_fd)?;
    validate_pipe_descriptor(release_fd)?;
    let digest = parse_hex_digest(digest_hex)?;
    linux_bootstrap_fault("after_linux_namespace_setup");
    close_inherited_descriptors(confirmation_fd, release_fd)?;
    install_seccomp(network_denied)?;
    linux_bootstrap_fault("after_linux_seccomp");
    let confirmation = LinuxSandboxConfirmation {
        pid: std::process::id(),
        // SAFETY: getpgrp has no preconditions.
        process_group_id: unsafe { libc::getpgrp() } as u32,
        mount_namespace: namespace_identity(Path::new("/proc/self/ns/mnt"))?,
        user_namespace: namespace_identity(Path::new("/proc/self/ns/user"))?,
        network_namespace: namespace_identity(Path::new("/proc/self/ns/net"))?,
        // SAFETY: PR_GET_NO_NEW_PRIVS reads current process state.
        no_new_privs: unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } == 1,
        // SAFETY: PR_GET_SECCOMP reads current process state.
        seccomp_mode: unsafe { libc::prctl(libc::PR_GET_SECCOMP, 0, 0, 0, 0) } as u8,
        network_denied,
        digest,
    };
    // SAFETY: this bootstrap exclusively owns the inherited descriptors.
    let mut confirmation_pipe = unsafe { File::from_raw_fd(confirmation_fd) };
    // SAFETY: this bootstrap exclusively owns the distinct inherited descriptor.
    let mut release_pipe = unsafe { File::from_raw_fd(release_fd) };
    confirmation_pipe.write_all(&confirmation_frame(&confirmation))?;
    drop(confirmation_pipe);
    let mut byte = [0u8; 1];
    release_pipe.read_exact(&mut byte)?;
    if byte[0] != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Linux sandbox release gate value is invalid",
        ));
    }
    drop(release_pipe);
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).env_remove(LINUX_SANDBOX_FAULT_ENV);
    let error = CommandExt::exec(&mut command);
    Err(error)
}

#[cfg(target_os = "linux")]
fn linux_bootstrap_fault(name: &str) {
    if std::env::var(LINUX_SANDBOX_FAULT_ENV).as_deref() == Ok(name) {
        std::process::abort();
    }
}

#[cfg(not(target_os = "linux"))]
pub fn run_sandbox_bootstrap(
    _confirmation_fd: i32,
    _release_fd: i32,
    _network_denied: bool,
    _digest_hex: &str,
    _argv: Vec<String>,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Linux sandbox bootstrap is unavailable",
    ))
}

#[cfg(target_os = "linux")]
fn namespace_identity(path: &Path) -> io::Result<NamespaceIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path)?;
    Ok(NamespaceIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(target_os = "linux")]
fn validate_pipe_descriptor(descriptor: i32) -> io::Result<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat initializes stat for a valid descriptor and retains no pointer.
    if unsafe { libc::fstat(descriptor, stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Linux sandbox bootstrap descriptor is not a pipe",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn close_inherited_descriptors(confirmation_fd: i32, release_fd: i32) -> io::Result<()> {
    let mut descriptors = Vec::new();
    for entry in fs::read_dir("/proc/self/fd")? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Ok(descriptor) = name.parse::<i32>()
            && descriptor > 2
            && descriptor != confirmation_fd
            && descriptor != release_fd
        {
            descriptors.push(descriptor);
        }
    }
    for descriptor in descriptors {
        // SAFETY: closing an inherited descriptor by value retains no pointer.
        unsafe { libc::close(descriptor) };
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_seccomp(network_denied: bool) -> io::Result<()> {
    // SAFETY: prctl is called with the documented scalar no_new_privs arguments.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut filter = seccomp_filter(network_denied)?;
    let program = libc::sock_fprog {
        len: u16::try_from(filter.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "seccomp filter too large"))?,
        filter: filter.as_mut_ptr(),
    };
    // SAFETY: the kernel copies the bounded BPF program during prctl.
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn seccomp_filter(network_denied: bool) -> io::Result<Vec<libc::sock_filter>> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_JMP_JSET_K: u16 = 0x45;
    const BPF_RET_K: u16 = 0x06;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xc000_003e;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xc000_00b7;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Linux sandbox seccomp architecture is unsupported",
    ));

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let statement = |code, value| libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k: value,
        };
        let jump = |code, value, jt, jf| libc::sock_filter {
            code,
            jt,
            jf,
            k: value,
        };
        let deny = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let mut filter = vec![
            statement(BPF_LD_W_ABS, 4),
            jump(BPF_JMP_JEQ_K, AUDIT_ARCH, 1, 0),
            statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
            statement(BPF_LD_W_ABS, 0),
        ];
        let mut denied_syscalls = vec![
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_setuid,
            libc::SYS_setreuid,
            libc::SYS_setresuid,
            libc::SYS_setfsuid,
            libc::SYS_setgid,
            libc::SYS_setregid,
            libc::SYS_setresgid,
            libc::SYS_setfsgid,
        ];
        if network_denied {
            denied_syscalls.extend([
                libc::SYS_socket,
                libc::SYS_socketpair,
                libc::SYS_io_uring_setup,
                libc::SYS_io_uring_enter,
                libc::SYS_io_uring_register,
            ]);
        }
        for syscall in denied_syscalls {
            filter.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, 1));
            filter.push(statement(BPF_RET_K, deny));
        }
        // Deny only TIOCSTI while preserving ordinary terminal ioctls.
        filter.push(jump(BPF_JMP_JEQ_K, libc::SYS_ioctl as u32, 0, 3));
        filter.push(statement(BPF_LD_W_ABS, 24));
        filter.push(jump(BPF_JMP_JEQ_K, libc::TIOCSTI as u32, 0, 1));
        filter.push(statement(BPF_RET_K, deny));
        filter.push(statement(BPF_LD_W_ABS, 0));
        // Classic clone remains available unless it requests a new user namespace.
        filter.push(jump(BPF_JMP_JEQ_K, libc::SYS_clone as u32, 0, 3));
        filter.push(statement(BPF_LD_W_ABS, 16));
        filter.push(jump(BPF_JMP_JSET_K, libc::CLONE_NEWUSER as u32, 0, 1));
        filter.push(statement(BPF_RET_K, deny));
        filter.push(statement(BPF_RET_K, SECCOMP_RET_ALLOW));
        Ok(filter)
    }
}

#[cfg(target_os = "linux")]
fn parse_hex_digest(value: &str) -> io::Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid digest",
        ));
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid digest"))?;
    }
    Ok(digest)
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

#[cfg(target_os = "linux")]
fn probe_platform(binary_path: &Path) -> LinuxBubblewrapAvailability {
    match run_probe(binary_path) {
        Ok(descriptor) => LinuxBubblewrapAvailability::Verified(descriptor),
        Err(reason) => LinuxBubblewrapAvailability::Unavailable(reason),
    }
}

#[cfg(target_os = "linux")]
fn run_probe(
    binary_path: &Path,
) -> Result<LinuxBubblewrapRuntimeDescriptor, BubblewrapUnavailableReason> {
    use std::os::unix::fs::PermissionsExt;

    let binary =
        fs::canonicalize(binary_path).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    if !binary.is_file() {
        return Err(BubblewrapUnavailableReason::ProbeSetupFailed);
    }
    let descriptor = discover_runtime()?;
    let root = ProbeRoot::create().map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let workspace = root.path.join("workspace");
    let scratch = root.path.join("scratch");
    fs::create_dir(&workspace).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    fs::create_dir(&scratch).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let workspace =
        fs::canonicalize(workspace).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let scratch =
        fs::canonicalize(scratch).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    fs::write(workspace.join("readable.txt"), b"koda-linux-probe")
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let external = root.path.join("external-write");

    run_contract_probe(
        &descriptor,
        &binary,
        &workspace,
        Some(&scratch),
        &external,
        ProbeKind::WorkspaceWriteDeny,
        None,
    )
    .map_err(|_| BubblewrapUnavailableReason::WorkspaceWriteProbeFailed)?;
    // The workspace-write probe leaves fixtures behind; reset scratch before
    // it is reused as a validated empty bind source.
    fs::remove_file(workspace.join("workspace-write.txt"))
        .map_err(|_| BubblewrapUnavailableReason::WorkspaceWriteProbeFailed)?;
    fs::remove_file(scratch.join("scratch-write.txt"))
        .map_err(|_| BubblewrapUnavailableReason::WorkspaceWriteProbeFailed)?;
    run_contract_probe(
        &descriptor,
        &binary,
        &workspace,
        None,
        &external,
        ProbeKind::ReadOnlyDeny,
        None,
    )
    .map_err(|_| BubblewrapUnavailableReason::ReadOnlyProbeFailed)?;

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    listener
        .set_nonblocking(true)
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let port = listener
        .local_addr()
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?
        .port();
    let server = std::thread::spawn(move || -> io::Result<()> {
        use std::io::Write;
        use std::time::{Duration, Instant};

        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    return stream.write_all(b"koda-linux-network-inherit");
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "network-inherit probe did not connect",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    });
    let inherit_result = run_contract_probe(
        &descriptor,
        &binary,
        &workspace,
        None,
        &external,
        ProbeKind::ReadOnlyInherit,
        Some(port),
    );
    let server_result = server
        .join()
        .map_err(|_| BubblewrapUnavailableReason::ProbeContractFailed)?;
    inherit_result.map_err(|_| BubblewrapUnavailableReason::NetworkInheritProbeFailed)?;
    server_result.map_err(|_| BubblewrapUnavailableReason::NetworkInheritProbeFailed)?;

    run_release_abort_probe(&descriptor, &binary, &workspace)
        .map_err(|_| BubblewrapUnavailableReason::ReleaseGateProbeFailed)?;
    Ok(descriptor)
}

#[cfg(target_os = "linux")]
fn discover_runtime() -> Result<LinuxBubblewrapRuntimeDescriptor, BubblewrapUnavailableReason> {
    let override_path = std::env::var_os(BUBBLEWRAP_OVERRIDE);
    let mut candidates = Vec::new();
    if let Some(path) = override_path.as_ref() {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(BubblewrapUnavailableReason::CandidateInvalid);
        }
        candidates.push((path, true));
    }
    candidates.extend([
        (PathBuf::from("/usr/bin/bwrap"), false),
        (PathBuf::from("/bin/bwrap"), false),
    ]);
    let mut saw_candidate = false;
    for (path, explicit) in candidates {
        if !path.exists() {
            continue;
        }
        saw_candidate = true;
        match runtime_descriptor(&path, explicit) {
            Ok(descriptor) => return Ok(descriptor),
            Err(BubblewrapUnavailableReason::VersionInvalid) => {
                return Err(BubblewrapUnavailableReason::VersionInvalid);
            }
            Err(_) if explicit => return Err(BubblewrapUnavailableReason::CandidateInvalid),
            Err(_) => continue,
        }
    }
    Err(if saw_candidate {
        BubblewrapUnavailableReason::CandidateInvalid
    } else {
        BubblewrapUnavailableReason::CandidateUnavailable
    })
}

#[cfg(target_os = "linux")]
fn runtime_descriptor(
    candidate: &Path,
    explicit: bool,
) -> Result<LinuxBubblewrapRuntimeDescriptor, BubblewrapUnavailableReason> {
    use std::os::unix::fs::MetadataExt;

    let canonical =
        fs::canonicalize(candidate).map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
    let path = canonical
        .to_str()
        .ok_or(BubblewrapUnavailableReason::CandidateInvalid)?;
    let before =
        fs::metadata(&canonical).map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
    // SAFETY: geteuid reads process credentials and has no preconditions.
    let euid = unsafe { libc::geteuid() };
    let owner_valid = before.uid() == 0 || (explicit && before.uid() == euid);
    if !before.is_file()
        || !owner_valid
        || before.mode() & 0o111 == 0
        || before.mode() & 0o022 != 0
        || before.size() > MAX_SAFE_INTEGER
    {
        return Err(BubblewrapUnavailableReason::CandidateInvalid);
    }
    let mtime_ns = metadata_mtime_ns(&before)?;
    let sha256 = sha256_file(&canonical)?;
    let after =
        fs::metadata(&canonical).map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.size() != after.size()
        || mtime_ns != metadata_mtime_ns(&after)?
    {
        return Err(BubblewrapUnavailableReason::CandidateInvalid);
    }
    let version = bubblewrap_version(&canonical)?;
    let descriptor = LinuxBubblewrapRuntimeDescriptor {
        schema_version: 1,
        mechanism: crate::execution_policy::EnforcementMechanism::LinuxBubblewrap,
        canonical_path: path.to_owned(),
        device: before.dev().to_string(),
        inode: before.ino().to_string(),
        size: before.size(),
        mtime_ns: mtime_ns.to_string(),
        sha256,
        version,
        probe_revision: PROBE_REVISION,
    };
    descriptor
        .validate()
        .map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
    Ok(descriptor)
}

#[cfg(target_os = "linux")]
fn metadata_mtime_ns(
    metadata: &impl std::os::unix::fs::MetadataExt,
) -> Result<u64, BubblewrapUnavailableReason> {
    let seconds = metadata.mtime();
    let nanos = metadata.mtime_nsec();
    if seconds < 0 || !(0..1_000_000_000).contains(&nanos) {
        return Err(BubblewrapUnavailableReason::CandidateInvalid);
    }
    u64::try_from(seconds)
        .ok()
        .and_then(|value| value.checked_mul(1_000_000_000))
        .and_then(|value| value.checked_add(nanos as u64))
        .ok_or(BubblewrapUnavailableReason::CandidateInvalid)
}

#[cfg(target_os = "linux")]
fn sha256_file(path: &Path) -> Result<String, BubblewrapUnavailableReason> {
    use std::io::Read;

    let mut file =
        fs::File::open(path).map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| BubblewrapUnavailableReason::CandidateInvalid)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "linux")]
fn bubblewrap_version(path: &Path) -> Result<String, BubblewrapUnavailableReason> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn drain(mut pipe: impl Read) -> (Vec<u8>, bool) {
        let mut retained = Vec::new();
        let mut overflow = false;
        let mut buffer = [0u8; 1024];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let remaining = MAX_CAPTURE_BYTES.saturating_sub(retained.len());
                    retained.extend_from_slice(&buffer[..read.min(remaining)]);
                    overflow |= read > remaining;
                }
            }
        }
        (retained, overflow)
    }

    let mut child = Command::new(path)
        .arg("--version")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| BubblewrapUnavailableReason::VersionInvalid)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(BubblewrapUnavailableReason::VersionInvalid)?;
    let stderr = child
        .stderr
        .take()
        .ok_or(BubblewrapUnavailableReason::VersionInvalid)?;
    let stdout_thread = std::thread::spawn(move || drain(stdout));
    let stderr_thread = std::thread::spawn(move || drain(stderr));
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BubblewrapUnavailableReason::VersionInvalid);
            }
            Err(_) => return Err(BubblewrapUnavailableReason::VersionInvalid),
        }
    };
    let (stdout, stdout_overflow) = stdout_thread
        .join()
        .map_err(|_| BubblewrapUnavailableReason::VersionInvalid)?;
    let (stderr, stderr_overflow) = stderr_thread
        .join()
        .map_err(|_| BubblewrapUnavailableReason::VersionInvalid)?;
    if !status.success() || stdout_overflow || stderr_overflow || !stderr.is_empty() {
        return Err(BubblewrapUnavailableReason::VersionInvalid);
    }
    let output =
        std::str::from_utf8(&stdout).map_err(|_| BubblewrapUnavailableReason::VersionInvalid)?;
    let lines = output.trim().lines().collect::<Vec<_>>();
    if lines.len() != 1 {
        return Err(BubblewrapUnavailableReason::VersionInvalid);
    }
    let normalized = lines[0].split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized.len() > MAX_VERSION_BYTES
        || normalized.chars().any(char::is_control)
    {
        return Err(BubblewrapUnavailableReason::VersionInvalid);
    }
    Ok(normalized)
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
enum ProbeKind {
    ReadOnlyDeny,
    WorkspaceWriteDeny,
    ReadOnlyInherit,
}

#[cfg(target_os = "linux")]
impl ProbeKind {
    fn name(self) -> &'static str {
        match self {
            Self::ReadOnlyDeny => "read-only-deny",
            Self::WorkspaceWriteDeny => "workspace-write-deny",
            Self::ReadOnlyInherit => "read-only-inherit",
        }
    }

    fn filesystem(self) -> FilesystemPolicy {
        match self {
            Self::WorkspaceWriteDeny => FilesystemPolicy::WorkspaceWrite,
            _ => FilesystemPolicy::ReadOnly,
        }
    }

    fn network(self) -> NetworkPolicy {
        match self {
            Self::ReadOnlyInherit => NetworkPolicy::Inherit,
            _ => NetworkPolicy::Deny,
        }
    }
}

#[cfg(target_os = "linux")]
fn probe_digest(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    kind: &str,
) -> Result<[u8; 32], BubblewrapUnavailableReason> {
    let mut digest = Sha256::new();
    digest.update(BUILDER_REVISION);
    digest.update([0]);
    digest.update(
        serde_json::to_vec(runtime).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?,
    );
    digest.update([0]);
    digest.update(kind.as_bytes());
    Ok(digest.finalize().into())
}

#[cfg(target_os = "linux")]
fn run_contract_probe(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    binary: &Path,
    workspace: &Path,
    scratch: Option<&Path>,
    external: &Path,
    kind: ProbeKind,
    port: Option<u16>,
) -> Result<(), BubblewrapUnavailableReason> {
    let policy = ExecutionPolicy {
        schema_version: 1,
        workspace_root: workspace
            .to_str()
            .ok_or(BubblewrapUnavailableReason::ProbeSetupFailed)?
            .to_owned(),
        filesystem: kind.filesystem(),
        network: kind.network(),
        process_isolation: ProcessIsolationPolicy::Inherit,
        environment: EnvironmentPolicy::Explicit,
    };
    let digest = probe_digest(runtime, kind.name())?;
    let mut probe_argv = vec![
        binary.as_os_str().to_owned(),
        OsString::from("linux-bubblewrap-probe"),
        OsString::from("--kind"),
        OsString::from(kind.name()),
        OsString::from("--workspace"),
        workspace.as_os_str().to_owned(),
        OsString::from("--external"),
        external.as_os_str().to_owned(),
    ];
    if let Some(scratch) = scratch {
        probe_argv.extend([OsString::from("--scratch"), scratch.as_os_str().to_owned()]);
    }
    if let Some(port) = port {
        probe_argv.extend([OsString::from("--port"), OsString::from(port.to_string())]);
    }
    let invocation = build_invocation(
        runtime,
        BubblewrapLaunch {
            binary_path: binary,
            policy: &policy,
            workspace_root: workspace,
            cwd: workspace,
            scratch_root: scratch,
            confirmation_digest: &digest,
            argv: &probe_argv,
        },
    )
    .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    spawn_and_verify_probe(
        runtime,
        invocation,
        kind.network() == NetworkPolicy::Deny,
        digest,
        true,
    )
}

#[cfg(target_os = "linux")]
fn run_release_abort_probe(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    binary: &Path,
    workspace: &Path,
) -> Result<(), BubblewrapUnavailableReason> {
    let scratch = workspace
        .parent()
        .ok_or(BubblewrapUnavailableReason::ProbeSetupFailed)?
        .join("abort-scratch");
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir(&scratch).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let scratch =
        fs::canonicalize(scratch).map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let marker = workspace.join("release-must-not-run");
    let policy = ExecutionPolicy {
        schema_version: 1,
        workspace_root: workspace.to_string_lossy().into_owned(),
        filesystem: FilesystemPolicy::WorkspaceWrite,
        network: NetworkPolicy::Deny,
        process_isolation: ProcessIsolationPolicy::Inherit,
        environment: EnvironmentPolicy::Explicit,
    };
    let digest = probe_digest(runtime, "release-abort")?;
    let argv = vec![
        OsString::from("/usr/bin/touch"),
        marker.as_os_str().to_owned(),
    ];
    let invocation = build_invocation(
        runtime,
        BubblewrapLaunch {
            binary_path: binary,
            policy: &policy,
            workspace_root: workspace,
            cwd: workspace,
            scratch_root: Some(&scratch),
            confirmation_digest: &digest,
            argv: &argv,
        },
    )
    .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    spawn_and_verify_probe(runtime, invocation, true, digest, false)?;
    if marker.exists() {
        return Err(BubblewrapUnavailableReason::ProbeContractFailed);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_and_verify_probe(
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    invocation: BubblewrapInvocation,
    network_denied: bool,
    digest: [u8; 32],
    release: bool,
) -> Result<(), BubblewrapUnavailableReason> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let parent_mount = namespace_identity(Path::new("/proc/self/ns/mnt"))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let parent_user = namespace_identity(Path::new("/proc/self/ns/user"))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let parent_network = namespace_identity(Path::new("/proc/self/ns/net"))
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let (confirmation_read, confirmation_write) =
        crate::platform::bootstrap::create_bootstrap_channel()
            .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let (release_read, release_write) = crate::platform::bootstrap::create_bootstrap_channel()
        .map_err(|_| BubblewrapUnavailableReason::ProbeSetupFailed)?;
    let confirmation_read_fd = confirmation_read.as_raw_fd();
    let confirmation_write_fd = confirmation_write.as_raw_fd();
    let release_read_fd = release_read.as_raw_fd();
    let release_write_fd = release_write.as_raw_fd();
    let argv = invocation.command_argv();
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the closure uses only async-signal-safe descriptor/process-group operations.
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            let confirmation_copy = libc::fcntl(confirmation_write_fd, libc::F_DUPFD_CLOEXEC, 10);
            let release_copy = libc::fcntl(release_read_fd, libc::F_DUPFD_CLOEXEC, 10);
            if confirmation_copy < 0
                || release_copy < 0
                || libc::dup2(confirmation_copy, LINUX_SANDBOX_CONFIRMATION_FD) < 0
                || libc::dup2(release_copy, LINUX_SANDBOX_RELEASE_FD) < 0
            {
                return Err(io::Error::last_os_error());
            }
            if libc::fcntl(LINUX_SANDBOX_CONFIRMATION_FD, libc::F_SETFD, 0) < 0
                || libc::fcntl(LINUX_SANDBOX_RELEASE_FD, libc::F_SETFD, 0) < 0
            {
                return Err(io::Error::last_os_error());
            }
            for descriptor in [
                confirmation_read_fd,
                confirmation_write_fd,
                release_read_fd,
                release_write_fd,
            ] {
                if descriptor != LINUX_SANDBOX_CONFIRMATION_FD
                    && descriptor != LINUX_SANDBOX_RELEASE_FD
                {
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
        .map_err(|_| BubblewrapUnavailableReason::ProbeSpawnFailed)?;
    drop(confirmation_write);
    drop(release_read);
    let bytes = match read_exact_with_timeout(
        confirmation_read.as_raw_fd(),
        CONFIRMATION_FRAME_BYTES,
        Duration::from_secs(5),
    ) {
        Ok(bytes) => bytes,
        Err(_) => {
            terminate_probe(&mut child);
            return Err(BubblewrapUnavailableReason::ConfirmationFailed);
        }
    };
    let confirmation = parse_confirmation_frame(&bytes).map_err(|_| {
        terminate_probe(&mut child);
        BubblewrapUnavailableReason::ConfirmationFailed
    })?;
    let valid = confirmation.process_group_id == child.id()
        && confirmation.mount_namespace != parent_mount
        && confirmation.user_namespace != parent_user
        && (if network_denied {
            confirmation.network_namespace != parent_network
        } else {
            confirmation.network_namespace == parent_network
        })
        && confirmation.no_new_privs
        && confirmation.seccomp_mode == 2
        && confirmation.network_denied == network_denied
        && confirmation.digest == digest
        // SAFETY: getpgid reads the live confirmed process group.
        && unsafe { libc::getpgid(confirmation.pid as i32) }
            == confirmation.process_group_id as i32;
    if !valid || !runtime_identity_matches(runtime) {
        terminate_probe(&mut child);
        return Err(BubblewrapUnavailableReason::ConfirmationFailed);
    }
    if release {
        crate::platform::bootstrap::release_gate(release_write).map_err(|_| {
            terminate_probe(&mut child);
            BubblewrapUnavailableReason::ConfirmationFailed
        })?;
    } else {
        drop(release_write);
    }
    let status = wait_for_child(&mut child, Duration::from_secs(5))?;
    if release {
        if !status.success() {
            return Err(BubblewrapUnavailableReason::ProbeContractFailed);
        }
    } else if status.success() {
        return Err(BubblewrapUnavailableReason::ProbeContractFailed);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn wait_for_confirmation(
    confirmation_read: crate::platform::bootstrap::BootstrapRead,
    process_group_leader: u32,
    network_denied: bool,
    digest: [u8; 32],
    runtime: &LinuxBubblewrapRuntimeDescriptor,
    wait: std::time::Duration,
) -> io::Result<LinuxSandboxConfirmation> {
    use std::os::fd::AsRawFd;

    let parent_mount = namespace_identity(Path::new("/proc/self/ns/mnt"))?;
    let parent_user = namespace_identity(Path::new("/proc/self/ns/user"))?;
    let parent_network = namespace_identity(Path::new("/proc/self/ns/net"))?;
    let bytes = read_exact_with_timeout(
        confirmation_read.as_raw_fd(),
        CONFIRMATION_FRAME_BYTES,
        wait,
    )?;
    let confirmation = parse_confirmation_frame(&bytes)?;
    let leader = i32::try_from(process_group_leader)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid process-group leader"))?;
    let confirmed_pid = i32::try_from(confirmation.pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid confirmed process ID"))?;
    // SAFETY: getpgid performs bounded identity checks for live positive PIDs.
    let outer_group = unsafe { libc::getpgid(leader) };
    // SAFETY: getpgid performs bounded identity checks for live positive PIDs.
    let confirmed_group = unsafe { libc::getpgid(confirmed_pid) };
    let valid = confirmation.process_group_id == process_group_leader
        && outer_group == leader
        && confirmed_group == leader
        && confirmation.mount_namespace != parent_mount
        && confirmation.user_namespace != parent_user
        && (if network_denied {
            confirmation.network_namespace != parent_network
        } else {
            confirmation.network_namespace == parent_network
        })
        && confirmation.no_new_privs
        && confirmation.seccomp_mode == 2
        && confirmation.network_denied == network_denied
        && confirmation.digest == digest
        && runtime_identity_matches(runtime);
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Linux sandbox confirmation did not match the prepared launch",
        ));
    }
    Ok(confirmation)
}

#[cfg(target_os = "linux")]
pub fn runtime_identity_matches(runtime: &LinuxBubblewrapRuntimeDescriptor) -> bool {
    runtime_descriptor(Path::new(&runtime.canonical_path), true)
        .map(|current| current == *runtime)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
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
                "Linux sandbox confirmation timed out",
            ));
        }
        let mut poll = libc::pollfd {
            fd: descriptor,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        // SAFETY: poll receives one initialized descriptor for a bounded timeout.
        let polled = unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().min(i32::MAX as u128).max(1) as i32,
            )
        };
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
        // SAFETY: read writes only into the remaining initialized vector region.
        let read = unsafe {
            libc::read(
                descriptor,
                bytes[offset..].as_mut_ptr().cast::<libc::c_void>(),
                length - offset,
            )
        };
        if read <= 0 {
            return Err(if read == 0 {
                io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Linux sandbox confirmation ended early",
                )
            } else {
                io::Error::last_os_error()
            });
        }
        offset += read as usize;
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn wait_for_child(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Result<std::process::ExitStatus, BubblewrapUnavailableReason> {
    use std::time::{Duration, Instant};

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                terminate_probe(child);
                return Err(BubblewrapUnavailableReason::ProbeTimedOut);
            }
            Err(_) => return Err(BubblewrapUnavailableReason::ProbeContractFailed),
        }
    }
}

#[cfg(target_os = "linux")]
fn terminate_probe(child: &mut std::process::Child) {
    // SAFETY: the probe created a dedicated process group led by child.id().
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    let _ = child.wait();
}

#[cfg(target_os = "linux")]
struct ProbeRoot {
    path: PathBuf,
}

#[cfg(target_os = "linux")]
impl ProbeRoot {
    fn create() -> io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;

        let base = fs::canonicalize(std::env::temp_dir())?;
        let path = base.join(format!("koda-bwrap-probe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(Self { path })
    }
}

#[cfg(target_os = "linux")]
impl Drop for ProbeRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(target_os = "linux")]
pub fn run_probe_contract(
    kind: &str,
    workspace: &Path,
    scratch: Option<&Path>,
    external: &Path,
    port: Option<u16>,
) -> io::Result<()> {
    use std::io::Read;
    use std::net::TcpStream;

    if fs::read(workspace.join("readable.txt"))
        .map_err(|_| io::Error::other("workspace read was not allowed"))?
        != b"koda-linux-probe"
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "probe read failed",
        ));
    }
    // A dynamically linked internal command already proves executable/library reads.
    let _ = fs::read("/etc/os-release")
        .map_err(|_| io::Error::other("system library fixture read was not allowed"))?;
    match kind {
        "workspace-write-deny" => {
            fs::write(workspace.join("workspace-write.txt"), b"workspace")
                .map_err(|_| io::Error::other("workspace write was not allowed"))?;
            fs::write(
                scratch
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "scratch missing"))?
                    .join("scratch-write.txt"),
                b"scratch",
            )
            .map_err(|_| io::Error::other("scratch write was not allowed"))?;
        }
        "read-only-deny" | "read-only-inherit" => {
            expect_write_denied(&workspace.join("read-only-write"))
                .map_err(|_| io::Error::other("read-only workspace remained writable"))?;
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown probe kind",
            ));
        }
    }
    expect_write_denied(external)
        .map_err(|_| io::Error::other("external probe path remained writable"))?;
    for (root, failure) in [
        ("/var/tmp", "system var-tmp remained writable"),
        ("/dev/shm", "device shared-memory mount remained writable"),
        ("/run", "system run mount remained writable"),
    ] {
        let root = Path::new(root);
        if root.is_dir() {
            expect_write_denied(&root.join(format!("koda-bwrap-probe-{}", std::process::id())))
                .map_err(|_| io::Error::other(failure))?;
        }
    }
    ensure_only_standard_descriptors()
        .map_err(|_| io::Error::other("descriptor whitelist verification failed"))?;
    expect_errno(
        // SAFETY: the raw syscall intentionally tests the installed filter.
        unsafe { libc::unshare(libc::CLONE_NEWUSER) },
        libc::EPERM,
        "nested user namespace was not denied",
    )?;
    let tty = fs::File::open("/dev/null")
        .map_err(|_| io::Error::other("read-only device view is unavailable"))?;
    use std::os::fd::AsRawFd;
    expect_errno(
        // SAFETY: ioctl is issued against a valid descriptor with a denied request.
        unsafe { libc::ioctl(tty.as_raw_fd(), libc::TIOCSTI as _, 0) },
        libc::EPERM,
        "TIOCSTI was not denied",
    )?;
    if kind.ends_with("deny") {
        for (domain, socket_type) in [
            (libc::AF_INET, libc::SOCK_STREAM),
            (libc::AF_INET, libc::SOCK_DGRAM),
            (libc::AF_UNIX, libc::SOCK_STREAM),
        ] {
            expect_errno(
                // SAFETY: socket creation is the operation under test.
                unsafe { libc::socket(domain, socket_type, 0) },
                libc::EPERM,
                "socket creation was not denied",
            )?;
        }
        expect_errno(
            // SAFETY: a null params pointer would produce EFAULT without the seccomp denial.
            unsafe {
                libc::syscall(
                    libc::SYS_io_uring_setup,
                    1,
                    std::ptr::null::<libc::c_void>(),
                )
            } as i32,
            libc::EPERM,
            "io_uring setup was not denied",
        )?;
    } else {
        let port =
            port.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "port missing"))?;
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        let mut token = Vec::new();
        stream.read_to_end(&mut token)?;
        if token != b"koda-linux-network-inherit" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "network token invalid",
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn run_probe_contract(
    _kind: &str,
    _workspace: &Path,
    _scratch: Option<&Path>,
    _external: &Path,
    _port: Option<u16>,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Linux Bubblewrap probe is unavailable",
    ))
}

#[cfg(target_os = "linux")]
fn expect_write_denied(path: &Path) -> io::Result<()> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => {
            drop(file);
            let _ = fs::remove_file(path);
            Err(io::Error::other("probe unexpectedly wrote a file"))
        }
        Err(error) if permission_denied(&error) || error.raw_os_error() == Some(libc::EROFS) => {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn permission_denied(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(code) if code == libc::EPERM || code == libc::EACCES)
}

#[cfg(target_os = "linux")]
fn expect_errno(result: i32, expected: i32, message: &str) -> io::Result<()> {
    if result == -1 && io::Error::last_os_error().raw_os_error() == Some(expected) {
        Ok(())
    } else {
        if result >= 0 {
            // SAFETY: the successful syscall returned a descriptor.
            unsafe { libc::close(result) };
        }
        Err(io::Error::other(message))
    }
}

#[cfg(target_os = "linux")]
fn ensure_only_standard_descriptors() -> io::Result<()> {
    let mut descriptors = Vec::new();
    for entry in fs::read_dir("/proc/self/fd")? {
        let entry = entry?;
        if let Some(value) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
            && value > 2
        {
            descriptors.push(value);
        }
    }
    for descriptor in descriptors {
        // The directory used to enumerate descriptors is closed before this check.
        // SAFETY: fcntl reads descriptor state and retains no pointer.
        if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } >= 0 {
            return Err(io::Error::other("unexpected inherited descriptor"));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::execution_policy::EnforcementMechanism;
    use std::os::unix::fs::PermissionsExt;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("koda-bwrap-{name}-{}", uuid::Uuid::new_v4()));
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

    fn descriptor() -> LinuxBubblewrapRuntimeDescriptor {
        LinuxBubblewrapRuntimeDescriptor {
            schema_version: 1,
            mechanism: EnforcementMechanism::LinuxBubblewrap,
            canonical_path: "/usr/bin/bwrap".into(),
            device: "1".into(),
            inode: "2".into(),
            size: 3,
            mtime_ns: "4".into(),
            sha256: "11".repeat(32),
            version: "bubblewrap 1.0".into(),
            probe_revision: 1,
        }
    }

    fn policy(
        root: &Path,
        filesystem: FilesystemPolicy,
        network: NetworkPolicy,
    ) -> ExecutionPolicy {
        ExecutionPolicy {
            schema_version: 1,
            workspace_root: root.to_string_lossy().into_owned(),
            filesystem,
            network,
            process_isolation: ProcessIsolationPolicy::Inherit,
            environment: EnvironmentPolicy::Explicit,
        }
    }

    #[test]
    fn confirmation_frame_is_fixed_and_strict() {
        let value = LinuxSandboxConfirmation {
            pid: 42,
            process_group_id: 41,
            mount_namespace: NamespaceIdentity {
                device: 1,
                inode: 2,
            },
            user_namespace: NamespaceIdentity {
                device: 3,
                inode: 4,
            },
            network_namespace: NamespaceIdentity {
                device: 5,
                inode: 6,
            },
            no_new_privs: true,
            seccomp_mode: 2,
            network_denied: true,
            digest: [7; 32],
        };
        let frame = confirmation_frame(&value);
        assert_eq!(parse_confirmation_frame(&frame).unwrap(), value);
        assert!(parse_confirmation_frame(&frame[..111]).is_err());
        let mut corrupt = frame;
        corrupt[75] = 1;
        assert!(parse_confirmation_frame(&corrupt).is_err());
    }

    #[test]
    fn launch_digest_binds_policy_capability_runtime_and_builder() {
        let workspace = TestDirectory::new("digest-workspace");
        let runtime = descriptor();
        let capabilities =
            crate::execution_policy::linux_bubblewrap_execution_capabilities(&runtime).unwrap();
        let read_only = policy(
            &workspace.0,
            FilesystemPolicy::ReadOnly,
            NetworkPolicy::Deny,
        );
        let first = launch_confirmation_digest(&runtime, &read_only, &capabilities).unwrap();
        assert_eq!(
            first,
            launch_confirmation_digest(&runtime, &read_only, &capabilities).unwrap()
        );
        let inherited_network = ExecutionPolicy {
            network: NetworkPolicy::Inherit,
            ..read_only
        };
        assert_ne!(
            first,
            launch_confirmation_digest(&runtime, &inherited_network, &capabilities).unwrap()
        );

        let mut changed_runtime = runtime;
        changed_runtime.sha256 = "22".repeat(32);
        let changed_capabilities =
            crate::execution_policy::linux_bubblewrap_execution_capabilities(&changed_runtime)
                .unwrap();
        assert_ne!(
            first,
            launch_confirmation_digest(
                &changed_runtime,
                &inherited_network,
                &changed_capabilities,
            )
            .unwrap()
        );
        assert!(
            launch_confirmation_digest(&changed_runtime, &inherited_network, &capabilities)
                .is_err()
        );
    }

    #[test]
    fn builder_emits_only_the_fixed_ordered_surface() {
        let workspace = TestDirectory::new("workspace");
        let scratch = TestDirectory::new("scratch");
        let launch_policy = policy(
            &workspace.0,
            FilesystemPolicy::WorkspaceWrite,
            NetworkPolicy::Deny,
        );
        let launch_argv = [OsString::from("/usr/bin/true")];
        let invocation = build_invocation(
            &descriptor(),
            BubblewrapLaunch {
                binary_path: Path::new("/usr/bin/koda-exec"),
                policy: &launch_policy,
                workspace_root: &workspace.0,
                cwd: &workspace.0,
                scratch_root: Some(&scratch.0),
                confirmation_digest: &[9; 32],
                argv: &launch_argv,
            },
        )
        .unwrap();
        let values = invocation
            .arguments()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            &values[..20],
            [
                "--die-with-parent",
                "--unshare-user",
                "--disable-userns",
                "--unshare-ipc",
                "--cap-drop",
                "ALL",
                "--ro-bind",
                "/",
                "/",
                "--remount-ro",
                "/",
                "--dev",
                "/dev",
                "--remount-ro",
                "/dev",
                "--remount-ro",
                "/dev/shm",
                "--ro-bind",
                "/run",
                "/run",
            ]
        );
        assert!(values.windows(3).any(|slice| slice
            == [
                "--bind",
                workspace.0.to_str().unwrap(),
                workspace.0.to_str().unwrap()
            ]));
        assert!(values.windows(3).any(|slice| slice
            == [
                "--bind",
                scratch.0.to_str().unwrap(),
                scratch.0.to_str().unwrap()
            ]));
        assert!(values.contains(&"--unshare-net".to_owned()));
        assert!(!values.iter().any(|value| value.contains("-try")
            || value == "--new-session"
            || value == "--unshare-pid"));
    }

    #[test]
    fn builder_rejects_missing_or_unsafe_scratch() {
        let workspace = TestDirectory::new("workspace-invalid");
        let scratch = TestDirectory::new("scratch-invalid");
        let launch_policy = policy(
            &workspace.0,
            FilesystemPolicy::WorkspaceWrite,
            NetworkPolicy::Deny,
        );
        let launch_argv = [OsString::from("/usr/bin/true")];
        assert!(
            build_invocation(
                &descriptor(),
                BubblewrapLaunch {
                    binary_path: Path::new("/usr/bin/koda-exec"),
                    policy: &launch_policy,
                    workspace_root: &workspace.0,
                    cwd: &workspace.0,
                    scratch_root: None,
                    confirmation_digest: &[0; 32],
                    argv: &launch_argv,
                },
            )
            .is_err()
        );
        fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            build_invocation(
                &descriptor(),
                BubblewrapLaunch {
                    binary_path: Path::new("/usr/bin/koda-exec"),
                    policy: &launch_policy,
                    workspace_root: &workspace.0,
                    cwd: &workspace.0,
                    scratch_root: Some(&scratch.0),
                    confirmation_digest: &[0; 32],
                    argv: &launch_argv,
                },
            )
            .is_err()
        );
    }
}
