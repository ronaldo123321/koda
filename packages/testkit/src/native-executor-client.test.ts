import { ToolRegistry, type ToolOperationalEvent } from "@koda/agent-core";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import {
  ArtifactStore,
  InteractiveProcessService,
  NativeExecutorClient,
  type NativePtyAttachment,
  WorkspaceCommandRunner,
  registerExecTerminalTool,
  resolveExecutionPolicy,
  type NativeJobSnapshot,
  type NativeSecretLeaseInput,
} from "@koda/runtime-node";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeNative = describe.runIf(process.platform !== "win32");

describeNative("NativeExecutorClient", () => {
  let root: string;
  let client: NativeExecutorClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "koda-native-executor-"));
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
  });

  afterAll(async () => {
    await client.closeOwnedSupervisorForTests();
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 100),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("negotiates explicit POSIX capabilities", async () => {
    await expect(client.hello()).resolves.toMatchObject({
      protocol_version: 5,
      platform: process.platform === "darwin" ? "macos" : "linux",
      capabilities: {
        process_group: true,
        job_object: false,
        pty: true,
        reattach: true,
        durable_restart_recovery: true,
      },
    });
  });

  it("injects file secrets once, redacts Pipe output before persistence, and cleans up", async () => {
    const hello = await client.hello();
    if (![2, 3].includes(hello.execution_security.schema_version)) return;
    const workspace = await mkdtemp(join(root, "secret-workspace-"));
    const value = Buffer.from("c3c-native-secret-value", "utf8");
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');const v=fs.readFileSync(process.env.APP_TOKEN_FILE);process.stdout.write(v);process.stderr.write(v)",
      ],
      cwd: workspace,
      policy: await protectedPolicyFor(workspace),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      secretLease: nativeSecretLease(value),
    });
    expect(value).toEqual(Buffer.alloc(value.byteLength));
    const terminal = await waitTerminal(client, started.job_id);
    const [stdout, stderr] = await Promise.all([
      client.readOutput(terminal.job_id, "stdout", 0),
      client.readOutput(terminal.job_id, "stderr", 0),
    ]);

    expect(terminal.failure).toBeNull();
    expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
    expect(stdout.data.toString("utf8")).toBe("[REDACTED]");
    expect(stderr.data.toString("utf8")).toBe("[REDACTED]");
    expect(terminal.secrets).toMatchObject({
      lifecycle: "destroyed",
      cleanup: "completed",
      redactions: { stdout: 1, stderr: 1, pty: 0 },
    });
    expect(JSON.stringify(terminal)).not.toContain("c3c-native-secret-value");
  });

  it("redacts PTY output before segments and live attachment reads", async () => {
    const hello = await client.hello();
    if (![2, 3].includes(hello.execution_security.schema_version)) return;
    const workspace = await mkdtemp(join(root, "secret-pty-workspace-"));
    const value = Buffer.from("c3c-pty-secret-value", "utf8");
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.env.APP_TOKEN_FILE))",
      ],
      cwd: workspace,
      policy: await protectedPolicyFor(workspace),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 24,
      cols: 80,
      secretLease: nativeSecretLease(value),
    });
    const attachment = await client.openAttachment(started.job_id);
    const terminal = await waitTerminal(client, started.job_id);
    const output = await readPtyToCompletion(attachment);

    expect(terminal.failure).toBeNull();
    expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
    expect(output).toBe("[REDACTED]");
    expect(terminal.secrets).toMatchObject({
      lifecycle: "destroyed",
      cleanup: "completed",
      redactions: { stdout: 0, stderr: 0, pty: 1 },
    });
  });

  it("keeps secret files through execution and removes them after cancellation", async () => {
    const hello = await client.hello();
    if (![2, 3].includes(hello.execution_security.schema_version)) return;
    const workspace = await mkdtemp(join(root, "secret-cancel-workspace-"));
    const value = Buffer.from("c3c-cancel-secret-value", "utf8");
    const started = await client.start({
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      policy: await protectedPolicyFor(workspace),
      environment: { PATH: process.env.PATH },
      timeoutMs: 10_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      secretLease: nativeSecretLease(value),
    });
    await client.terminate(started.job_id, "cancellation");
    const terminal = await waitTerminal(client, started.job_id);

    expect(terminal).toMatchObject({
      state: "exited",
      secrets: {
        lifecycle: "destroyed",
        cleanup: "completed",
      },
    });
  });

  it("rejects an expired native lease with a fixed value-free error", async () => {
    const hello = await client.hello();
    if (![2, 3].includes(hello.execution_security.schema_version)) return;
    const workspace = await mkdtemp(join(root, "secret-expired-workspace-"));
    const value = Buffer.from("c3c-expired-secret-value", "utf8");
    const lease = nativeSecretLease(value);
    lease.evidence.expires_at_ms = Date.now() - 1;

    await expect(
      client.start({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: workspace,
        policy: await protectedPolicyFor(workspace),
        environment: { PATH: process.env.PATH },
        timeoutMs: 3_000,
        outputLimitBytes: 65_536,
        terminationGraceMs: 25,
        terminationConfirmationMs: 1_000,
        secretLease: lease,
      }),
    ).rejects.toMatchObject({
      code: "SECRET_LEASE_EXPIRED",
      message: "The secret lease expired before execution.",
    });
    expect(value).toEqual(Buffer.alloc(value.byteLength));
  });

  it("runs a real PTY with configured dimensions and fenced input", async () => {
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "console.log(JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,rows:process.stdout.rows,cols:process.stdout.columns}));",
          "process.stdin.once('data',(data)=>{console.log('INPUT:'+JSON.stringify(data));setTimeout(()=>process.exit(0),20)});",
        ].join(""),
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 24,
      cols: 80,
    });
    const attachment = await client.openAttachment(started.job_id);
    const lease = await attachment.acquireInput();
    await attachment.write("hello\n");
    const terminal = await waitTerminal(client, started.job_id);
    const output = await readPtyToCompletion(attachment);

    expect(started).toMatchObject({
      io_mode: "pty",
      lifecycle: "foreground",
    });
    expect(lease.fence).toBeGreaterThan(0);
    expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
    expect(output).toContain(
      '{"stdin":true,"stdout":true,"rows":24,"cols":80}',
    );
    expect(output).toContain('INPUT:"hello\\n"');
  });

  it("starts an approved exec_terminal handle and exposes only app process sessions", async () => {
    const service = await InteractiveProcessService.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
      leaseRenewalMs: 100,
    });
    try {
      const runner = await WorkspaceCommandRunner.open(root, {
        nativeExecutor: service.nativeExecutor,
        interactiveProcessService: service,
        terminationGraceMs: 25,
      });
      const registry = new ToolRegistry();
      registerExecTerminalTool(registry, runner);
      const prepared = await registry.prepare(
        {
          callId: toolCallIdSchema.parse("terminal-tool-call"),
          name: "exec_terminal",
          arguments: {
            argv: [
              process.execPath,
              "-e",
              "console.log('ready');process.stdin.once('data',(data)=>{console.log('echo:'+data.toString().trim());process.exit(0)})",
            ],
            timeout_ms: 3_000,
            lifecycle: "background",
            display_name: "Tool terminal",
          },
        },
        {
          threadId: threadIdSchema.parse("terminal-tool-thread"),
          turnId: turnIdSchema.parse("terminal-tool-turn"),
          signal: new AbortController().signal,
        },
      );
      if (prepared.status !== "ready") {
        throw new Error("exec_terminal did not prepare successfully.");
      }
      expect(prepared.invocation.approval).toMatchObject({
        title: 'Start terminal "Tool terminal"',
        details: expect.stringContaining("OS sandbox: none"),
      });
      expect(prepared.invocation.approval?.grantCandidate).toBeUndefined();
      const execution = await prepared.invocation.execute();
      expect(execution.status).toBe("success");
      if (execution.status !== "success") {
        throw new Error("exec_terminal did not return a durable handle.");
      }
      expect(execution.output).toMatchObject({
        security: {
          kind: "policy",
          stage: "launch_setup",
          backend: "native_posix",
        },
      });
      const jobId = (execution.output as { job_id?: string }).job_id;
      if (jobId === undefined) throw new Error("Missing exec_terminal job ID.");

      const listed = await service.listProcesses({ workspace: root });
      const canonicalRoot = await realpath(root);
      expect(listed.processes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jobId,
            displayName: "Tool terminal",
            cwd: canonicalRoot,
            security: expect.objectContaining({
              kind: "policy",
              stage: "launch_setup",
              backend: "native_posix",
            }),
          }),
        ]),
      );
      expect(JSON.stringify(listed)).not.toContain("process.stdin.once");
      const attached = await service.attach({
        workspace: root,
        jobId,
        rows: 30,
        cols: 100,
      });
      expect(attached).toMatchObject({
        inputState: "owned",
        process: {
          security: {
            kind: "policy",
            stage: "launch_setup",
            backend: "native_posix",
          },
        },
      });
      await service.writeInput(
        attached.processSessionId,
        Buffer.from("hello\n"),
      );
      let output = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const chunk = await service.read(attached.processSessionId);
        if (chunk.status === "ok") {
          output += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
          if (output.includes("echo:hello")) break;
        }
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 10),
        );
      }
      expect(output).toContain("ready");
      expect(output).toContain("echo:hello");
      await service.detach(attached.processSessionId);
    } finally {
      await service.close();
    }
  });

  it("allows many PTY readers but only one fenced resize and input owner", async () => {
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        [
          "console.log('READY:'+process.stdout.rows+'x'+process.stdout.columns);",
          "process.on('SIGWINCH',()=>console.log('RESIZE:'+process.stdout.rows+'x'+process.stdout.columns));",
          "setInterval(()=>{},1000);",
        ].join(""),
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 20,
      cols: 70,
    });
    const first = await client.openAttachment(started.job_id);
    const second = await client.openAttachment(started.job_id);
    const firstLease = await first.acquireInput();

    await expect(second.acquireInput()).rejects.toMatchObject({
      code: "INPUT_LEASE_HELD",
    });
    await expect(readPtyUntil(first, "READY:20x70")).resolves.toContain(
      "READY:20x70",
    );
    await expect(readPtyUntil(second, "READY:20x70")).resolves.toContain(
      "READY:20x70",
    );
    await first.resize(40, 100);
    await expect(readPtyUntil(first, "RESIZE:40x100")).resolves.toContain(
      "RESIZE:40x100",
    );
    await expect(readPtyUntil(second, "RESIZE:40x100")).resolves.toContain(
      "RESIZE:40x100",
    );

    await first.close();
    const secondLease = await second.acquireInput();
    expect(secondLease.fence).toBeGreaterThan(firstLease.fence);
    await expect(
      client.writeInput(
        second.credentials,
        { ...secondLease, fence: firstLease.fence },
        Buffer.from("stale\n"),
      ),
    ).rejects.toMatchObject({ code: "STALE_INPUT_FENCE" });
    await client.terminate(started.job_id, "cancellation");
    await waitTerminal(client, started.job_id);
    await second.close();
  });

  it("keeps a detached background PTY alive across Supervisor restart", async () => {
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('before-');setTimeout(()=>process.stdout.write('after'),400)",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 24,
      cols: 80,
      lifecycle: "background",
    });
    const original = await client.openAttachment(started.job_id);
    await original.close();

    await client.closeOwnedSupervisorForTests();
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
    const reattached = await client.openAttachment(started.job_id);
    const terminal = await waitTerminal(client, started.job_id);
    const output = await readPtyToCompletion(reattached);

    expect(terminal).toMatchObject({
      state: "exited",
      exit_code: 0,
      lifecycle: "background",
    });
    expect(output).toContain("before-after");
  });

  it("preserves an existing PTY input lease across Supervisor restart", async () => {
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        "process.stdin.setEncoding('utf8');console.log('ready');process.stdin.once('data',(data)=>{console.log('got:'+data.trim());process.exit(0)})",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 24,
      cols: 80,
    });
    const attachment = await client.openAttachment(started.job_id);
    const originalLease = await attachment.acquireInput();
    await readPtyUntil(attachment, "ready");

    await client.closeOwnedSupervisorForTests();
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
    const renewed = await attachment.renewInput();
    await attachment.write("continued\n");
    const terminal = await waitTerminal(client, started.job_id);
    const output = await readPtyToCompletion(attachment);

    expect(renewed.fence).toBe(originalLease.fence);
    expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
    expect(output).toContain("got:continued");
  });

  it("reports an expired absolute cursor after PTY tail rotation", async () => {
    const started = await client.startPty({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(70000))"],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 3_000,
      outputLimitBytes: 65_536,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      rows: 24,
      cols: 80,
    });
    await waitTerminal(client, started.job_id);
    const attachment = await client.openAttachment(started.job_id);
    const expired = await attachment.read();

    expect(expired).toMatchObject({
      status: "cursor_expired",
      cursor: 0,
      earliest_cursor: 65_536,
      latest_cursor: 70_000,
      complete: true,
    });
    const retained = await attachment.read();
    expect(retained).toMatchObject({ status: "ok", complete: true });
    if (retained.status !== "ok") {
      throw new Error("Expected retained PTY output after cursor recovery.");
    }
    expect(retained.data.byteLength).toBe(70_000 - 65_536);
  });

  it("observes the same job after a Node client reconnect", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        "setTimeout(() => process.stdout.write('reconnected'), 75)",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });
    const reconnected = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
    const terminal = await waitTerminal(reconnected, started.job_id);
    const output = await reconnected.readOutput(terminal.job_id, "stdout", 0);

    expect(terminal).toMatchObject({
      state: "exited",
      exit_code: 0,
      stdout_bytes: 11,
      stdout_truncated: false,
    });
    expect(output.data.toString("utf8")).toBe("reconnected");
    expect(output.complete).toBe(true);
  });

  it("keeps a running job alive across a Supervisor restart", async () => {
    const requestId = `restart-${randomUUID()}`;
    const input = {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('before-'); setTimeout(() => process.stdout.write('after'), 400)",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      requestId,
    };
    const started = await client.start(input);

    await client.closeOwnedSupervisorForTests();
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });

    const duplicate = await client.start(input);
    const terminal = await waitTerminal(client, started.job_id);
    const output = await client.readOutput(terminal.job_id, "stdout", 0);

    expect(duplicate.job_id).toBe(started.job_id);
    expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
    expect(output.data.toString("utf8")).toBe("before-after");
  });

  it("preserves timeout and cancellation ownership after a Supervisor restart", async () => {
    const timeoutJob = await client.start({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 300,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });
    const cancellationJob = await client.start({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });

    await client.closeOwnedSupervisorForTests();
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
    await client.terminate(cancellationJob.job_id, "cancellation");
    const [timedOut, cancelled] = await Promise.all([
      waitTerminal(client, timeoutJob.job_id),
      waitTerminal(client, cancellationJob.job_id),
    ]);

    expect(timedOut).toMatchObject({
      state: "exited",
      timed_out: true,
      termination: { reason: "timeout", outcome: "terminated" },
    });
    expect(cancelled).toMatchObject({
      state: "exited",
      timed_out: false,
      termination: { reason: "cancellation", outcome: "terminated" },
    });
  });

  it("lists durable jobs with bounded cursor pagination", async () => {
    const first = await client.list({ limit: 1 });

    expect(first.jobs).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    if (first.next_cursor === null) {
      throw new Error("Expected a second durable-job page.");
    }
    const second = await client.list({
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(second.jobs.map((job) => job.job_id)).not.toContain(
      first.jobs[0]?.job_id,
    );
  });

  it("resumes an accepted job after the Supervisor dies before Worker launch", async () => {
    const faultRoot = await mkdtemp(join(tmpdir(), "koda-accepted-fault-"));
    const faultClient = await openFaultClient(faultRoot, "after_accepted");
    const requestId = `accepted-${randomUUID()}`;
    const input = {
      argv: [process.execPath, "-e", "process.stdout.write('resumed-once')"],
      cwd: faultRoot,
      policy: await policyFor(faultRoot),
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      requestId,
    };
    try {
      await expect(faultClient.start(input)).rejects.toMatchObject({
        code: "NATIVE_EXECUTOR_UNAVAILABLE",
      });
      const recovered = await NativeExecutorClient.open({
        binaryPath: resolve("target/debug/koda-exec"),
        stateDirectory: join(faultRoot, "state"),
        socketPath: join(faultRoot, "exec.sock"),
      });
      try {
        const resumed = await recovered.start(input);
        const terminal = await waitTerminal(recovered, resumed.job_id);
        const output = await recovered.readOutput(terminal.job_id, "stdout", 0);

        expect(terminal).toMatchObject({ state: "exited", exit_code: 0 });
        expect(output.data.toString("utf8")).toBe("resumed-once");
      } finally {
        await recovered.closeOwnedSupervisorForTests();
      }
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates exact starts and rejects conflicting request reuse", async () => {
    const requestId = `request-${randomUUID()}`;
    const input = {
      argv: [process.execPath, "-e", "process.stdout.write('once')"],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      requestId,
    };
    const first = await client.start(input);
    const duplicate = await client.start(input);

    expect(duplicate.job_id).toBe(first.job_id);
    await expect(
      client.start({
        ...input,
        argv: [process.execPath, "-e", "process.stdout.write('twice')"],
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await waitTerminal(client, first.job_id);
  });

  it("owns timeout escalation and reports its evidence", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: root,
      policy: await policyFor(root),
      environment: { PATH: process.env.PATH },
      timeoutMs: 100,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });
    const terminal = await waitTerminal(client, started.job_id);

    expect(terminal).toMatchObject({
      state: "exited",
      timed_out: true,
      termination: {
        reason: "timeout",
        outcome: "terminated",
        attempts: [{ attempt: "graceful" }, { attempt: "force" }],
      },
    });
  });

  it("reconciles a Worker crash after the command boundary without guessing success", async () => {
    const faultRoot = await mkdtemp(join(tmpdir(), "koda-worker-fault-"));
    const faultClient = await openFaultClient(faultRoot, "after_running");

    try {
      const started = await faultClient.start({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: faultRoot,
        policy: await policyFor(faultRoot),
        environment: { PATH: process.env.PATH },
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
        terminationGraceMs: 25,
        terminationConfirmationMs: 1_000,
      });
      const terminal = await waitTerminal(faultClient, started.job_id);

      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        termination: {
          reason: "orphan_cleanup",
          outcome: "uncertain",
        },
        failure: { code: "WORKER_LOST_AFTER_COMMAND_BOUNDARY" },
      });
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { recursive: true, force: true });
    }
  });

  it("never restarts a PTY command after its Worker crashes", async () => {
    const faultRoot = await mkdtemp(join(tmpdir(), "koda-pty-worker-fault-"));
    const faultClient = await openFaultClient(faultRoot, "after_running");

    try {
      const started = await faultClient.startPty({
        argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
        cwd: faultRoot,
        policy: await policyFor(faultRoot),
        environment: { PATH: process.env.PATH },
        timeoutMs: 2_000,
        outputLimitBytes: 65_536,
        terminationGraceMs: 25,
        terminationConfirmationMs: 1_000,
        rows: 24,
        cols: 80,
      });
      const terminal = await waitTerminal(faultClient, started.job_id);
      const attachment = await faultClient.openAttachment(started.job_id);
      const output = await attachment.read();

      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        io_mode: "pty",
        failure: { code: "WORKER_LOST_AFTER_COMMAND_BOUNDARY" },
      });
      expect(output).toMatchObject({ status: "ok", complete: true });
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { recursive: true, force: true });
    }
  });

  it("does not execute the approved command when a Worker dies before gate release", async () => {
    const faultRoot = await mkdtemp(join(tmpdir(), "koda-worker-gate-"));
    const marker = join(faultRoot, "command-executed");
    const faultClient = await openFaultClient(faultRoot, "after_command_spawn");
    try {
      const started = await faultClient.start({
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
        ],
        cwd: faultRoot,
        policy: await policyFor(faultRoot),
        environment: { PATH: process.env.PATH },
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
        terminationGraceMs: 25,
        terminationConfirmationMs: 1_000,
      });
      const terminal = await waitTerminal(faultClient, started.job_id);

      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        termination: {
          reason: "orphan_cleanup",
          outcome: "uncertain",
          attempts: [
            {
              attempt: "identity_check",
              mechanism: "command_identity_not_persisted",
            },
          ],
        },
      });
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 100),
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { recursive: true, force: true });
    }
  });

  it("preserves the WorkspaceCommandRunner result and lifecycle contract", async () => {
    const artifactStore = await ArtifactStore.open(join(root, "artifacts"));
    const runner = await WorkspaceCommandRunner.open(root, {
      nativeExecutor: client,
      artifactStore,
      maxOutputBytes: 8,
      terminationGraceMs: 25,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "process.stdout.write('123456789abcdef')"],
      timeoutMs: 2_000,
    });
    expect(command.preview).toContain("OS sandbox: none");
    expect(command.security).toMatchObject({
      kind: "policy",
      stage: "admission",
      backend: "native_posix",
    });
    const lifecycle: ToolOperationalEvent[] = [];
    const result = await command.execute(
      new AbortController().signal,
      async (event) => {
        lifecycle.push(event);
      },
    );

    expect(result).toMatchObject({
      exit_code: 0,
      stdout_bytes: 15,
      stdout_truncated: true,
      timed_out: false,
      stdout_artifact: { type: "artifact", bytes: 15 },
      security: {
        kind: "policy",
        stage: "launch_setup",
        backend: "native_posix",
      },
    });
    expect(lifecycle.map((event) => event.type)).toEqual([
      "process.started",
      "process.exited",
    ]);
    expect(lifecycle[0]).toMatchObject({
      type: "process.started",
      payload: {
        security: {
          kind: "policy",
          stage: "launch_setup",
          backend: "native_posix",
        },
      },
    });
    await expect(
      artifactStore.readRange(result.stdout_artifact?.id ?? "", 0, 65_536),
    ).resolves.toMatchObject({ content: "123456789abcdef" });
  });

  it("terminates native work when the Node abort signal fires", async () => {
    const runner = await WorkspaceCommandRunner.open(root, {
      nativeExecutor: client,
      terminationGraceMs: 25,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const lifecycle: ToolOperationalEvent[] = [];
    const execution = command.execute(controller.signal, async (event) => {
      lifecycle.push(event);
    });
    setTimeout(() => controller.abort("native cancellation"), 75);

    await expect(execution).rejects.toMatchObject({
      name: "AbortError",
      message: "native cancellation",
    });
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        type: "process.termination_completed",
        payload: expect.objectContaining({
          reason: "cancellation",
          outcome: "terminated",
        }),
      }),
    );
  });
});

