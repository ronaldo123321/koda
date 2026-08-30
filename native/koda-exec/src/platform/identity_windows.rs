use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the non-null process handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

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

pub fn process_start_identity(pid: u32) -> io::Result<Option<String>> {
    // SAFETY: OpenProcess receives a numeric PID and returns an owned handle on success.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let process = OwnedHandle(process);
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: every FILETIME pointer is writable and the process handle is valid.
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    if created == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an empty process creation time",
        ));
    }
    Ok(Some(format!("windows-process-created:{created}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_identity_is_stable_and_matches() {
        let first = current_process_identity().expect("identity");
        let second = current_process_identity().expect("identity");
        assert_eq!(first, second);
        assert!(process_identity_matches(std::process::id(), &first));
        assert!(!process_identity_matches(u32::MAX, &first));
    }
}
