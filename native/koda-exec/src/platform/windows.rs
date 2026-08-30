use std::ffi::{OsStr, OsString, c_void};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::slice;

use sha2::{Digest, Sha256};
use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use tokio::sync::Mutex;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    ERROR_SUCCESS, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, LocalFree,
    SetHandleInformation,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, CopySid, CreateWellKnownSid,
    DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorDacl, GetTokenInformation, IsValidSid, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SECURITY_MAX_SID_SIZE,
    TOKEN_QUERY, TOKEN_USER, TokenUser, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::Pipes::{CreatePipe, GetNamedPipeClientProcessId};
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION,
};
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, GetCurrentProcess, InitializeProcThreadAttributeList,
    OpenProcess, OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROCESS_QUERY_LIMITED_INFORMATION, UpdateProcThreadAttribute,
};

const PIPE_PREFIX: &str = r"\\.\pipe\koda-exec-";

pub type LocalStream = NamedPipeServer;

pub struct LocalListener {
    endpoint: OsString,
    next: Mutex<Option<NamedPipeServer>>,
}

struct OwnedHandle(HANDLE);

// Windows kernel handles can be transferred between threads. Ownership remains unique here.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper owns the non-null handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct SidBuffer {
    storage: Vec<usize>,
    bytes: usize,
}

impl SidBuffer {
    fn with_bytes(bytes: usize) -> Self {
        let words = bytes.div_ceil(size_of::<usize>()).max(1);
        Self {
            storage: vec![0; words],
            bytes,
        }
    }

    fn as_ptr(&self) -> PSID {
        self.storage.as_ptr().cast_mut().cast()
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: storage owns at least `bytes` initialized bytes.
        unsafe { slice::from_raw_parts(self.storage.as_ptr().cast(), self.bytes) }
    }
}

struct SecurityDescriptor(*mut c_void);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: SDDL conversion allocated this descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

pub struct BootstrapRead(OwnedHandle);
pub struct BootstrapWrite(OwnedHandle);

pub struct RestrictedHandleList {
    storage: Vec<usize>,
    handles: Vec<HANDLE>,
}

impl RestrictedHandleList {
    pub fn new(handles: &[HANDLE]) -> io::Result<Self> {
        if handles.is_empty() || handles.iter().any(|handle| handle.is_null()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "restricted handle list must contain valid handles",
            ));
        }
        for handle in handles {
            let mut flags = 0;
            // SAFETY: the caller supplied a live handle; flags is writable.
            if unsafe { GetHandleInformation(*handle, &mut flags) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if flags & HANDLE_FLAG_INHERIT == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "restricted child handle is not inheritable",
                ));
            }
        }

        let mut bytes = 0usize;
        // SAFETY: the documented sizing call uses a null list and fills `bytes`.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        // SAFETY: storage is aligned, writable, and at least `bytes` long.
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let handles = handles.to_vec();
        // SAFETY: list is initialized and `handles` remains alive with this object.
        if unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles.as_slice()),
                null_mut(),
                null(),
            )
        } == 0
        {
            // SAFETY: list was initialized successfully above.
            unsafe {
                DeleteProcThreadAttributeList(list);
            }
            return Err(io::Error::last_os_error());
        }
        Ok(Self { storage, handles })
    }

    pub fn as_raw(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr().cast()
    }

    pub fn handles(&self) -> &[HANDLE] {
        &self.handles
    }
}

impl Drop for RestrictedHandleList {
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            // SAFETY: successful construction initialized this list exactly once.
            unsafe {
                DeleteProcThreadAttributeList(self.storage.as_mut_ptr().cast());
            }
        }
    }
}

pub fn validate_local_endpoint(endpoint: &Path) -> io::Result<()> {
    let value = endpoint.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows executor endpoint must be Unicode",
        )
    })?;
    let suffix = value.strip_prefix(PIPE_PREFIX).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows executor endpoint must use the local Koda Named Pipe namespace",
        )
    })?;
    if suffix.is_empty()
        || value.len() > 240
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows executor endpoint contains invalid characters or length",
        ));
    }
    Ok(())
}

pub fn default_local_endpoint(state_directory: &Path) -> io::Result<PathBuf> {
    let state_directory = std::fs::canonicalize(state_directory)?;
    let user = current_user_sid()?;
    let sid_hash = short_hash(user.bytes());
    let normalized_state = state_directory.to_string_lossy().to_lowercase();
    let state_hash = short_hash(normalized_state.as_bytes());
    Ok(PathBuf::from(format!(
        "{PIPE_PREFIX}{sid_hash}-{state_hash}"
    )))
}

