import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NativeExecutorClient,
  resolveExecutionPolicy,
  type NativeExecutorStartInput,
  type NativeJobSnapshot,
  type NativePtyAttachment,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const binaryPath = resolve(
  "target/debug",
  process.platform === "win32" ? "koda-exec.exe" : "koda-exec",
);
const legacyBinary = process.env.KODA_LEGACY_EXECUTOR_BINARY;
const fixtures: {
  root: string;
  clients: NativeExecutorClient[];
  children: ChildProcess[];
}[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const client of fixture.clients) {
      try {
        for (const job of (await client.list()).jobs) {
          if (
            ![
              "exited",
              "start_failed",
              "termination_uncertain",
              "quarantined",
            ].includes(job.state)
          ) {
            await client.terminate(job.job_id, "cancellation");
          }
        }
      } catch {
        /* A fault-injected Supervisor can already be gone. */
      }
      await client.closeOwnedSupervisorForTests();
    }
    for (const child of fixture.children) await stop(child);
    await rm(fixture.root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }
});

describe("Phase 4C2 native admission and evidence", () => {
  it.runIf(process.platform === "darwin")(
    "advertises v2 only after the real macOS Seatbelt self-test succeeds",
    async () => {
      const fixture = await setup();
      const previous = process.env.KODA_REQUIRE_MACOS_SEATBELT;
      let client: NativeExecutorClient;
      try {
        process.env.KODA_REQUIRE_MACOS_SEATBELT = "1";
        client = await open(fixture);
      } finally {
        if (previous === undefined)
          delete process.env.KODA_REQUIRE_MACOS_SEATBELT;
        else process.env.KODA_REQUIRE_MACOS_SEATBELT = previous;
      }
      await expect(client!.hello()).resolves.toMatchObject({
        protocol_version: 4,
        platform: "macos",
        execution_security: {
          schema_version: 2,
          backend: "native_posix",
          filesystem: {
            supported: ["unrestricted", "read_only", "workspace_write"],
            mechanism: "macos_seatbelt",
          },
        },
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "advertises v3 only after the real Linux Bubblewrap self-test succeeds",
    async () => {
      const fixture = await setup();
      const previous = process.env.KODA_REQUIRE_LINUX_BUBBLEWRAP;
      let client: NativeExecutorClient;
      try {
        process.env.KODA_REQUIRE_LINUX_BUBBLEWRAP = "1";
        client = await open(fixture);
      } finally {
        if (previous === undefined)
          delete process.env.KODA_REQUIRE_LINUX_BUBBLEWRAP;
        else process.env.KODA_REQUIRE_LINUX_BUBBLEWRAP = previous;
      }
      const hello = await client!.hello();
      expect(hello).toMatchObject({
        protocol_version: 4,
        platform: "linux",
        execution_security: {
          schema_version: 3,
          platform: "linux",
          backend: "native_posix",
          sandbox_runtime: {
            schema_version: 1,
            mechanism: "linux_bubblewrap",
            probe_revision: 1,
          },
          filesystem: {
            supported: ["unrestricted", "read_only", "workspace_write"],
            mechanism: "linux_bubblewrap_mount_namespace",
          },
          network: {
            supported: ["inherit", "deny"],
            mechanism: "linux_network_namespace_seccomp",
          },
        },
      });
      if (hello.execution_security.schema_version !== 3) {
        throw new Error("Expected Linux execution-security schema v3.");
      }
      const runtime = hello.execution_security.sandbox_runtime;
      expect(runtime.canonical_path).toMatch(/^\/(?!\/)/u);
      expect(runtime.device).toMatch(/^(0|[1-9][0-9]*)$/u);
      expect(runtime.inode).toMatch(/^(0|[1-9][0-9]*)$/u);
      expect(runtime.mtime_ns).toMatch(/^(0|[1-9][0-9]*)$/u);
      expect(runtime.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(runtime.version.length).toBeGreaterThan(0);
      expect(runtime.version.length).toBeLessThanOrEqual(256);
    },
  );

  it("retains the active platform security contract through restart and idempotency", async () => {
    const fixture = await setup();
    const client = await open(fixture);
    const hello = await client.hello();
    expect(hello.protocol_version).toBe(4);
    const expectedSchema =
      process.platform === "darwin"
        ? 2
        : process.platform === "linux" &&
            hello.execution_security.schema_version === 3
          ? 3
          : 1;
    expect(hello.execution_security.schema_version).toBe(expectedSchema);
    expect(hello.execution_security.filesystem).toEqual(
      process.platform === "darwin"
        ? {
            supported: ["unrestricted", "read_only", "workspace_write"],
            mechanism: "macos_seatbelt",
          }
        : expectedSchema === 3
          ? {
              supported: ["unrestricted", "read_only", "workspace_write"],
              mechanism: "linux_bubblewrap_mount_namespace",
            }
          : { supported: ["unrestricted"], mechanism: "none" },
    );
    const input = await inputFor(fixture.root, "console.log('policy-ok')");
    const started = await client.start(input);
    const terminal = await waitTerminal(client, started.job_id);
    const currentManifest = await onlyManifest(fixture.root);
    expect(
      JSON.parse(await readFile(currentManifest.path, "utf8")).format_version,
    ).toBe(4);
    expect(
      JSON.parse(
        await readFile(join(currentManifest.directory, "state.json"), "utf8"),
      ).format_version,
    ).toBe(4);
    expect(terminal).toMatchObject({
      state: "exited",
      exit_code: 0,
      security: {
        kind: "policy",
        stage: "launch_setup",
        filesystem: { status: "not_requested" },
        network: { status: "not_requested" },
        process_isolation: { status: "not_requested" },
        environment: {
          status: "applied",
          mechanism: "explicit_environment",
          layer: "application",
        },
      },
    });
    expect((await client.start(input)).job_id).toBe(started.job_id);
    await expect(
      client.start({ ...input, policy: { ...input.policy!, network: "deny" } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await client.closeOwnedSupervisorForTests();
    const restarted = await open(fixture);
    expect((await restarted.get(started.job_id)).security).toEqual(
      terminal.security,
    );
    expect((await restarted.list()).jobs[0]?.security).toEqual(
      terminal.security,
    );
    expect(JSON.stringify(terminal.security)).not.toContain(
      "FIXTURE_ENV_VALUE",
    );
  });

  it.each(["pipe", "pty"] as const)(
    "refuses every unsupported requirement before creating a %s job",
    async (mode) => {
      const fixture = await setup();
      const client = await open(fixture);
      const marker = join(fixture.root, "must-not-run");
      const input = await inputFor(
        fixture.root,
        `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
      );
      const restrictions =
        process.platform === "darwin"
          ? ([{ process_isolation: "required" }] as const)
          : ([
              { filesystem: "read_only" },
              { filesystem: "workspace_write" },
              { network: "deny" },
              { process_isolation: "required" },
            ] as const);
      for (const restriction of restrictions) {
        const denied = {
          ...input,
          requestId: randomUUID(),
          policy: { ...input.policy!, ...restriction },
        };
        await expect(
          mode === "pipe"
            ? client.start(denied)
            : client.startPty({
                ...denied,
                rows: 24,
                cols: 80,
                outputLimitBytes: 65536,
              }),
        ).rejects.toMatchObject({ code: "EXECUTION_POLICY_UNAVAILABLE" });
      }
      expect((await client.list()).jobs).toEqual([]);
      expect(await readdir(join(fixture.root, "state", "jobs"))).toEqual([]);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "darwin").each(["pipe", "pty"] as const)(
    "enforces read-only filesystem and denied network before a %s command runs",
    async (mode) => {
      const fixture = await setup();
      const client = await open(fixture);
      const allowed = join(fixture.root, "allowed.txt");
      const marker = join(fixture.root, `forbidden-${mode}`);
      await writeFile(allowed, "allowed", "utf8");
      const code = [
        "const fs=require('node:fs'),net=require('node:net');",
        `if(fs.readFileSync(${JSON.stringify(allowed)},'utf8')!=='allowed')process.exit(10);`,
        "let denied=0;",
        `try{fs.writeFileSync(${JSON.stringify(marker)},'bad')}catch(error){if(error.code==='EPERM'||error.code==='EACCES')denied+=1;else process.exit(11)}`,
        "const server=net.createServer();",
        "server.once('error',(error)=>{if(error.code==='EPERM'||error.code==='EACCES')denied+=1;else process.exit(12);process.exit(denied===2?0:13)});",
        "server.listen(0,'127.0.0.1',()=>server.close(()=>process.exit(14)));",
      ].join("");
      const input = await inputFor(fixture.root, code);
      input.policy = {
        ...input.policy!,
        filesystem: "read_only",
        network: "deny",
      };
      const started =
        mode === "pipe"
          ? await client.start(input)
          : await client.startPty({
              ...input,
              rows: 24,
              cols: 80,
              outputLimitBytes: 65_536,
            });
      const terminal = await waitTerminal(client, started.job_id);
      expect(terminal.failure).toBeNull();
      expect(terminal).toMatchObject({
        state: "exited",
        exit_code: 0,
        security: {
          schema_version: 2,
          stage: "launch_setup",
          filesystem: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
          network: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
        },
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "darwin")(
    "limits workspace-write to the workspace and private per-job scratch",
    async () => {
      const fixture = await setup();
      const workspace = join(fixture.root, "workspace");
      await mkdir(workspace);
      const workspaceMarker = join(workspace, "workspace-write.txt");
      const outsideMarker = join(fixture.root, "outside-write.txt");
      const scratchName = "scratch-write.txt";
      const client = await open(fixture);
      const code = [
        "const fs=require('node:fs'),path=require('node:path');",
        "if(!process.env.TMPDIR||process.env.TMPDIR!==process.env.TMP||process.env.TMPDIR!==process.env.TEMP)process.exit(20);",
        `fs.writeFileSync(${JSON.stringify(workspaceMarker)},'workspace');`,
        `fs.writeFileSync(path.join(process.env.TMPDIR,${JSON.stringify(scratchName)}),'scratch');`,
        `try{fs.writeFileSync(${JSON.stringify(outsideMarker)},'bad');process.exit(21)}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES')process.exit(22)}`,
      ].join("");
      const input = await inputFor(workspace, code);
      input.policy = {
        ...input.policy!,
        filesystem: "workspace_write",
        network: "deny",
      };
      const started = await client.start(input);
      const terminal = await waitTerminal(client, started.job_id);
      expect(terminal).toMatchObject({
        state: "exited",
        exit_code: 0,
        failure: null,
        security: {
          schema_version: 2,
          stage: "launch_setup",
          filesystem: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
          network: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
        },
      });
      const manifest = await onlyManifest(fixture.root);
      await expect(readFile(workspaceMarker, "utf8")).resolves.toBe(
        "workspace",
      );
      await expect(
        readFile(join(manifest.directory, "scratch", scratchName), "utf8"),
      ).resolves.toBe("scratch");
      await expect(access(outsideMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it
    .runIf(process.platform === "darwin")
    .each(["read_only", "workspace_write"] as const)(
    "preserves inherited network without widening %s filesystem access",
    async (filesystem) => {
      const fixture = await setup();
      const workspace = join(fixture.root, "workspace");
      await mkdir(workspace);
      const workspaceMarker = join(workspace, `${filesystem}-workspace.txt`);
      const outsideMarker = join(fixture.root, `${filesystem}-outside.txt`);
      const server = createServer((socket) => socket.end("network-ok"));
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Expected a TCP test port.");
        }
        const client = await open(fixture);
        const code = [
          "const fs=require('node:fs'),net=require('node:net');",
          filesystem === "workspace_write"
            ? `fs.writeFileSync(${JSON.stringify(workspaceMarker)},'workspace');`
            : `try{fs.writeFileSync(${JSON.stringify(workspaceMarker)},'bad');process.exit(30)}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES')process.exit(31)}`,
          `try{fs.writeFileSync(${JSON.stringify(outsideMarker)},'bad');process.exit(32)}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES')process.exit(33)}`,
          "let output='';",
          `const socket=net.connect(${address.port},'127.0.0.1');`,
          "socket.on('data',(chunk)=>output+=chunk);",
          "socket.on('end',()=>process.exit(output==='network-ok'?0:34));",
          "socket.on('error',()=>process.exit(35));",
        ].join("");
        const input = await inputFor(workspace, code);
        input.policy = {
          ...input.policy!,
          filesystem,
          network: "inherit",
        };
        const terminal = await waitTerminal(
          client,
          (await client.start(input)).job_id,
        );
        expect(terminal).toMatchObject({
          state: "exited",
          exit_code: 0,
          failure: null,
          security: {
            schema_version: 2,
            stage: "launch_setup",
            filesystem: {
              status: "applied",
              mechanism: "macos_seatbelt",
              layer: "os",
            },
            network: { status: "not_requested" },
          },
        });
        if (filesystem === "workspace_write") {
          await expect(readFile(workspaceMarker, "utf8")).resolves.toBe(
            "workspace",
          );
        } else {
          await expect(access(workspaceMarker)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        await expect(access(outsideMarker)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await new Promise<void>((resolvePromise, reject) =>
          server.close((error) =>
            error === undefined ? resolvePromise() : reject(error),
          ),
        );
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "retains protected background PTY evidence through attach, resize, detach and Supervisor restart",
    async () => {
      const fixture = await setup();
      let client = await open(fixture);
      const input = await inputFor(
        fixture.root,
        [
          "process.stdin.setEncoding('utf8');",
          "console.log('READY:'+process.stdout.rows+'x'+process.stdout.columns);",
          "process.on('SIGWINCH',()=>console.log('RESIZE:'+process.stdout.rows+'x'+process.stdout.columns));",
          "process.stdin.once('data',(data)=>{console.log('INPUT:'+data.trim());process.exit(0)});",
          "setInterval(()=>{},1000);",
        ].join(""),
      );
      input.policy = {
        ...input.policy!,
        filesystem: "read_only",
        network: "deny",
      };
      const started = await client.startPty({
        ...input,
        rows: 20,
        cols: 70,
        lifecycle: "background",
      });
      const original = await client.openAttachment(started.job_id);
      await original.acquireInput();
      await expect(readPtyUntil(original, "READY:20x70")).resolves.toContain(
        "READY:20x70",
      );
      const active = await client.get(started.job_id);
      expect(active).toMatchObject({
        state: "running",
        lifecycle: "background",
        security: {
          schema_version: 2,
          stage: "launch_setup",
          filesystem: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
          network: {
            status: "applied",
            mechanism: "macos_seatbelt",
            layer: "os",
          },
        },
      });
      await original.resize(31, 101);
      await expect(readPtyUntil(original, "RESIZE:31x101")).resolves.toContain(
        "RESIZE:31x101",
      );
      await original.close();

      await client.closeOwnedSupervisorForTests();
      client = await open(fixture);
      const recovered = await client.get(started.job_id);
      expect(recovered.security).toEqual(active.security);
      expect((await client.list()).jobs[0]?.security).toEqual(active.security);

      const reattached = await client.openAttachment(started.job_id);
      await reattached.acquireInput();
      await reattached.resize(42, 120);
      await expect(
        readPtyUntil(reattached, "RESIZE:42x120"),
      ).resolves.toContain("RESIZE:42x120");
      await reattached.write("continued\n");
      const terminal = await waitTerminal(client, started.job_id);
      const output = await readPtyToCompletion(reattached);
      expect(output).toContain("INPUT:continued");
      expect(terminal).toMatchObject({
        state: "exited",
        exit_code: 0,
        lifecycle: "background",
      });
      expect(terminal.security).toEqual(active.security);
      await reattached.close();
    },
  );

  it.runIf(process.platform === "darwin")(
    "keeps protected user code gated when the Worker dies after sandbox confirmation",
    async () => {
      const fixture = await setup();
      const client = await open(fixture, "after_sandbox_confirmation");
      const marker = join(fixture.root, "confirmed-but-not-released");
      const input = await inputFor(
        fixture.root,
        `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
      );
      input.policy = {
        ...input.policy!,
        filesystem: "workspace_write",
        network: "deny",
      };
      const started = await client.start(input);
      const terminal = await waitTerminal(client, started.job_id);
      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        security: {
          schema_version: 2,
          stage: "admission",
          filesystem: { status: "not_applied" },
          network: { status: "not_applied" },
        },
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects missing, malformed and future policy fields on the direct native wire", async () => {
    const fixture = await setup();
    const client = await open(fixture);
    const input = await inputFor(fixture.root, "process.exit(0)");
    const params = wireInput(input);
    for (const policy of [
      undefined,
      null,
      { ...input.policy!, schema_version: 2 },
      { ...input.policy!, secret: "fixture-sensitive-marker" },
    ]) {
      const value = policy === undefined ? params : { ...params, policy };
      const response = await rpc(client.socketPath, 4, "job/start", value);
      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_EXECUTION_POLICY" },
      });
      expect(JSON.stringify(response)).not.toContain(
        "fixture-sensitive-marker",
      );
    }
    expect((await client.list()).jobs).toEqual([]);
  });

  it("Worker revalidates a recovered policy before spawning user code", async () => {
    const fixture = await setup();
    const workspace = join(fixture.root, "workspace");
    await mkdir(workspace);
    const marker = join(fixture.root, "worker-must-not-run");
    const fault = await open(fixture, "after_accepted");
    await expect(
      fault.start(
        await inputFor(
          workspace,
          `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ),
      ),
    ).rejects.toBeDefined();
    const manifest = await onlyManifest(fixture.root);
    await rename(workspace, join(fixture.root, "moved-workspace"));
    const client = await open(fixture);
    const terminal = await waitTerminal(client, manifest.job_id);
    expect(terminal).toMatchObject({
      state: "start_failed",
      failure: { code: "INVALID_EXECUTION_POLICY" },
      security: { stage: "admission", environment: { status: "not_applied" } },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["after_command_spawn", "after_security_setup"])(
    "retains only verified evidence after Worker fault at %s",
    async (faultPoint) => {
      const fixture = await setup();
      const client = await open(fixture, faultPoint);
      const marker = join(fixture.root, "gate-must-not-open");
      const started = await client.start(
        await inputFor(
          fixture.root,
          `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ),
      );
      const terminal = await waitTerminal(client, started.job_id);
      expect(terminal.state).toBe("termination_uncertain");
      expect(terminal.security).toMatchObject({
        kind: "policy",
        stage:
          faultPoint === "after_security_setup" || process.platform === "win32"
            ? "launch_setup"
            : "admission",
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const retained = terminal.security;
      await client.closeOwnedSupervisorForTests();
      expect(
        (await (await open(fixture)).get(started.job_id)).security,
      ).toEqual(retained);
    },
  );
});

// Optional cross-version acceptance uses the real pinned v1 binary, not a fake
// Worker. Build commit 3aa84ee and set KODA_LEGACY_EXECUTOR_BINARY to run it.
describe.skipIf(legacyBinary === undefined || process.platform === "win32")(
  "native v1 -> v4 live compatibility",
  () => {
    it("refuses a live v1 Supervisor without replacing it", async () => {
      const fixture = await setup();
      await openLegacy(fixture);
      await expect(open(fixture)).rejects.toMatchObject({
        code: "INCOMPATIBLE_PROTOCOL",
      });
      expect(
        await rpc(endpoint(fixture.root), 1, "job/list", {}),
      ).toMatchObject({ ok: true });
    });

    it("reconnects to a real legacy PTY Worker and preserves attach/input/terminal evidence", async () => {
      const fixture = await setup();
      const old = await openLegacy(fixture);
      const input = await inputFor(
        fixture.root,
        "console.log('LEGACY_READY');process.stdin.once('data',data=>{console.log('LEGACY:'+data.toString().trim());process.exit(0)});setInterval(()=>{},1000)",
      );
      const result = await rpc(endpoint(fixture.root), 1, "job/start", {
        ...wireInput(input),
        io_mode: "pty",
        lifecycle: "background",
        output_limit_bytes: 65536,
        pty: { rows: 24, cols: 80, term: "xterm", output_limit_bytes: 65536 },
      });
      expect(result.ok).toBe(true);
      const jobId = (result.result as { job_id: string }).job_id;
      await waitLegacyState(endpoint(fixture.root), jobId, "running");
      await stop(old);
      const manifest = await onlyManifest(fixture.root);
      const originalManifest = await readFile(manifest.path, "utf8");
      const client = await open(fixture);
      expect((await client.get(jobId)).security).toEqual({
        schema_version: 1,
        kind: "legacy_unknown",
      });
      const attachment = await client.openAttachment(jobId);
      await attachment.acquireInput();
      await attachment.resize(31, 101);
      await attachment.write("legacy-input\n");
      const terminal = await waitTerminal(client, jobId);
      expect(terminal).toMatchObject({
        state: "exited",
        exit_code: 0,
        security: { kind: "legacy_unknown" },
      });
      let output = "";
      for (let i = 0; i < 20; i += 1) {
        const chunk = await attachment.read();
        if (chunk.status === "ok") {
          output += chunk.data.toString();
          if (chunk.complete) break;
        }
      }
      expect(output).toContain("LEGACY:legacy-input");
      expect(await readFile(manifest.path, "utf8")).toBe(originalManifest);
      const statePath = join(manifest.directory, "state.json");
      const state = await readFile(statePath, "utf8");
      await client.get(jobId);
      expect(await readFile(statePath, "utf8")).toBe(state);
      expect(JSON.parse(state).format_version).toBe(1);
      await client.closeOwnedSupervisorForTests();
      const oldAgain = await openLegacy(fixture);
      expect(
        (await rpc(endpoint(fixture.root), 1, "job/get", { job_id: jobId }))
          .result,
      ).toMatchObject({ state: "exited", exit_code: 0 });
      await stop(oldAgain);
    });

    it("stops a real v1 accepted record instead of launching a replacement Worker", async () => {
      const fixture = await setup();
      await openLegacy(fixture, "after_accepted");
      const marker = join(fixture.root, "legacy-must-not-run");
      await expect(
        rpc(
          endpoint(fixture.root),
          1,
          "job/start",
          wireInput(
            await inputFor(
              fixture.root,
              `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
            ),
          ),
        ),
      ).rejects.toBeDefined();
      const manifest = await onlyManifest(fixture.root);
      const client = await open(fixture);
      expect(await client.get(manifest.job_id)).toMatchObject({
        state: "start_failed",
        pid: null,
        security: { kind: "legacy_unknown" },
        failure: { code: "INVALID_EXECUTION_POLICY" },
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(await readFile(manifest.path, "utf8")).format_version,
      ).toBe(1);
      await client.closeOwnedSupervisorForTests();
      const oldAgain = await openLegacy(fixture);
      expect(
        (
          await rpc(endpoint(fixture.root), 1, "job/get", {
            job_id: manifest.job_id,
          })
        ).result,
      ).toMatchObject({
        state: "start_failed",
        failure: { code: "INVALID_EXECUTION_POLICY" },
      });
      await stop(oldAgain);
    });
  },
);

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "koda-policy-")));
  const fixture = {
    root,
    clients: [] as NativeExecutorClient[],
    children: [] as ChildProcess[],
  };
  fixtures.push(fixture);
  return fixture;
}

function endpoint(root: string): string {
  return join(root, "exec.sock");
}

async function open(fixture: (typeof fixtures)[number], fault?: string) {
  const previous = process.env.KODA_EXEC_TEST_FAULT_POINT;
  try {
    if (fault !== undefined) process.env.KODA_EXEC_TEST_FAULT_POINT = fault;
    else delete process.env.KODA_EXEC_TEST_FAULT_POINT;
    const client = await NativeExecutorClient.open({
      binaryPath,
      stateDirectory: join(fixture.root, "state"),
      ...(process.platform === "win32"
        ? {}
        : { socketPath: endpoint(fixture.root) }),
    });
    fixture.clients.push(client);
    return client;
  } finally {
    if (previous === undefined) delete process.env.KODA_EXEC_TEST_FAULT_POINT;
    else process.env.KODA_EXEC_TEST_FAULT_POINT = previous;
  }
}

async function openLegacy(fixture: (typeof fixtures)[number], fault?: string) {
  const child = spawn(
    legacyBinary!,
    [
      "serve",
      "--endpoint",
      endpoint(fixture.root),
      "--state-dir",
      join(fixture.root, "state"),
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        ...(fault === undefined ? {} : { KODA_EXEC_TEST_FAULT_POINT: fault }),
      },
    },
  );
  fixture.children.push(child);
  for (let i = 0; i < 100; i += 1) {
    try {
      await rpc(endpoint(fixture.root), 1, "job/list", {});
      return child;
    } catch {
      if (child.exitCode !== null)
        throw new Error("Legacy Supervisor failed to start.");
      await delay(25);
    }
  }
  throw new Error("Legacy Supervisor startup timed out.");
}

async function inputFor(
  cwd: string,
  code: string,
): Promise<NativeExecutorStartInput> {
  return {
    argv: [process.execPath, "-e", code],
    cwd: await realpath(cwd),
    environment: {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? {
            ComSpec: process.env.ComSpec,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          }
        : {}),
      FIXTURE_ENV: "FIXTURE_ENV_VALUE",
    },
    timeoutMs: 15000,
    outputLimitBytes: 65536,
    terminationGraceMs: 25,
    terminationConfirmationMs: 1000,
    requestId: randomUUID(),
    policy: resolveExecutionPolicy({ workspaceRoot: await realpath(cwd) }),
  };
}

function wireInput(input: NativeExecutorStartInput) {
  return {
    argv: input.argv,
    cwd: input.cwd,
    environment: input.environment,
    timeout_ms: input.timeoutMs,
    output_limit_bytes: input.outputLimitBytes,
    termination_grace_ms: input.terminationGraceMs,
    termination_confirmation_ms: input.terminationConfirmationMs,
  };
}

async function onlyManifest(root: string) {
  const directory = join(
    root,
    "state",
    "jobs",
    (await readdir(join(root, "state", "jobs")))[0]!,
  );
  const path = join(directory, "manifest.json");
  return {
    ...(JSON.parse(await readFile(path, "utf8")) as { job_id: string }),
    directory,
    path,
  };
}

async function waitTerminal(
  client: NativeExecutorClient,
  jobId: string,
): Promise<NativeJobSnapshot> {
  for (let i = 0; i < 200; i += 1) {
    const snapshot = await client.get(jobId);
    if (
      [
        "exited",
        "start_failed",
        "termination_uncertain",
        "quarantined",
      ].includes(snapshot.state)
    )
      return snapshot;
    await delay(20);
  }
  throw new Error("Job did not become terminal.");
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
    if (output.includes(expected)) return output;
    if (result.complete) break;
    await delay(10);
  }
  throw new Error(`Protected PTY did not emit '${expected}'.`);
}

async function readPtyToCompletion(
  attachment: NativePtyAttachment,
): Promise<string> {
  const chunks: Buffer[] = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await attachment.read();
    if (result.status === "cursor_expired") continue;
    chunks.push(result.data);
    if (result.complete) return Buffer.concat(chunks).toString("utf8");
    await delay(10);
  }
  throw new Error("Protected PTY attachment did not complete.");
}

async function waitLegacyState(
  socketPath: string,
  jobId: string,
  expected: string,
): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const response = await rpc(socketPath, 1, "job/get", { job_id: jobId });
    if (
      (response.result as { state?: string } | undefined)?.state === expected
    ) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Legacy job did not enter ${expected}.`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) =>
    child.once("exit", () => resolvePromise()),
  );
  child.kill("SIGTERM");
  await Promise.race([exited, delay(1000)]);
}

interface Response {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

async function rpc(
  socketPath: string,
  version: number,
  method: string,
  params: object,
): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    const responses: Response[] = [];
    const timer = setTimeout(
      () => socket.destroy(new Error("RPC timed out.")),
      5000,
    );
    socket.on("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      if (responses.length < 2) reject(new Error("RPC closed."));
    });
    socket.once("connect", () => {
      for (const [requestMethod, requestParams] of [
        [
          "system/hello",
          {
            client_name: "policy-test",
            client_version: "1",
            supported_versions: [version],
          },
        ],
        [method, params],
      ] as const) {
        const payload = Buffer.from(
          JSON.stringify({
            protocol_version: version,
            request_id: randomUUID(),
            method: requestMethod,
            params: requestParams,
          }),
        );
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length);
        socket.write(Buffer.concat([header, payload]));
      }
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32BE(0)) {
        const length = bytes.readUInt32BE(0);
        responses.push(JSON.parse(bytes.subarray(4, 4 + length).toString()));
        bytes = bytes.subarray(4 + length);
        if (responses.length === 2) {
          resolvePromise(responses[1]!);
          socket.destroy();
        }
      }
    });
  });
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}
