#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

//! Exact macOS per-process rlimit application and bootstrap confirmation.

use std::io;
use std::time::Duration;

use crate::execution_policy::ExecutionResourceLimits;

pub const RESOURCE_CONFIRMATION_FD: i32 = 6;
const CONFIRMATION_MARKER: &[u8] = b"KODA_RESOURCE_V1\0";
const DIGEST_BYTES: usize = 64;
const CONFIRMATION_FRAME_BYTES: usize = CONFIRMATION_MARKER.len() + DIGEST_BYTES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceTestFault {
    Apply,
    ConfirmationCorrupt,
    ConfirmationTimeout,
}

impl ResourceTestFault {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "apply" => Ok(Self::Apply),
            "confirmation_corrupt" => Ok(Self::ConfirmationCorrupt),
            "confirmation_timeout" => Ok(Self::ConfirmationTimeout),
            _ => Err("command bootstrap resource test fault is invalid"),
        }
    }
}

pub fn confirmation_frame(resources: &ExecutionResourceLimits) -> io::Result<Vec<u8>> {
    validate_supported_request(resources)?;
    let digest = resources
        .digest()
        .map_err(|_| invalid_request("resource request digest is invalid"))?;
    let mut frame = Vec::with_capacity(CONFIRMATION_FRAME_BYTES);
    frame.extend_from_slice(CONFIRMATION_MARKER);
    frame.extend_from_slice(digest.as_bytes());
    Ok(frame)
}

#[cfg(target_os = "macos")]
pub fn apply_and_confirm(
    confirmation_fd: i32,
    resources: &ExecutionResourceLimits,
    test_fault: Option<ResourceTestFault>,
) -> io::Result<()> {
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::FromRawFd;

    if confirmation_fd < 3 {
        return Err(invalid_request(
            "resource confirmation descriptor overlaps standard streams",
        ));
    }
    validate_supported_request(resources)?;
    if test_fault == Some(ResourceTestFault::Apply) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "resource limit test application failure",
        ));
    }
    if let Some(milliseconds) = resources.process_cpu_time_ms {
        if milliseconds % 1_000 != 0 {
            return Err(invalid_request("CPU time limit granularity is invalid"));
        }
        apply_one(
            "process_cpu_time_ms",
            libc::RLIMIT_CPU,
            milliseconds / 1_000,
        )?;
    }
    if let Some(open_files) = resources.process_open_files {
        apply_one("process_open_files", libc::RLIMIT_NOFILE, open_files)?;
    }
    if let Some(file_size) = resources.process_file_size_bytes {
        apply_one("process_file_size_bytes", libc::RLIMIT_FSIZE, file_size)?;
    }
    let mut frame = confirmation_frame(resources)?;
    if test_fault == Some(ResourceTestFault::ConfirmationCorrupt) {
        frame[0] ^= 0xff;
    }
    // SAFETY: the Worker transfers exclusive ownership of this dedicated pipe
    // endpoint to the command bootstrap.
    let mut confirmation = unsafe { File::from_raw_fd(confirmation_fd) };
    if test_fault == Some(ResourceTestFault::ConfirmationTimeout) {
        std::thread::sleep(Duration::from_secs(4));
        return Ok(());
    }
    confirmation.write_all(&frame)?;
    confirmation.flush()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn apply_and_confirm(
    _confirmation_fd: i32,
    _resources: &ExecutionResourceLimits,
    _test_fault: Option<ResourceTestFault>,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS resource limits are unavailable on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn apply_one(name: &str, resource: libc::c_int, value: u64) -> io::Result<()> {
    let requested = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: setrlimit reads the initialized value and does not retain it.
    if unsafe { libc::setrlimit(resource, &requested) } != 0 {
        return Err(apply_error(name));
    }
    let mut actual = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit initializes the provided structure.
    if unsafe { libc::getrlimit(resource, &mut actual) } != 0 {
        return Err(apply_error(name));
    }
    if actual.rlim_cur != value || actual.rlim_max != value {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("resource limit {name} did not match after application"),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_error(name: &str) -> io::Error {
    let kind = io::Error::last_os_error().kind();
    io::Error::new(kind, format!("resource limit {name} could not be applied"))
}

fn validate_supported_request(resources: &ExecutionResourceLimits) -> io::Result<()> {
    resources
        .validate()
        .map_err(|_| invalid_request("resource request is invalid"))?;
    if resources.is_empty()
        || resources.process_address_space_bytes.is_some()
        || resources.job_process_count.is_some()
    {
        return Err(invalid_request("resource request is unsupported on macOS"));
    }
    if resources
        .process_cpu_time_ms
        .is_some_and(|milliseconds| milliseconds % 1_000 != 0)
    {
        return Err(invalid_request("CPU time limit granularity is invalid"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn wait_for_confirmation(
    read: crate::platform::bootstrap::BootstrapRead,
    resources: &ExecutionResourceLimits,
    timeout: Duration,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let expected = confirmation_frame(resources)?;
    let actual = read_exact_with_timeout(read.as_raw_fd(), expected.len(), timeout)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "resource confirmation frame is invalid",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn wait_for_confirmation(
    _read: crate::platform::bootstrap::BootstrapRead,
    _resources: &ExecutionResourceLimits,
    _timeout: Duration,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "macOS resource confirmation is unavailable on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn read_exact_with_timeout(
    descriptor: i32,
    length: usize,
    timeout: Duration,
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
                "resource confirmation timed out",
            ));
        }
        let milliseconds = remaining.as_millis().min(i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd: descriptor,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        // SAFETY: poll receives one initialized descriptor for a bounded timeout.
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
        // SAFETY: read writes at most the remaining initialized vector length.
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
                "resource confirmation ended early",
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

fn invalid_request(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_is_fixed_bounded_and_request_bound() {
        let first = ExecutionResourceLimits {
            process_cpu_time_ms: Some(1_000),
            process_address_space_bytes: None,
            job_process_count: None,
            process_open_files: Some(64),
            process_file_size_bytes: None,
        };
        let second = ExecutionResourceLimits {
            process_open_files: Some(65),
            ..first.clone()
        };
        assert_eq!(
            confirmation_frame(&first).unwrap().len(),
            CONFIRMATION_FRAME_BYTES
        );
        assert_ne!(
            confirmation_frame(&first).unwrap(),
            confirmation_frame(&second).unwrap()
        );
    }

    #[test]
    fn unsupported_and_inexact_requests_are_rejected() {
        let address_space = ExecutionResourceLimits {
            process_cpu_time_ms: None,
            process_address_space_bytes: Some(4_096),
            job_process_count: None,
            process_open_files: None,
            process_file_size_bytes: None,
        };
        assert!(confirmation_frame(&address_space).is_err());
        let cpu = ExecutionResourceLimits {
            process_cpu_time_ms: Some(1_001),
            process_address_space_bytes: None,
            job_process_count: None,
            process_open_files: None,
            process_file_size_bytes: None,
        };
        assert!(confirmation_frame(&cpu).is_err());
    }

    #[test]
    fn test_fault_names_are_strict() {
        assert_eq!(
            ResourceTestFault::parse("apply"),
            Ok(ResourceTestFault::Apply)
        );
        assert_eq!(
            ResourceTestFault::parse("confirmation_corrupt"),
            Ok(ResourceTestFault::ConfirmationCorrupt)
        );
        assert!(ResourceTestFault::parse("anything_else").is_err());
    }
}