pub fn prepare_local_endpoint_parent(endpoint: &Path) -> io::Result<()> {
    validate_local_endpoint(endpoint)
}

pub async fn bind_local_endpoint(endpoint: &Path) -> io::Result<LocalListener> {
    validate_local_endpoint(endpoint)?;
    let endpoint = endpoint.as_os_str().to_owned();
    let first = create_server(&endpoint, true)?;
    Ok(LocalListener {
        endpoint,
        next: Mutex::new(Some(first)),
    })
}

pub async fn accept_local_connection(listener: &LocalListener) -> io::Result<LocalStream> {
    let mut next = listener.next.lock().await;
    let server = next.take().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotConnected,
            "Named Pipe listener has no pending instance",
        )
    })?;
    if let Err(error) = server.connect().await {
        *next = Some(create_server(&listener.endpoint, false)?);
        return Err(error);
    }
    *next = Some(create_server(&listener.endpoint, false)?);
    Ok(server)
}

pub fn verify_local_peer(stream: &LocalStream) -> io::Result<()> {
    let mut pid = 0;
    let pipe = stream.as_raw_handle() as HANDLE;
    // SAFETY: `pipe` is a connected Named Pipe server handle and pid is writable.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 || pid == 0 {
        return Err(io::Error::last_os_error());
    }
    let peer = process_user_sid(pid)?;
    let current = current_user_sid()?;
    // SAFETY: both buffers contain validated SIDs.
    if unsafe { EqualSid(peer.as_ptr(), current.as_ptr()) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Named Pipe peer belongs to a different logon user",
        ));
    }
    Ok(())
}

pub fn prepare_state_root(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    secure_private_directory(path)?;
    validate_private_directory(path)
}

pub fn worker_control_root() -> PathBuf {
    std::env::temp_dir().join("koda-exec")
}

pub fn secure_private_directory(path: &Path) -> io::Result<()> {
    validate_real_object(path, true)?;
    apply_private_security(path, true)?;
    validate_private_acl(path)
}

pub fn validate_private_directory(path: &Path) -> io::Result<()> {
    validate_real_object(path, true)?;
    validate_private_acl(path)
}

pub fn validate_private_file(path: &Path, exact_size: Option<u64>) -> io::Result<()> {
    validate_real_object(path, false)?;
    if let Some(exact_size) = exact_size
        && std::fs::metadata(path)?.len() != exact_size
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private file size is invalid",
        ));
    }
    validate_private_acl(path)
}

