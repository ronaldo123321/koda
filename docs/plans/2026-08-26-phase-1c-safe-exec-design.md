# Koda Phase 1C: Approval-Gated Structured Commands

- Status: Implemented
- Date: 2026-08-26
- Depends on: Phase 1B safe structured patch
- Scope: one foreground process per tool call, structured arguments, explicit approval, bounded output, timeout, and cancellation

## 1. Outcome

Phase 1C completes the first useful local coding loop: Koda can inspect files, propose an approved edit, run a validation command, observe the result, and continue reasoning. It adds one provider-neutral function tool:

```ts
interface ExecCommandInput {
  argv: string[];
  cwd?: string;
  timeout_ms?: number;
}
```

`argv` contains the executable and its arguments as separate strings. Koda passes it directly to Node's process API with `shell: false`; it never joins the array into a shell command. `cwd` is workspace-relative and defaults to the workspace root. `timeout_ms` is bounded and defaults to 30 seconds.

Every command is a side effect because even apparently read-only programs can execute repository-controlled scripts. In `on-request` mode the runtime therefore previews and asks about every call. In `never` mode all process execution is denied without prompting.

## 2. Alternatives and decision

Three approaches were considered:

1. **Structured argv, recommended.** It avoids shell parsing and preserves exact approval semantics while supporting normal build, test, formatter, and Git commands.
2. **A shell command string.** It is convenient for pipes and redirection, but quoting is platform-dependent and a preview can hide additional shell behavior. It is deferred as a high-risk escape hatch.
3. **A fixed task allowlist.** It is the smallest attack surface, but it would make Koda unusable across repositories whose validation commands are not known in advance.

Phase 1C chooses structured argv and explicit approval. It does not claim that an approved executable is safe: a package script or binary may read or modify anything available to the current user. Strong filesystem, process, and network isolation remains Phase 4 work.

## 3. Architecture and data flow

```text
OpenAI function call
  -> ToolRegistry validates argv, cwd, and timeout
  -> WorkspaceCommandRunner prepares canonical cwd and exact preview
  -> EffectToolPolicy returns ask or deny
  -> ApprovalBroker asks the user
  -> prepared invocation revalidates cwd
  -> Node spawn(argv[0], argv.slice(1), { shell: false })
  -> bounded stdout/stderr and process metadata
  -> normalized tool result returns to the model
```

`agent-core` continues to own effect policy and approval ordering. `runtime-node` owns path validation, environment filtering, process lifecycle, timeout, cancellation, and output collection. `apps/cli` composes the tool and renders the existing approval interaction. The provider sees only the JSON function schema.

Preparation performs no process execution. The prepared object records the canonical workspace and working directory. After approval, execution revalidates the directory before spawning so a removed or replaced directory fails instead of executing from an unexpected location.

## 4. Input and workspace rules

`argv` must contain between 1 and 64 entries. The executable must be non-empty. Each entry is bounded to 4 KiB and may not contain a null byte. Total argument data is bounded to 32 KiB. Direct invocations of common shell interpreters such as `sh`, `bash`, `zsh`, `cmd`, and PowerShell are rejected. No shell metacharacter filtering is otherwise needed because there is no shell parser; strings such as `&&` are passed as ordinary arguments.

`cwd` must be a non-empty relative path without a null byte. It must resolve to an existing real directory inside the canonical workspace root. Lexical traversal outside the root and symlinked path components are rejected. Absolute paths are rejected. The default directory is represented as `.` in previews and results.

Timeouts are whole milliseconds between 100 and 120,000. The default is 30,000. Commands receive no stdin and run in the foreground. PTY sessions, background process management, daemon supervision, and interactive prompts are not supported.

## 5. Environment and process lifecycle

The child receives a small environment allowlist needed by ordinary local tools: path resolution, home-directory discovery, locale, terminal color preferences, temporary directories, and Windows executable discovery. Provider credentials and arbitrary caller variables are not forwarded. In particular, `OPENAI_API_KEY`, tokens, cloud credentials, and repository-specific secrets are absent unless a future explicit policy introduces them.

On POSIX, the runner creates a process group so timeout or cancellation can signal the command and its direct descendants. It first sends `SIGTERM`, waits a short grace period, and then sends `SIGKILL` if necessary. Windows receives a best-effort child termination in this phase. Robust cross-platform tree ownership remains part of Phase 2 reliability work.

Cancellation waits for process termination and then propagates the abort so the turn ends with the existing cancellation status. Timeout is returned as an observed command result with `timed_out: true`, allowing the model to explain or choose a smaller command.

## 6. Output and errors

Stdout and stderr are drained independently to avoid deadlocks. Koda retains at most 64 KiB from each stream while continuing to count all bytes. The result contains:

```ts
interface ExecCommandResult {
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
}
```

A nonzero exit code is a successful tool observation, not a runtime exception. Expected preparation failures use stable tool error codes such as `INVALID_COMMAND`, `INVALID_COMMAND_CWD`, and `COMMAND_CWD_CHANGED`. Spawn failures use `COMMAND_NOT_FOUND` or `COMMAND_START_FAILED`. Policy denial and approval rejection keep the Phase 1B codes.

Output is decoded as UTF-8 with replacement for malformed bytes. This phase does not persist oversized output as an artifact; Phase 2 will add artifact storage and prompt-aware truncation.

## 7. User experience

For a proposed command, stderr shows an unambiguous JSON-like argv preview rather than reconstructed shell syntax:

```text
Run pnpm
Run a foreground command in .

cwd: .
timeout: 30000 ms
argv: ["pnpm","test"]

Approve this action? [y/N]
```

Only `y` or `yes` approves, matching patch approval. The model is instructed to prefer focused validation, avoid interactive commands, and treat repository scripts as potentially side-effecting. Rejection is a recoverable tool result and does not start a process.

## 8. Testing and acceptance criteria

Offline tests cover successful stdout/stderr capture, nonzero exits, working-directory enforcement, environment filtering, output truncation, timeout, cancellation, spawn failure, policy denial, approval rejection, and CLI tool exposure. Tests also assert that no process starts during preparation or before approval.

Phase 1C is complete when:

- `pnpm format:check`, `pnpm typecheck`, and `pnpm test` pass without credentials.
- OpenAI receives the strict `exec_command` function schema.
- Default policy asks once before every process execution.
- `never` mode starts no process.
- Koda always spawns with `shell: false` and rejects direct shell interpreters.
- Working directories cannot escape the workspace through absolute paths, traversal, or symlinks.
- Timeout and cancellation terminate the observed child before returning.
- Captured output is bounded while byte counts remain available.

## 9. Deferred-work disposition

- Shell strings, pipelines, redirection, and command substitution: Phase 4, subject to sandbox review.
- PTY and interactive terminal sessions: Phase 3.
- Background services and long-running process sessions: Phase 3.
- Command approval caching or trusted-prefix rules: Phase 3.
- Artifact storage for large output: Phase 2.
- Strong filesystem and network sandboxing: Phase 4.
- Rust execution sidecar: Phase 4.
- Automatic Git rollback and multi-file mutation recovery: Phase 3. **Moved after Phase 2 adopted conservative uncertain-side-effect records without automatic replay.**
- Automatic commits: Phase 3 product workflow.
