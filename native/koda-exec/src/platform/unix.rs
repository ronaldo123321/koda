use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tokio::net::{UnixListener, UnixStream};

pub type LocalListener = UnixListener;
pub type LocalStream = UnixStream;
pub type BootstrapHandle = RawFd;
pub type BootstrapRead = OwnedFd;
pub type BootstrapWrite = OwnedFd;

pub struct SandboxBootstrapChannels<'a> {
    pub confirmation_read: &'a BootstrapRead,
    pub confirmation_write: &'a BootstrapWrite,
    pub release_read: &'a BootstrapRead,
    pub release_write: &'a BootstrapWrite,
    pub confirmation_target: RawFd,
    pub release_target: RawFd,
}

pub struct ResourceBootstrapChannels<'a> {
    pub confirmation_read: &'a BootstrapRead,
    pub confirmation_write: &'a BootstrapWrite,
    pub confirmation_target: RawFd,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessTreeSignal {
    Graceful,
    Force,
}

pub fn validate_local_endpoint(endpoint: &Path) -> io::Result<()> {
    if endpoint.is_absolute() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local executor endpoint must be an absolute path",
        ))
    }
}

pub fn default_local_endpoint(state_directory: &Path) -> io::Result<PathBuf> {
    Ok(state_directory.join("koda-exec.sock"))
}

pub fn prepare_local_endpoint_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint has no parent"))?;
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "executor runtime path '{}' must be a real directory",
                    parent.display()
                ),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(parent)?;
        }
        Err(error) => return Err(error),
    }
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
}

pub async fn bind_local_endpoint(path: &Path) -> io::Result<LocalListener> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "endpoint has no parent"))?;
    let metadata = std::fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "endpoint parent must be a real directory",
        ));
    }
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "refusing to replace non-socket endpoint '{}'",
                    path.display()
                ),
            ));
        }
        if UnixStream::connect(path).await.is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("a process is already listening at '{}'", path.display()),
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub async fn accept_local_connection(listener: &LocalListener) -> io::Result<LocalStream> {
    listener.accept().await.map(|(stream, _)| stream)
}

pub async fn connect_local_endpoint(path: &Path) -> io::Result<LocalStream> {
    UnixStream::connect(path).await
}

pub fn remove_local_endpoint(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "local control endpoint is not a Unix Socket",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn worker_control_root() -> PathBuf {
    // `/tmp` keeps the sockaddr path safely below macOS SUN_LEN even when the
    // durable state directory itself is deeply nested. The per-UID directory
    // is mode 0700; the endpoint is additionally same-UID and HMAC authenticated.
    // SAFETY: geteuid reads process credentials and has no preconditions.
    let uid = unsafe { libc::geteuid() };
    PathBuf::from("/tmp").join(format!("koda-exec-{uid}"))
}

pub fn worker_local_endpoint(_job_directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    Ok(worker_control_root().join(format!("{job_id}.sock")))
}

pub fn secure_private_directory(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path is not a real directory",
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

pub fn validate_private_directory(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid reads process credentials and has no preconditions.
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private directory has unsafe type, owner, or permissions",
        ));
    }
    Ok(())
}

pub fn validate_private_file(path: &Path, exact_size: Option<u64>) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid reads process credentials and has no preconditions.
    let expected_uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o777 != 0o600
        || exact_size.is_some_and(|size| metadata.len() != size)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private file has unsafe type, owner, permissions, or size",
        ));
    }
    Ok(())
}

pub fn open_new_private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