pub fn open_new_private_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)?;
    if let Err(error) =
        apply_private_security(path, false).and_then(|()| validate_private_file(path, None))
    {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

pub fn open_exclusive_lock(path: &Path) -> io::Result<Option<File>> {
    match OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.kind() == io::ErrorKind::PermissionDenied
                || matches!(
                    error.raw_os_error(),
                    Some(code)
                        if code == ERROR_SHARING_VIOLATION as i32
                            || code == ERROR_LOCK_VIOLATION as i32
                ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn sync_directory(_path: &Path) {}

pub fn create_bootstrap_channel() -> io::Result<(BootstrapRead, BootstrapWrite)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    // SAFETY: output handle pointers and security attributes are valid.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = BootstrapRead(OwnedHandle(read));
    let write = BootstrapWrite(OwnedHandle(write));
    // The parent writer must never be inherited; the child reader remains inheritable.
    // SAFETY: write is a live handle owned by this function.
    if unsafe { SetHandleInformation(write.0.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((read, write))
}

pub fn bootstrap_read_handle(read: &BootstrapRead) -> HANDLE {
    read.0.0
}

pub fn bootstrap_write_handle(write: &BootstrapWrite) -> HANDLE {
    write.0.0
}

fn create_server(endpoint: &OsStr, first_instance: bool) -> io::Result<NamedPipeServer> {
    let descriptor = private_security_descriptor(false)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .pipe_mode(PipeMode::Byte)
        .reject_remote_clients(true)
        .first_pipe_instance(first_instance);
    // SAFETY: attributes and its descriptor remain valid for the duration of CreateNamedPipeW.
    unsafe {
        options.create_with_security_attributes_raw(
            endpoint,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
}

fn current_user_sid() -> io::Result<SidBuffer> {
    // SAFETY: GetCurrentProcess returns a valid pseudo-handle for this process.
    token_user_sid(unsafe { GetCurrentProcess() })
}

fn process_user_sid(pid: u32) -> io::Result<SidBuffer> {
    // SAFETY: OpenProcess receives a numeric PID and returns an owned query handle.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = OwnedHandle(process);
    token_user_sid(process.0)
}

fn token_user_sid(process: HANDLE) -> io::Result<SidBuffer> {
    let mut token = null_mut();
    // SAFETY: process is queryable and token is a writable handle slot.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    let mut bytes = 0u32;
    // SAFETY: the sizing call intentionally supplies no output buffer.
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes);
    }
    if bytes == 0
        || io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
    {
        return Err(io::Error::last_os_error());
    }
    let mut information = SidBuffer::with_bytes(bytes as usize);
    // SAFETY: aligned storage is at least `bytes` long.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            information.storage.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: TokenUser returned a complete aligned TOKEN_USER structure.
    let source = unsafe {
        (*(information.storage.as_ptr().cast::<TOKEN_USER>()))
            .User
            .Sid
    };
    copy_sid(source)
}

fn local_system_sid() -> io::Result<SidBuffer> {
    let mut sid = SidBuffer::with_bytes(SECURITY_MAX_SID_SIZE as usize);
    let mut bytes = SECURITY_MAX_SID_SIZE;
    // SAFETY: sid storage is large enough for every well-known SID.
    if unsafe { CreateWellKnownSid(WinLocalSystemSid, null_mut(), sid.as_ptr(), &mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    sid.bytes = bytes as usize;
    Ok(sid)
}

fn copy_sid(source: PSID) -> io::Result<SidBuffer> {
    // SAFETY: source comes from a successful token/SID API call.
    if source.is_null() || unsafe { IsValidSid(source) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid user SID",
        ));
    }
    // SAFETY: source is a validated SID.
    let bytes = unsafe { GetLengthSid(source) };
    let destination = SidBuffer::with_bytes(bytes as usize);
    // SAFETY: destination is exactly large enough and both SID pointers are valid.
    if unsafe { CopySid(bytes, destination.as_ptr(), source) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(destination)
}

fn private_security_descriptor(inherit: bool) -> io::Result<SecurityDescriptor> {
    let user = current_user_sid()?;
    let user = sid_string(&user)?;
    let inheritance = if inherit { "OICI" } else { "" };
    let sddl = format!("O:{user}D:P(A;{inheritance};GA;;;SY)(A;{inheritance};GA;;;{user})");
    let sddl = wide(&sddl);
    let mut descriptor = null_mut();
    // SAFETY: SDDL is null-terminated and descriptor is a writable output pointer.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SECURITY_DESCRIPTOR_REVISION,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(SecurityDescriptor(descriptor))
}

fn sid_string(sid: &SidBuffer) -> io::Result<String> {
    let mut value = null_mut();
    // SAFETY: sid is valid and value is a writable PWSTR slot.
    if unsafe { ConvertSidToStringSidW(sid.as_ptr(), &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut length = 0;
    // SAFETY: ConvertSidToStringSidW returned a null-terminated allocation.
    unsafe {
        while *value.add(length) != 0 {
            length += 1;
        }
    }
    // SAFETY: the preceding loop found the allocation's terminator.
    let result = String::from_utf16(unsafe { slice::from_raw_parts(value, length) })
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "user SID is not UTF-16"));
    // SAFETY: ConvertSidToStringSidW allocated value with LocalAlloc.
    unsafe {
        LocalFree(value.cast());
    }
    result
}

fn apply_private_security(path: &Path, inherit: bool) -> io::Result<()> {
    let descriptor = private_security_descriptor(inherit)?;
    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    // SAFETY: descriptor is valid and all output pointers are writable.
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor.0,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    } == 0
        || dacl_present == 0
        || dacl.is_null()
    {
        return Err(io::Error::last_os_error());
    }
    let user = current_user_sid()?;
    let path = wide(path.as_os_str());
    // SAFETY: path is null-terminated and user/dacl remain valid for this call.
    let result = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            user.as_ptr(),
            null_mut(),
            dacl,
            null_mut(),
        )
    };
    if result == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result as i32))
    }
}

