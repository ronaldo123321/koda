use super::*;
use serde_json::json;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/testkit/fixtures/execution-policy-v1.json"
    )))
    .unwrap()
}

fn macos_fixtures() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/testkit/fixtures/execution-policy-v2.json"
    )))
    .unwrap()
}

fn linux_fixtures() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/testkit/fixtures/execution-policy-v3.json"
    )))
    .unwrap()
}

fn base() -> ExecutionPolicy {
    resolve_execution_policy("/workspace", None, None).unwrap()
}

#[test]
fn policy_golden_bytes_and_digests() {
    for case in fixtures()["policy_cases"].as_array().unwrap() {
        let policy = ExecutionPolicy::parse(case["policy"].clone()).unwrap();
        assert_eq!(
            policy.canonical_json().unwrap(),
            case["canonical"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            policy.digest().unwrap(),
            case["sha256"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn capability_golden_bytes_and_digests() {
    let mut digests = std::collections::HashSet::new();
    for case in fixtures()["capability_cases"].as_array().unwrap() {
        let caps = ExecutionCapabilities::parse(case["capabilities"].clone()).unwrap();
        assert_eq!(c1_execution_capabilities(caps.backend), caps);
        assert_eq!(
            caps.canonical_json().unwrap(),
            case["canonical"].as_str().unwrap()
        );
        assert_eq!(caps.digest().unwrap(), case["sha256"].as_str().unwrap());
        digests.insert(caps.digest().unwrap());
    }
    assert_eq!(digests.len(), 4);
}

#[test]
fn macos_capability_golden_bytes_digest_and_matrix() {
    let fixture = macos_fixtures();
    let expected = ExecutionCapabilities::parse(fixture["capability"]["capabilities"].clone())
        .expect("valid macOS capabilities");
    let caps = macos_seatbelt_execution_capabilities();
    assert_eq!(caps, expected);
    assert_eq!(
        caps.canonical_json().unwrap(),
        fixture["capability"]["canonical"].as_str().unwrap()
    );
    assert_eq!(
        caps.digest().unwrap(),
        fixture["capability"]["sha256"].as_str().unwrap()
    );

    let policy = ExecutionPolicy::parse(fixture["policy"].clone()).unwrap();
    for filesystem in [
        FilesystemPolicy::Unrestricted,
        FilesystemPolicy::ReadOnly,
        FilesystemPolicy::WorkspaceWrite,
    ] {
        for network in [NetworkPolicy::Inherit, NetworkPolicy::Deny] {
            let candidate = ExecutionPolicy {
                filesystem,
                network,
                ..policy.clone()
            };
            assert!(
                evaluate_execution_policy(&candidate, &caps)
                    .unwrap()
                    .allowed
            );
            let admission = create_execution_admission_snapshot(&candidate, &caps).unwrap();
            let encoded = serde_json::to_string(&admission).unwrap();
            assert!(!encoded.contains(r#""applied""#));
            admission.validate().unwrap();
        }
    }

    let unsupported = ExecutionPolicy {
        process_isolation: ProcessIsolationPolicy::Required,
        ..policy
    };
    assert_eq!(
        evaluate_execution_policy(&unsupported, &caps).unwrap(),
        ExecutionPolicyEvaluation {
            allowed: false,
            unmet: vec![UnmetRequirement {
                dimension: ExecutionPolicyDimension::ProcessIsolation,
                reason: UnmetReason::NotImplemented,
            }],
        }
    );
    assert_eq!(
        create_execution_admission_snapshot(&unsupported, &caps).unwrap_err(),
        ExecutionPolicyError::ExecutionPolicyUnavailable
    );
}

#[test]
fn shared_macos_snapshot_cases_match_typescript_validation() {
    for case in macos_fixtures()["snapshot_cases"].as_array().unwrap() {
        let parsed = ExecutionSecuritySnapshot::parse(case["input"].clone());
        if case["valid"].as_bool().unwrap() {
            assert_eq!(
                serde_json::to_value(parsed.unwrap()).unwrap(),
                case["input"],
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(
                parsed.expect_err(case["name"].as_str().unwrap()),
                ExecutionPolicyError::ExecutionSecurityCorrupt
            );
        }
    }
}

#[test]
fn linux_capability_golden_bytes_digest_and_matrix() {
    let fixture = linux_fixtures();
    let runtime = LinuxBubblewrapRuntimeDescriptor::parse(fixture["runtime"].clone())
        .expect("valid Bubblewrap runtime descriptor");
    let caps = linux_bubblewrap_execution_capabilities(&runtime).unwrap();
    let expected = ExecutionCapabilities::parse(fixture["capability"]["capabilities"].clone())
        .expect("valid Linux capabilities");
    assert_eq!(caps, expected);
    assert_eq!(
        caps.canonical_json().unwrap(),
        fixture["capability"]["canonical"].as_str().unwrap()
    );
    assert_eq!(
        caps.digest().unwrap(),
        fixture["capability"]["sha256"].as_str().unwrap()
    );

    let policy = ExecutionPolicy::parse(fixture["policy"].clone()).unwrap();
    for filesystem in [
        FilesystemPolicy::Unrestricted,
        FilesystemPolicy::ReadOnly,
        FilesystemPolicy::WorkspaceWrite,
    ] {
        for network in [NetworkPolicy::Inherit, NetworkPolicy::Deny] {
            let candidate = ExecutionPolicy {
                filesystem,
                network,
                ..policy.clone()
            };
            assert!(
                evaluate_execution_policy(&candidate, &caps)
                    .unwrap()
                    .allowed
            );
            let admission = create_execution_admission_snapshot(&candidate, &caps).unwrap();
            let encoded = serde_json::to_string(&admission).unwrap();
            assert!(!encoded.contains(r#""applied""#));
            admission.validate().unwrap();
        }
    }
    let unsupported = ExecutionPolicy {
        process_isolation: ProcessIsolationPolicy::Required,
        ..policy
    };
    assert_eq!(
        create_execution_admission_snapshot(&unsupported, &caps).unwrap_err(),
        ExecutionPolicyError::ExecutionPolicyUnavailable
    );
}

#[test]
fn shared_linux_snapshot_cases_match_typescript_validation() {
    for case in linux_fixtures()["snapshot_cases"].as_array().unwrap() {
        let parsed = ExecutionSecuritySnapshot::parse(case["input"].clone());
        if case["valid"].as_bool().unwrap() {
            assert_eq!(
                serde_json::to_value(parsed.unwrap()).unwrap(),
                case["input"],
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(
                parsed.expect_err(case["name"].as_str().unwrap()),
                ExecutionPolicyError::ExecutionSecurityCorrupt
            );
        }
    }
}

#[test]
fn linux_runtime_descriptor_is_strict_bounded_and_versioned() {
    let base = linux_fixtures()["runtime"].clone();
    for (field, value) in [
        ("schema_version", json!(2)),
        ("mechanism", json!("macos_seatbelt")),
        ("canonical_path", json!("usr/bin/bwrap")),
        ("canonical_path", json!(format!("/{}", "a".repeat(4096)))),
        ("device", json!("00")),
        ("device", json!("not-a-number")),
        ("device", json!("18446744073709551616")),
        ("inode", json!(123456789)),
        ("size", json!(9_007_199_254_740_992_u64)),
        ("mtime_ns", json!("-1")),
        ("mtime_ns", json!("18446744073709551616")),
        ("sha256", json!("A".repeat(64))),
        ("version", json!("bubblewrap\n0.11.0")),
        ("version", json!("bubblewrap\u{0085}0.11.0")),
        ("version", json!("")),
        ("probe_revision", json!(2)),
        ("secret", json!("fixture-secret-marker")),
    ] {
        let mut input = base.clone();
        input[field] = value;
        assert_eq!(
            LinuxBubblewrapRuntimeDescriptor::parse(input).unwrap_err(),
            ExecutionPolicyError::InvalidExecutionPolicy
        );
    }
}

#[test]
fn macos_contract_rejects_future_platform_mechanism_and_order_changes() {
    let base = macos_fixtures()["capability"]["capabilities"].clone();
    let mutations = [
        ("schema_version", json!(3)),
        ("platform", json!("linux")),
        (
            "filesystem",
            json!({
                "supported":["unrestricted","read_only","workspace_write"],
                "mechanism":"none"
            }),
        ),
        (
            "network",
            json!({"supported":["deny","inherit"],"mechanism":"macos_seatbelt"}),
        ),
        ("secret", json!("fixture-secret-marker")),
    ];
    for (field, value) in mutations {
        let mut input = base.clone();
        input[field] = value;
        assert_eq!(
            ExecutionCapabilities::parse(input).unwrap_err(),
            ExecutionPolicyError::InvalidExecutionPolicy
        );
    }
}

#[test]
fn portable_path_cases_and_utf8_bounds() {
    for case in fixtures()["path_cases"].as_array().unwrap() {
        assert_eq!(
            is_execution_workspace_path(case["path"].as_str().unwrap()),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["path"]
        );
    }
    assert!(is_execution_workspace_path(&format!(
        "/{}",
        "a".repeat(4095)
    )));
    assert!(!is_execution_workspace_path(&format!(
        "/{}",
        "a".repeat(4096)
    )));
    assert!(is_execution_workspace_path(&format!(
        "/{}",
        "中".repeat(1365)
    )));
    assert!(!is_execution_workspace_path(&format!(
        "/{}",
        "中".repeat(1366)
    )));
    // Rust strings cannot contain the unpaired surrogates rejected by TypeScript.
    assert!(serde_json::from_str::<Value>(r#""/\ud800""#).is_err());
    assert!(serde_json::from_str::<Value>(r#""/\udc00""#).is_err());
}

#[test]
fn invalid_and_missing_policy_fields_fail_safely() {
    for case in fixtures()["invalid_policy_cases"].as_array().unwrap() {
        let error = ExecutionPolicy::parse(case["input"].clone()).unwrap_err();
        assert_eq!(
            error,
            ExecutionPolicyError::InvalidExecutionPolicy,
            "{}",
            case["name"]
        );
        assert!(!error.to_string().contains("fixture-secret-marker"));
        assert!(error.to_string().len() < 256);
    }
    let input = serde_json::to_value(base()).unwrap();
    for key in input.as_object().unwrap().keys() {
        let mut missing = input.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert_eq!(
            ExecutionPolicy::parse(missing).unwrap_err(),
            ExecutionPolicyError::InvalidExecutionPolicy
        );
    }
}

#[test]
fn profile_resolution_and_config_priority() {
    assert_eq!(
        resolve_execution_policy("/workspace", None, Some("unconfined")).unwrap(),
        base()
    );
    let read_only = resolve_execution_policy("/workspace", None, Some("read-only")).unwrap();
    assert_eq!(read_only.filesystem, FilesystemPolicy::ReadOnly);
    assert_eq!(read_only.network, NetworkPolicy::Deny);
    let workspace_write =
        resolve_execution_policy("/workspace", None, Some("workspace-write")).unwrap();
    assert_eq!(workspace_write.filesystem, FilesystemPolicy::WorkspaceWrite);
    assert_eq!(workspace_write.network, NetworkPolicy::Deny);
    let config = ExecutionPolicyConfig {
        filesystem: FilesystemPolicy::ReadOnly,
        network: NetworkPolicy::Inherit,
        process_isolation: ProcessIsolationPolicy::Required,
        environment: EnvironmentPolicy::Explicit,
    };
    let resolved = resolve_execution_policy(
        "/workspace",
        Some(config.clone()),
        Some("invalid-ignored-by-explicit-option"),
    )
    .unwrap();
    assert_eq!(resolved.filesystem, config.filesystem);
    assert_eq!(resolved.process_isolation, config.process_isolation);
    for invalid in [
        "",
        "READ-ONLY",
        "read_only",
        "unconfined ",
        "fixture-secret-marker",
    ] {
        assert_eq!(
            resolve_execution_policy("/workspace", None, Some(invalid)).unwrap_err(),
            ExecutionPolicyError::InvalidExecutionPolicy
        );
    }
    assert!(
        serde_json::from_value::<ExecutionPolicyConfig>(json!({"filesystem":"unrestricted"}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<ExecutionPolicyConfig>(serde_json::to_value(base()).unwrap())
            .is_err()
    );
}

#[test]
fn all_c1_backend_requirement_combinations_fail_closed() {
    for case in fixtures()["capability_cases"].as_array().unwrap() {
        let caps = ExecutionCapabilities::parse(case["capabilities"].clone()).unwrap();
        for filesystem in [
            FilesystemPolicy::Unrestricted,
            FilesystemPolicy::ReadOnly,
            FilesystemPolicy::WorkspaceWrite,
        ] {
            for network in [NetworkPolicy::Inherit, NetworkPolicy::Deny] {
                for process_isolation in [
                    ProcessIsolationPolicy::Inherit,
                    ProcessIsolationPolicy::Required,
                ] {
                    let policy = ExecutionPolicy {
                        filesystem,
                        network,
                        process_isolation,
                        ..base()
                    };
                    let evaluation = evaluate_execution_policy(&policy, &caps).unwrap();
                    let mut expected = vec![];
                    if filesystem != FilesystemPolicy::Unrestricted {
                        expected.push(ExecutionPolicyDimension::Filesystem);
                    }
                    if network != NetworkPolicy::Inherit {
                        expected.push(ExecutionPolicyDimension::Network);
                    }
                    if process_isolation != ProcessIsolationPolicy::Inherit {
                        expected.push(ExecutionPolicyDimension::ProcessIsolation);
                    }
                    assert_eq!(evaluation.allowed, expected.is_empty());
                    assert_eq!(
                        evaluation.unmet,
                        expected
                            .iter()
                            .map(|dimension| UnmetRequirement {
                                dimension: *dimension,
                                reason: UnmetReason::NotImplemented
                            })
                            .collect::<Vec<_>>()
                    );
                    let snapshot = create_execution_admission_snapshot(&policy, &caps);
                    if expected.is_empty() {
                        let encoded = serde_json::to_string(&snapshot.unwrap()).unwrap();
                        assert!(!encoded.contains(r#""applied""#));
                        assert!(encoded.contains(r#""not_applied""#));
                    } else {
                        assert_eq!(
                            snapshot.unwrap_err(),
                            ExecutionPolicyError::ExecutionPolicyUnavailable
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn fabricated_capabilities_are_not_support() {
    let base_caps =
        serde_json::to_value(c1_execution_capabilities(ExecutionBackend::NativePosix)).unwrap();
    for (field, value) in [
        ("schema_version", json!(2)),
        ("secret", json!("fixture-secret-marker")),
        (
            "filesystem",
            json!({"supported":["unrestricted","read_only"],"mechanism":"none"}),
        ),
        ("network", json!({"supported":["deny"],"mechanism":"none"})),
        (
            "process_isolation",
            json!({"supported":["required"],"mechanism":"posix_process_group"}),
        ),
        (
            "environment",
            json!({"supported":["explicit"],"mechanism":"explicit_environment","layer":"os"}),
        ),
        (
            "supervision",
            json!({"mechanism":"posix_process_group","layer":"os","durable":false}),
        ),
        ("backend", json!("native_windows")),
    ] {
        let mut input = base_caps.clone();
        input[field] = value;
        assert_eq!(
            ExecutionCapabilities::parse(input).unwrap_err(),
            ExecutionPolicyError::InvalidExecutionPolicy
        );
    }
}

#[test]
fn shared_snapshot_cases_preserve_evidence_without_inference() {
    for case in fixtures()["snapshot_cases"].as_array().unwrap() {
        let parsed = ExecutionSecuritySnapshot::parse(case["input"].clone());
        if case["valid"].as_bool().unwrap() {
            assert_eq!(
                serde_json::to_value(parsed.unwrap()).unwrap(),
                case["input"],
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(
                parsed.expect_err(case["name"].as_str().unwrap()),
                ExecutionPolicyError::ExecutionSecurityCorrupt
            );
        }
    }
}

#[test]
fn snapshots_bound_escaped_json_and_never_fill_missing_evidence() {
    let caps = c1_execution_capabilities(ExecutionBackend::NativePosix);
    let huge = ExecutionPolicy {
        workspace_root: format!("/{}", "\u{0001}".repeat(3000)),
        ..base()
    };
    huge.validate().unwrap();
    assert_eq!(
        create_execution_admission_snapshot(&huge, &caps).unwrap_err(),
        ExecutionPolicyError::ExecutionSecurityCorrupt
    );
    let snapshot =
        serde_json::to_value(create_execution_admission_snapshot(&base(), &caps).unwrap()).unwrap();
    for key in snapshot.as_object().unwrap().keys() {
        let mut missing = snapshot.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert_eq!(
            ExecutionSecuritySnapshot::parse(missing).unwrap_err(),
            ExecutionPolicyError::ExecutionSecurityCorrupt
        );
    }
}

#[test]
fn all_empty_evidence_variants_reject_unknown_fields() {
    let caps = c1_execution_capabilities(ExecutionBackend::NativePosix);
    let snapshot =
        serde_json::to_value(create_execution_admission_snapshot(&base(), &caps).unwrap()).unwrap();
    for status in ["not_requested", "not_applied", "unknown"] {
        let field = if status == "not_requested" {
            "network"
        } else {
            "environment"
        };
        let mut input = snapshot.clone();
        input[field] = json!({"status": status});
        assert!(ExecutionSecuritySnapshot::parse(input.clone()).is_ok());
        input[field]["secret"] = json!("fixture-secret-marker");
        assert_eq!(
            ExecutionSecuritySnapshot::parse(input).unwrap_err(),
            ExecutionPolicyError::ExecutionSecurityCorrupt
        );
    }
}