pub fn open_exclusive_lock(path: &Path) -> io::Result<Option<File>> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // SAFETY: flock operates on this valid open descriptor and does not outlive it.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(file))
    } else {
        let error = io::Error::last_os_error();
        if matches!(
            error.raw_os_error(),
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
        ) {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

pub fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

pub fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::rename(source, target)
}

pub fn create_bootstrap_channel() -> io::Result<(BootstrapRead, BootstrapWrite)> {
    let mut descriptors = [-1, -1];
    // SAFETY: pipe initializes both descriptors on success.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful pipe returned two distinct owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: successful pipe returned two distinct owned descriptors.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_close_on_exec(read.as_raw_fd())?;
    set_close_on_exec(write.as_raw_fd())?;
    Ok((read, write))
}

pub fn read_inherited_secret(
    handle: BootstrapHandle,
    expected_bytes: usize,
) -> io::Result<Vec<u8>> {
    if handle < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bootstrap descriptor overlaps standard streams",
        ));
    }
    // SAFETY: the parent transfers ownership of this dedicated descriptor to the child.
    let file = unsafe { File::from_raw_fd(handle) };
    let maximum = u64::try_from(expected_bytes.saturating_add(1)).unwrap_or(u64::MAX);
    let mut bytes = Vec::with_capacity(expected_bytes);
    file.take(maximum).read_to_end(&mut bytes)?;
    if bytes.len() != expected_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bootstrap secret must contain exactly {expected_bytes} bytes"),
        ));
    }
    Ok(bytes)
}

pub fn release_gate(write: BootstrapWrite) -> io::Result<()> {
    let descriptor = write.as_raw_fd();
    let byte = 1u8;
    loop {
        // SAFETY: write consumes one byte from valid memory on a valid pipe descriptor.
        let result =
            unsafe { libc::write(descriptor, &byte as *const u8 as *const libc::c_void, 1) };
        if result == 1 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn await_gate_and_exec(handle: BootstrapHandle, argv: Vec<String>) -> io::Result<()> {
    if argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command bootstrap argv is empty",
        ));
    }
    if handle < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command gate descriptor overlaps standard streams",
        ));
    }
    // SAFETY: the Worker transfers ownership of this dedicated descriptor.
    let mut gate = unsafe { File::from_raw_fd(handle) };
    let mut byte = [0u8; 1];
    gate.read_exact(&mut byte)?;
    if byte[0] != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "command bootstrap gate value is invalid",
        ));
    }
    drop(gate);
    let error = CommandExt::exec(Command::new(&argv[0]).args(&argv[1..]));
    Err(error)
}

pub fn configure_worker_command(command: &mut Command, token_file: &File, target: RawFd) {
    let source = token_file.as_raw_fd();
    command.process_group(0);
    // SAFETY: the closure uses only async-signal-safe descriptor operations before exec.
    unsafe {
        command.pre_exec(move || inherit_descriptor(source, target));
    }
}

pub fn spawn_worker_process(
    binary_path: &Path,
    job_directory: &Path,
    token_path: &Path,
) -> io::Result<()> {
    let token_file = OpenOptions::new().read(true).open(token_path)?;
    let mut command = Command::new(binary_path);
    command
        .arg("worker")
        .arg("--job-dir")
        .arg(job_directory)
        .arg("--token-fd")
        .arg("3")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    configure_worker_command(&mut command, &token_file, 3);
    command.spawn()?;
    Ok(())
}

pub fn configure_pipe_command(
    command: &mut tokio::process::Command,
    read: &BootstrapRead,
    write: &BootstrapWrite,
    target: RawFd,
    sandbox: Option<SandboxBootstrapChannels<'_>>,
    resources: Option<ResourceBootstrapChannels<'_>>,
) {
    let read = read.as_raw_fd();
    let write = write.as_raw_fd();
    let sandbox = sandbox.map(raw_sandbox_channels);
    let resources = resources.map(raw_resource_channels);
    CommandExt::process_group(command.as_std_mut(), 0);
    // SAFETY: the closure performs only async-signal-safe descriptor operations before exec.
    unsafe {
        CommandExt::pre_exec(command.as_std_mut(), move || {
            inherit_launch_descriptors(read, write, target, sandbox, resources)
        });
    }
}

