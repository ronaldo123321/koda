use std::io;

pub fn current_process_identity() -> io::Result<String> {
    process_start_identity(std::process::id())?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "current process identity is unavailable",
        )
    })
}

pub fn process_identity_matches(pid: u32, expected: &str) -> bool {
    process_start_identity(pid)
        .ok()
        .flatten()
        .is_some_and(|actual| actual == expected)
}

#[cfg(target_os = "linux")]
pub fn process_start_identity(pid: u32) -> io::Result<Option<String>> {
    let path = format!("/proc/{pid}/stat");
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let end_name = contents
        .rfind(") ")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid Linux process stat"))?;
    let fields: Vec<&str> = contents[end_name + 2..].split_whitespace().collect();
    let start_time = fields.get(19).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux process stat has no start-time field",
        )
    })?;
    if !start_time.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Linux process start time is invalid",
        ));
    }
    Ok(Some(format!("linux-proc-start:{start_time}")))
}

#[cfg(target_os = "macos")]
pub fn process_start_identity(pid: u32) -> io::Result<Option<String>> {
    let pid = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "PID exceeds i32"))?;
    let mut information = ProcBsdInfo::default();
    // SAFETY: proc_pidinfo receives a correctly sized writable proc_bsdinfo buffer.
    let count = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            &mut information as *mut _ as *mut libc::c_void,
            std::mem::size_of::<ProcBsdInfo>() as i32,
        )
    };
    if count == 0 {
        let error = io::Error::last_os_error();
        return if matches!(
            error.raw_os_error(),
            Some(code) if code == libc::ESRCH || code == libc::ENOENT
        ) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    if count as usize != std::mem::size_of::<ProcBsdInfo>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "macOS returned a truncated process identity",
        ));
    }
    Ok(Some(format!(
        "macos-proc-start:{}:{}",
        information.pbi_start_tvsec, information.pbi_start_tvusec
    )))
}

#[cfg(target_os = "macos")]
const PROC_PIDTBSDINFO: i32 = 3;

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: libc::uid_t,
    pbi_gid: libc::gid_t,
    pbi_ruid: libc::uid_t,
    pbi_rgid: libc::gid_t,
    pbi_svuid: libc::uid_t,
    pbi_svgid: libc::gid_t,
    rfu_1: u32,
    pbi_comm: [libc::c_char; 16],
    pbi_name: [libc::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
impl Default for ProcBsdInfo {
    fn default() -> Self {
        // SAFETY: all-zero bytes are a valid initial value for this plain C data structure.
        unsafe { std::mem::zeroed() }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn process_start_identity(_pid: u32) -> io::Result<Option<String>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process start identity is unavailable on this POSIX platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_identity_is_stable_and_matches() {
        let identity = current_process_identity().expect("identity");
        assert!(process_identity_matches(std::process::id(), &identity));
    }
}