fn validate_private_acl(path: &Path) -> io::Result<()> {
    let path = wide(path.as_os_str());
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: path is null-terminated and all requested output slots are writable.
    let result = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let descriptor = SecurityDescriptor(descriptor);
    if owner.is_null() || dacl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private object has no owner or DACL",
        ));
    }
    let user = current_user_sid()?;
    let system = local_system_sid()?;
    // SAFETY: owner and both comparison SIDs are valid while descriptor is alive.
    if unsafe { EqualSid(owner, user.as_ptr()) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private object owner does not match the current user",
        ));
    }

    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl is valid and information is a correctly sized writable buffer.
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut saw_user = false;
    let mut saw_system = false;
    if information.AceCount != 2 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private object DACL contains unexpected principals",
        ));
    }
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        // SAFETY: index is within the reported ACE count and output is writable.
        if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let ace = raw_ace.cast::<ACCESS_ALLOWED_ACE>();
        // SAFETY: every ACE has an ACE_HEADER; only allow ACEs are accepted below.
        if unsafe { (*ace).Header.AceType } != ACCESS_ALLOWED_ACE_TYPE as u8 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private object DACL contains a non-allow ACE",
            ));
        }
        // SAFETY: ACCESS_ALLOWED_ACE stores its SID beginning at SidStart.
        let sid = unsafe { (&raw const (*ace).SidStart).cast_mut().cast() };
        // SAFETY: SID is contained in a validated ACL returned by Windows.
        if unsafe { EqualSid(sid, user.as_ptr()) } != 0 {
            saw_user = true;
        } else if unsafe { EqualSid(sid, system.as_ptr()) } != 0 {
            saw_system = true;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private object DACL grants access to an unrelated principal",
            ));
        }
    }
    drop(descriptor);
    if saw_user && saw_system {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private object DACL is missing the user or LocalSystem",
        ))
    }
}

fn validate_real_object(path: &Path, directory: bool) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.is_dir() != directory
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path is a reparse point or has the wrong object type",
        ));
    }
    Ok(())
}

fn short_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::Foundation::GetHandleInformation;

    #[test]
    fn endpoint_is_sid_and_state_bound_without_disclosure() {
        let root = std::env::temp_dir().join(format!("koda-endpoint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("state root");
        let endpoint = default_local_endpoint(&root).expect("endpoint");
        validate_local_endpoint(&endpoint).expect("valid endpoint");
        let value = endpoint.to_string_lossy();
        assert!(value.starts_with(PIPE_PREFIX));
        assert!(!value.contains(&root.to_string_lossy().to_string()));
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn private_acl_and_exclusive_lock_are_enforced() {
        let root = std::env::temp_dir().join(format!("koda-security-{}", uuid::Uuid::new_v4()));
        prepare_state_root(&root).expect("private root");
        let lock_path = root.join("store.lock");
        open_new_private_file(&lock_path).expect("lock file");
        validate_private_file(&lock_path, Some(0)).expect("private lock");
        let first = open_exclusive_lock(&lock_path)
            .expect("first")
            .expect("acquired");
        assert!(open_exclusive_lock(&lock_path).expect("second").is_none());
        drop(first);
        assert!(open_exclusive_lock(&lock_path).expect("third").is_some());
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn bootstrap_lists_only_inheritable_child_handles() {
        let (read, write) = create_bootstrap_channel().expect("channel");
        let mut read_flags = 0;
        let mut write_flags = 0;
        // SAFETY: both bootstrap handles are live and flag outputs are writable.
        assert_ne!(
            unsafe { GetHandleInformation(bootstrap_read_handle(&read), &mut read_flags) },
            0
        );
        assert_ne!(
            unsafe { GetHandleInformation(bootstrap_write_handle(&write), &mut write_flags) },
            0
        );
        assert_ne!(read_flags & HANDLE_FLAG_INHERIT, 0);
        assert_eq!(write_flags & HANDLE_FLAG_INHERIT, 0);
        let list = RestrictedHandleList::new(&[bootstrap_read_handle(&read)]).expect("list");
        assert_eq!(list.handles(), &[bootstrap_read_handle(&read)]);
    }

    #[tokio::test]
    async fn named_pipe_is_exclusive_authenticated_and_framed() {
        let root =
            std::env::temp_dir().join(format!("koda-pipe-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("state root");
        let endpoint = default_local_endpoint(&root).expect("endpoint");
        let listener = bind_local_endpoint(&endpoint).await.expect("listener");
        assert!(bind_local_endpoint(&endpoint).await.is_err());

        let mut client = ClientOptions::new().open(&endpoint).expect("client");
        let mut server = accept_local_connection(&listener).await.expect("accept");
        verify_local_peer(&server).expect("same-user peer");
        crate::framing::write_json_frame(&mut client, &json!({ "ping": true }))
            .await
            .expect("write");
        let value: serde_json::Value = crate::framing::read_json_frame(&mut server)
            .await
            .expect("read")
            .expect("frame");
        assert_eq!(value, json!({ "ping": true }));
        drop((client, server, listener));
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
