#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

#[cfg(not(unix))]
compile_error!("Phase 4B1 koda-exec currently supports POSIX systems only.");

mod protocol;
mod supervisor;

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use protocol::{
    HelloParams, MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, Request, Response,
    validate_hello, validate_request,
};
use serde_json::json;
use supervisor::Supervisor;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("koda-exec: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = parse_arguments(std::env::args().skip(1))?;
    let supervisor = Supervisor::open(&arguments.state_dir)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let listener = bind_private_socket(&arguments.socket).await?;

    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(error) = verify_peer(&stream) {
            eprintln!("koda-exec: rejected local peer: {error}");
            continue;
        }
        let connection_supervisor = Arc::clone(&supervisor);
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, connection_supervisor).await {
                let ordinary_disconnect = matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                );
                if !ordinary_disconnect {
                    eprintln!("koda-exec: connection failed: {error}");
                }
            }
        });
    }
}

struct Arguments {
    socket: PathBuf,
    state_dir: PathBuf,
}

fn parse_arguments(
    mut arguments: impl Iterator<Item = String>,
) -> Result<Arguments, Box<dyn std::error::Error>> {
    if arguments.next().as_deref() != Some("serve") {
        return Err("usage: koda-exec serve --socket PATH --state-dir PATH".into());
    }
    let mut socket = None;
    let mut state_dir = None;
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {argument}"))?;
        match argument.as_str() {
            "--socket" => socket = Some(PathBuf::from(value)),
            "--state-dir" => state_dir = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    let socket = socket.ok_or("--socket is required")?;
    let state_dir = state_dir.ok_or("--state-dir is required")?;
    if !socket.is_absolute() || !state_dir.is_absolute() {
        return Err("--socket and --state-dir must be absolute paths".into());
    }
    Ok(Arguments { socket, state_dir })
}

async fn bind_private_socket(path: &Path) -> Result<UnixListener, Box<dyn std::error::Error>> {
    let parent = path.parent().ok_or("socket path has no parent directory")?;
    create_private_directory(parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.file_type().is_socket() {
            return Err(format!(
                "refusing to replace non-socket executor endpoint '{}'",
                path.display()
            )
            .into());
        }
        if UnixStream::connect(path).await.is_ok() {
            return Err(format!("an executor is already listening at '{}'", path.display()).into());
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn create_private_directory(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "executor runtime path '{}' must be a real directory",
                path.display()
            )
            .into());
        }
    } else {
        std::fs::create_dir_all(path)?;
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

async fn handle_connection(mut stream: UnixStream, supervisor: Arc<Supervisor>) -> io::Result<()> {
    let mut handshaken = false;
    loop {
        let payload = match read_frame(&mut stream).await? {
            Some(payload) => payload,
            None => return Ok(()),
        };
        let request = match serde_json::from_slice::<Request>(&payload) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut stream,
                    &Response::failure(
                        "invalid".to_owned(),
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            format!("Request JSON is invalid: {error}"),
                        ),
                    ),
                )
                .await?;
                continue;
            }
        };
        let request_id = request.request_id.clone();
        let response = match validate_request(&request) {
            Err(error) => Response::failure(request_id, error),
            Ok(()) if request.method == "system/hello" => {
                match protocol::parse_params::<HelloParams>(request.params).and_then(|params| {
                    validate_hello(&params)?;
                    Ok(params)
                }) {
                    Ok(_) => {
                        handshaken = true;
                        Response::success(
                            request_id,
                            json!({
                                "protocol_version": PROTOCOL_VERSION,
                                "supervisor_version": env!("CARGO_PKG_VERSION"),
                                "platform": std::env::consts::OS,
                                "capabilities": {
                                    "process_group": true,
                                    "job_object": false,
                                    "pty": false,
                                    "reattach": true,
                                    "durable_restart_recovery": false
                                },
                                "limits": {
                                    "max_frame_bytes": MAX_FRAME_BYTES,
                                    "max_output_read_bytes": protocol::MAX_OUTPUT_READ_BYTES,
                                    "max_output_limit_bytes": protocol::MAX_OUTPUT_LIMIT_BYTES
                                }
                            }),
                        )
                    }
                    Err(error) => Response::failure(request_id, error),
                }
            }
            Ok(()) if !handshaken => Response::failure(
                request_id,
                ProtocolError::new(
                    "HANDSHAKE_REQUIRED",
                    "system/hello must succeed before other executor methods.",
                ),
            ),
            Ok(()) => match supervisor
                .dispatch(request_id.clone(), &request.method, request.params)
                .await
            {
                Ok(result) => Response::success(request_id, result),
                Err(error) => Response::failure(request_id, error),
            },
        };
        write_response(&mut stream, &response).await?;
    }
}

async fn read_frame(stream: &mut UnixStream) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {length} is outside the supported range"),
        ));
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

async fn write_response(stream: &mut UnixStream, response: &Response) -> io::Result<()> {
    let payload = serde_json::to_vec(response)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "executor response exceeded the frame limit",
        ));
    }
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await?;
    stream.write_all(&payload).await?;
    stream.flush().await
}

#[cfg(target_os = "macos")]
fn verify_peer(stream: &UnixStream) -> io::Result<()> {
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
            "executor peer belongs to a different user",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_peer(stream: &UnixStream) -> io::Result<()> {
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
            "executor peer belongs to a different user",
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn verify_peer(_stream: &UnixStream) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credential verification is not implemented on this POSIX platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_require_absolute_paths() {
        let result = parse_arguments(
            [
                "serve",
                "--socket",
                "relative.sock",
                "--state-dir",
                "/tmp/koda-exec",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        assert!(result.is_err());
    }
}