async function policyFor(root: string) {
  return resolveExecutionPolicy({ workspaceRoot: await realpath(root) });
}

async function protectedPolicyFor(root: string) {
  return resolveExecutionPolicy({
    workspaceRoot: await realpath(root),
    environmentProfile: "read-only",
  });
}

function nativeSecretLease(value: Buffer): NativeSecretLeaseInput {
  let destroyed = false;
  return {
    evidence: {
      schema_version: 1,
      declaration_digest: "a".repeat(64),
      lease_id: "0123456789abcdef0123456789abcdef",
      aliases: ["api-token"],
      targets: [{ alias: "api-token", environment_variable: "APP_TOKEN_FILE" }],
      lifecycle: "resolved",
      expires_at_ms: Date.now() + 60_000,
      redactions: { stdout: 0, stderr: 0, pty: 0 },
      cleanup: "not_started",
    },
    values: [value],
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      value.fill(0);
    },
  };
}

async function waitTerminal(
  client: NativeExecutorClient,
  jobId: string,
): Promise<NativeJobSnapshot> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await client.get(jobId);
    if (
      snapshot.state === "exited" ||
      snapshot.state === "start_failed" ||
      snapshot.state === "termination_uncertain" ||
      snapshot.state === "quarantined"
    ) {
      return snapshot;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Native job '${jobId}' did not reach a terminal state.`);
}

async function readPtyToCompletion(
  attachment: NativePtyAttachment,
): Promise<string> {
  const chunks: Buffer[] = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await attachment.read();
    if (result.status === "cursor_expired") {
      continue;
    }
    chunks.push(result.data);
    if (result.complete) {
      return Buffer.concat(chunks).toString("utf8");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    `PTY attachment '${attachment.credentials.attachment_id}' did not complete.`,
  );
}

async function readPtyUntil(
  attachment: NativePtyAttachment,
  expected: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await attachment.read();
    if (result.status === "cursor_expired") {
      chunks.length = 0;
      continue;
    }
    chunks.push(result.data);
    const output = Buffer.concat(chunks).toString("utf8");
    if (output.includes(expected)) {
      return output;
    }
    if (result.complete) {
      break;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    `PTY attachment '${attachment.credentials.attachment_id}' did not emit '${expected}'.`,
  );
}

async function openFaultClient(
  root: string,
  faultPoint: string,
): Promise<NativeExecutorClient> {
  const previousFaultPoint = process.env.KODA_EXEC_TEST_FAULT_POINT;
  try {
    process.env.KODA_EXEC_TEST_FAULT_POINT = faultPoint;
    return await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
  } finally {
    if (previousFaultPoint === undefined) {
      delete process.env.KODA_EXEC_TEST_FAULT_POINT;
    } else {
      process.env.KODA_EXEC_TEST_FAULT_POINT = previousFaultPoint;
    }
  }
}