pub fn configure_pty_command(
    command: &mut tokio::process::Command,
    read: &BootstrapRead,
    write: &BootstrapWrite,
    master: &OwnedFd,
    slave: &OwnedFd,
    gate_target: RawFd,
    sandbox: Option<SandboxBootstrapChannels<'_>>,
    resources: Option<ResourceBootstrapChannels<'_>>,
) {
    let read = read.as_raw_fd();
    let write = write.as_raw_fd();
    let master = master.as_raw_fd();
    let slave = slave.as_raw_fd();
    let sandbox = sandbox.map(raw_sandbox_channels);
    let resources = resources.map(raw_resource_channels);
    // SAFETY: the closure performs only async-signal-safe session, ioctl, and descriptor
    // operations before exec. All descriptors are Worker-owned.
    unsafe {
        CommandExt::pre_exec(command.as_std_mut(), move || {
            // PTY setup closes the original master/slave descriptors and may reuse
            // low descriptor numbers. Preserve every bootstrap source first, then
            // install the fixed child descriptors only after the controlling TTY
            // has been configured.
            let launch_descriptors =
                prepare_launch_descriptors(read, gate_target, sandbox, resources).map_err(
                    |error| launch_descriptor_error("preserve PTY bootstrap channels", error),
                )?;
            libc::close(write);
            if let Some(sandbox) = sandbox {
                libc::close(sandbox.confirmation_read);
                libc::close(sandbox.release_write);
            }
            if let Some(resources) = resources {
                libc::close(resources.confirmation_read);
            }
            libc::close(master);
            if libc::setsid() < 0 {
                return Err(launch_descriptor_error(
                    "create PTY session",
                    io::Error::last_os_error(),
                ));
            }
            if libc::ioctl(slave, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(launch_descriptor_error(
                    "assign controlling PTY",
                    io::Error::last_os_error(),
                ));
            }
            for target in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                if slave != target && libc::dup2(slave, target) < 0 {
                    return Err(launch_descriptor_error(
                        "connect PTY standard stream",
                        io::Error::last_os_error(),
                    ));
                }
            }
            if slave > libc::STDERR_FILENO {
                libc::close(slave);
            }
            install_launch_descriptors(launch_descriptors)
                .map_err(|error| launch_descriptor_error("install PTY bootstrap channels", error))
        });
    }
}

#[derive(Clone, Copy)]
struct RawSandboxBootstrapChannels {
    confirmation_read: RawFd,
    confirmation_write: RawFd,
    release_read: RawFd,
    release_write: RawFd,
    confirmation_target: RawFd,
    release_target: RawFd,
}

#[derive(Clone, Copy)]
struct RawResourceBootstrapChannels {
    confirmation_read: RawFd,
    confirmation_write: RawFd,
    confirmation_target: RawFd,
}

#[derive(Clone, Copy)]
struct PreparedSandboxBootstrapChannels {
    confirmation_copy: RawFd,
    release_copy: RawFd,
    confirmation_target: RawFd,
    release_target: RawFd,
}

#[derive(Clone, Copy)]
struct PreparedResourceBootstrapChannels {
    confirmation_copy: RawFd,
    confirmation_target: RawFd,
}

#[derive(Clone, Copy)]
struct PreparedLaunchDescriptors {
    gate_copy: RawFd,
    gate_target: RawFd,
    sandbox: Option<PreparedSandboxBootstrapChannels>,
    resources: Option<PreparedResourceBootstrapChannels>,
}

fn raw_sandbox_channels(channels: SandboxBootstrapChannels<'_>) -> RawSandboxBootstrapChannels {
    RawSandboxBootstrapChannels {
        confirmation_read: channels.confirmation_read.as_raw_fd(),
        confirmation_write: channels.confirmation_write.as_raw_fd(),
        release_read: channels.release_read.as_raw_fd(),
        release_write: channels.release_write.as_raw_fd(),
        confirmation_target: channels.confirmation_target,
        release_target: channels.release_target,
    }
}

fn raw_resource_channels(channels: ResourceBootstrapChannels<'_>) -> RawResourceBootstrapChannels {
    RawResourceBootstrapChannels {
        confirmation_read: channels.confirmation_read.as_raw_fd(),
        confirmation_write: channels.confirmation_write.as_raw_fd(),
        confirmation_target: channels.confirmation_target,
    }
}

