#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

#[cfg(not(unix))]
compile_error!("Phase 4B2 koda-exec currently supports POSIX systems only.");

mod attachment;
mod durable;
mod framing;
mod internal_protocol;
mod platform;
mod protocol;
mod pty_output;
mod supervisor;
mod worker;

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use protocol::{
    HelloParams, MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, Request, Response,
    validate_hello, validate_request,
};
use serde_json::json;
use supervisor::Supervisor;

use crate::platform::{LocalStream, capabilities};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("koda-exec: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    match parse_arguments(std::env::args().skip(1))? {
        Arguments::Serve {
            endpoint,
            state_dir,
        } => serve(endpoint, state_dir).await,
        Arguments::Worker { job_dir, token_fd } => worker::run_worker(&job_dir, token_fd)
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message).into()),
        Arguments::CommandBootstrap { gate_fd, argv } => {
            worker::run_command_bootstrap(gate_fd, argv)?;
            Ok(())
        }
    }
}

async fn serve(endpoint: PathBuf, state_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    platform::prepare_local_endpoint_parent(&endpoint)?;
    // Binding first serializes recovery: only one Supervisor may inspect and adopt Workers.
    let listener = platform::bind_local_endpoint(&endpoint).await?;
    let binary_path = std::env::current_exe()?;
    let supervisor = Supervisor::open(&state_dir, binary_path)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;

    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(error) = platform::verify_local_peer(&stream) {
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

enum Arguments {
    Serve {
        endpoint: PathBuf,
        state_dir: PathBuf,
    },
    Worker {
        job_dir: PathBuf,
        token_fd: i32,
    },
    CommandBootstrap {
        gate_fd: i32,
        argv: Vec<String>,
    },
}

fn parse_arguments(
    mut arguments: impl Iterator<Item = String>,
) -> Result<Arguments, Box<dyn std::error::Error>> {
    match arguments.next().as_deref() {
        Some("serve") => {
            let values = parse_named_arguments(arguments)?;
            let endpoint = local_endpoint_argument(&values)?;
            let state_dir = required_path(&values, "--state-dir")?;
            platform::validate_local_endpoint(&endpoint)?;
            if !state_dir.is_absolute() {
                return Err("--state-dir must be an absolute path".into());
            }
            Ok(Arguments::Serve {
                endpoint,
                state_dir,
            })
        }
        Some("worker") => {
            let values = parse_named_arguments(arguments)?;
            let job_dir = required_path(&values, "--job-dir")?;
            if !job_dir.is_absolute() {
                return Err("--job-dir must be an absolute path".into());
            }
            let token_fd = values
                .get("--token-fd")
                .ok_or("--token-fd is required")?
                .parse::<i32>()?;
            if token_fd < 3 {
                return Err("--token-fd must be a non-standard descriptor".into());
            }
            Ok(Arguments::Worker { job_dir, token_fd })
        }
        Some("command-bootstrap") => {
            if arguments.next().as_deref() != Some("--gate-fd") {
                return Err("command bootstrap requires --gate-fd".into());
            }
            let gate_fd = arguments
                .next()
                .ok_or("--gate-fd is required")?
                .parse::<i32>()?;
            if gate_fd < 3 || arguments.next().as_deref() != Some("--") {
                return Err("command bootstrap descriptor or separator is invalid".into());
            }
            let argv = arguments.collect::<Vec<_>>();
            if argv.is_empty() {
                return Err("command bootstrap argv is required".into());
            }
            Ok(Arguments::CommandBootstrap { gate_fd, argv })
        }
        _ => Err(
            "usage: koda-exec serve --endpoint ENDPOINT --state-dir PATH | koda-exec worker --job-dir PATH --token-fd FD"
                .into(),
        ),
    }
}

fn parse_named_arguments(
    mut arguments: impl Iterator<Item = String>,
) -> Result<std::collections::HashMap<String, String>, Box<dyn std::error::Error>> {
    let mut values = std::collections::HashMap::new();
    while let Some(name) = arguments.next() {
        if !name.starts_with("--") || values.contains_key(&name) {
            return Err(format!("unknown or duplicate argument: {name}").into());
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {name}"))?;
        values.insert(name, value);
    }
    Ok(values)
}

fn required_path(
    values: &std::collections::HashMap<String, String>,
    name: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    values
        .get(name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is required").into())
}

fn local_endpoint_argument(
    values: &std::collections::HashMap<String, String>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    match (values.get("--endpoint"), values.get("--socket")) {
        (Some(endpoint), None) | (None, Some(endpoint)) => Ok(PathBuf::from(endpoint)),
        (Some(_), Some(_)) => Err("--endpoint and --socket cannot be used together".into()),
        (None, None) => Err("--endpoint is required".into()),
    }
}

async fn handle_connection(mut stream: LocalStream, supervisor: Arc<Supervisor>) -> io::Result<()> {
    let mut handshaken = false;
    loop {
        let payload = match framing::read_frame(&mut stream).await? {
            Some(payload) => payload,
            None => return Ok(()),
        };
        let request = match serde_json::from_slice::<Request>(&payload) {
            Ok(request) => request,
            Err(error) => {
                framing::write_json_frame(
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
                                    "process_group": capabilities().process_group,
                                    "job_object": capabilities().job_object,
                                    "pty": capabilities().pty,
                                    "reattach": capabilities().reattach,
                                    "durable_restart_recovery": capabilities().durable_restart_recovery
                                },
                                "limits": {
                                    "max_frame_bytes": MAX_FRAME_BYTES,
                                    "max_output_read_bytes": protocol::MAX_OUTPUT_READ_BYTES,
                                    "max_output_limit_bytes": protocol::MAX_OUTPUT_LIMIT_BYTES,
                                    "max_background_timeout_ms": protocol::MAX_BACKGROUND_TIMEOUT_MS,
                                    "max_pty_input_bytes": protocol::MAX_PTY_INPUT_BYTES,
                                    "max_pending_pty_input_bytes": protocol::MAX_PENDING_PTY_INPUT_BYTES
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
        framing::write_json_frame(&mut stream, &response).await?;
    }
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

    #[test]
    fn endpoint_argument_replaces_socket_with_a_compatibility_alias() {
        for name in ["--endpoint", "--socket"] {
            let result = parse_arguments(
                [
                    "serve",
                    name,
                    "/tmp/koda.sock",
                    "--state-dir",
                    "/tmp/koda-exec",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            assert!(matches!(result, Ok(Arguments::Serve { .. })));
        }

        let duplicate = parse_arguments(
            [
                "serve",
                "--endpoint",
                "/tmp/koda.sock",
                "--socket",
                "/tmp/legacy.sock",
                "--state-dir",
                "/tmp/koda-exec",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn worker_requires_inherited_descriptor() {
        let result = parse_arguments(
            ["worker", "--job-dir", "/tmp/job", "--token-fd", "2"]
                .into_iter()
                .map(str::to_owned),
        );
        assert!(result.is_err());
    }
}