fn inherit_launch_descriptors(
    gate_read: RawFd,
    gate_write: RawFd,
    gate_target: RawFd,
    sandbox: Option<RawSandboxBootstrapChannels>,
    resources: Option<RawResourceBootstrapChannels>,
) -> io::Result<()> {
    if sandbox.is_none() && resources.is_none() {
        // SAFETY: the child never reads the Worker's gate endpoint.
        unsafe { libc::close(gate_write) };
        return inherit_descriptor(gate_read, gate_target);
    }
    let launch_descriptors =
        prepare_launch_descriptors(gate_read, gate_target, sandbox, resources)?;
    // SAFETY: these are the parent-only ends of dedicated Worker-owned pipes.
    unsafe {
        libc::close(gate_write);
        if let Some(sandbox) = sandbox {
            libc::close(sandbox.confirmation_read);
            libc::close(sandbox.release_write);
        }
        if let Some(resources) = resources {
            libc::close(resources.confirmation_read);
        }
    }
    install_launch_descriptors(launch_descriptors)
}

fn prepare_launch_descriptors(
    gate_read: RawFd,
    gate_target: RawFd,
    sandbox: Option<RawSandboxBootstrapChannels>,
    resources: Option<RawResourceBootstrapChannels>,
) -> io::Result<PreparedLaunchDescriptors> {
    validate_launch_targets(gate_target, sandbox, resources)?;
    let sandbox = if let Some(sandbox) = sandbox {
        Some(PreparedSandboxBootstrapChannels {
            confirmation_copy: duplicate_descriptor(sandbox.confirmation_write)?,
            release_copy: duplicate_descriptor(sandbox.release_read)?,
            confirmation_target: sandbox.confirmation_target,
            release_target: sandbox.release_target,
        })
    } else {
        None
    };
    let resources = if let Some(resources) = resources {
        Some(PreparedResourceBootstrapChannels {
            confirmation_copy: duplicate_descriptor(resources.confirmation_write)?,
            confirmation_target: resources.confirmation_target,
        })
    } else {
        None
    };
    Ok(PreparedLaunchDescriptors {
        gate_copy: duplicate_descriptor(gate_read)?,
        gate_target,
        sandbox,
        resources,
    })
}

fn install_launch_descriptors(descriptors: PreparedLaunchDescriptors) -> io::Result<()> {
    let result = inherit_descriptor(descriptors.gate_copy, descriptors.gate_target)
        .and_then(|_| {
            let Some(sandbox) = descriptors.sandbox else {
                return Ok(());
            };
            inherit_descriptor(sandbox.confirmation_copy, sandbox.confirmation_target)
                .and_then(|_| inherit_descriptor(sandbox.release_copy, sandbox.release_target))
        })
        .and_then(|_| {
            let Some(resources) = descriptors.resources else {
                return Ok(());
            };
            inherit_descriptor(resources.confirmation_copy, resources.confirmation_target)
        });
    // SAFETY: the duplicated sources are no longer needed after target assignment.
    unsafe {
        libc::close(descriptors.gate_copy);
        if let Some(sandbox) = descriptors.sandbox {
            libc::close(sandbox.confirmation_copy);
            libc::close(sandbox.release_copy);
        }
        if let Some(resources) = descriptors.resources {
            libc::close(resources.confirmation_copy);
        }
    }
    result
}

fn validate_launch_targets(
    gate_target: RawFd,
    sandbox: Option<RawSandboxBootstrapChannels>,
    resources: Option<RawResourceBootstrapChannels>,
) -> io::Result<()> {
    let mut targets = vec![gate_target];
    if let Some(sandbox) = sandbox {
        targets.extend([sandbox.confirmation_target, sandbox.release_target]);
    }
    if let Some(resources) = resources {
        targets.push(resources.confirmation_target);
    }
    targets.sort_unstable();
    if targets.iter().any(|target| *target < 3) || targets.windows(2).any(|pair| pair[0] == pair[1])
    {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bootstrap targets must be distinct non-standard descriptors",
        ))
    } else {
        Ok(())
    }
}

fn duplicate_descriptor(source: RawFd) -> io::Result<RawFd> {
    // SAFETY: fcntl duplicates the valid descriptor and marks the temporary
    // source close-on-exec; the caller closes it before returning from pre_exec.
    let duplicated = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 10) };
    if duplicated < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(duplicated)
    }
}

fn launch_descriptor_error(step: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{step}: {error}"))
}

fn inherit_descriptor(source: RawFd, target: RawFd) -> io::Result<()> {
    if source != target {
        // SAFETY: source is valid and target is the dedicated child descriptor.
        if unsafe { libc::dup2(source, target) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    } else {
        clear_close_on_exec(target)
    }
}

pub fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    // SAFETY: fcntl reads and updates flags on a valid owned descriptor.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn clear_close_on_exec(descriptor: RawFd) -> io::Result<()> {
    // SAFETY: fcntl reads and updates flags on a valid inherited descriptor.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn signal_process_group(pid: u32, signal: ProcessTreeSignal) -> io::Result<()> {
    let process_group = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process ID exceeds i32"))?;
    let signal = match signal {
        ProcessTreeSignal::Graceful => libc::SIGTERM,
        ProcessTreeSignal::Force => libc::SIGKILL,
    };
    // SAFETY: kill is called with a validated positive process-group ID and a platform signal.
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

pub fn process_group_exists(pid: u32) -> bool {
    let Ok(process_group) = i32::try_from(pid) else {
        return true;
    };
    // SAFETY: signal 0 performs an existence/permission check without delivering a signal.
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

pub fn exit_signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt as _;

    status.signal().map(|signal| match signal {
        libc::SIGHUP => "SIGHUP".to_owned(),
        libc::SIGINT => "SIGINT".to_owned(),
        libc::SIGQUIT => "SIGQUIT".to_owned(),
        libc::SIGKILL => "SIGKILL".to_owned(),
        libc::SIGTERM => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    })
}

pub fn open_terminal(rows: u16, cols: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master = -1;
    let mut slave = -1;
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // libc exposes a mutable winsize pointer on Apple platforms even though
    // openpty only reads the supplied initial dimensions.
    let size_pointer = std::ptr::from_ref(&size).cast_mut();
    // SAFETY: openpty initializes both descriptors on success and only reads the supplied
    // window-size value during this call.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            size_pointer,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openpty returned two distinct owned descriptors.
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    // SAFETY: successful openpty returned two distinct owned descriptors.
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    set_close_on_exec(master.as_raw_fd())?;
    set_close_on_exec(slave.as_raw_fd())?;
    Ok((master, slave))
}

pub fn duplicate_terminal(descriptor: &OwnedFd) -> io::Result<OwnedFd> {
    // SAFETY: dup creates a new descriptor referring to the same open file.
    let duplicated = unsafe { libc::dup(descriptor.as_raw_fd()) };
    if duplicated < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful dup returned a new owned descriptor.
    let duplicated = unsafe { OwnedFd::from_raw_fd(duplicated) };
    set_close_on_exec(duplicated.as_raw_fd())?;
    Ok(duplicated)
}

pub fn is_terminal_eof(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}

pub fn set_terminal_size(file: &tokio::fs::File, rows: u16, cols: u16) -> io::Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: ioctl reads the supplied winsize and applies it to a valid PTY master.
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn verify_local_peer(stream: &LocalStream) -> io::Result<()> {
    let mut effective_uid = 0;
    let mut effective_gid = 0;
    // SAFETY: getpeereid only writes the supplied uid/gid values for this valid socket fd.
    let result =
        unsafe { libc::getpeereid(stream.as_raw_fd(), &mut effective_uid, &mut effective_gid) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: geteuid reads process credentials and has no preconditions.
    if effective_uid != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket peer belongs to a different user",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn verify_local_peer(stream: &LocalStream) -> io::Result<()> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most `length` bytes into a correctly sized ucred value.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: geteuid reads process credentials and has no preconditions.
    if credentials.uid != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket peer belongs to a different user",
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn verify_local_peer(_stream: &LocalStream) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credential verification is not implemented on this POSIX platform",
    ))
}
