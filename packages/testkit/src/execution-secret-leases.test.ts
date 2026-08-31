import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, ToolRegistry } from "@koda/agent-core";
import {
  ApprovalGrantRegistry,
  ConfigurationError,
  KodaApplication,
} from "@koda/app";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ExecutionSecuritySnapshot,
  type JsonObject,
  type SecretCatalog,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import {
  HostEnvironmentSecretResolver,
  NativeExecutorError,
  SecretLeaseManager,
  SecretPolicyError,
  WorkspaceCommandRunner,
  createExecutionAdmissionSnapshot,
  macosSeatbeltExecutionCapabilities,
  resourceContractExecutionCapabilities,
  registerExecCommandTool,
  registerExecTerminalTool,
  resolveExecutionPolicy,
  type NativeExecutorClient,
  type SecretCommandBinding,
  type SecretResolver,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory, MemoryEventStore } from "./index.js";

const SECRET_VALUE = "c3b-high-entropy-secret-value";
const SOURCE_NAME = "KODA_C3B_TEST_TOKEN";
const TARGET_NAME = "APP_TOKEN_FILE";
const LEASE_ID = "0123456789abcdef0123456789abcdef";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Phase 4C3B secret leases", () => {
  it("freezes the trusted catalog and keeps owned values out of serialization", async () => {
    const resolved: Buffer[] = [];
    const manager = createManager(
      {
        resolve: () => {
          const value = Buffer.from(SECRET_VALUE);
          resolved.push(value);
          return value;
        },
      },
      { wallNow: () => 1_788_000_000_000, monotonicNow: () => 50 },
    );
    const binding = commandBinding();
    const lease = await manager.prepare("exec_command", ["api-token"], binding);
    if (lease === undefined) throw new Error("Expected a secret lease.");

    expect(Object.isFrozen(manager.catalog)).toBe(true);
    expect(Object.isFrozen(manager.catalog.declarations)).toBe(true);
    expect(manager.aliasesFor("exec_command")).toEqual(["api-token"]);
    expect(manager.aliasesFor("exec_terminal")).toEqual(["api-token"]);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(lease.aliases).toEqual(["api-token"]);
    expect(lease.targets).toEqual([
      { alias: "api-token", environmentVariable: TARGET_NAME },
    ]);
    expect(() => JSON.stringify(lease)).toThrowError(
      expect.objectContaining({ code: "SECRET_EVIDENCE_CORRUPT" }),
    );

    const approval = lease.approvalDetails('argv: ["tool"]');
    expect(approval).toContain("fresh approval required");
    expect(approval).toContain("protected profile: read-only");
    expect(approval).toContain("network: denied");
    expect(approval).toContain("api-token -> APP_TOKEN_FILE");
    expect(approval).toContain("exact output redaction: required");
    expect(approval).not.toContain(SECRET_VALUE);
    expect(approval).not.toContain(SOURCE_NAME);

    lease.destroy();
    lease.destroy();
    expect(lease.destroyed).toBe(true);
    expect(resolved[0]).toEqual(Buffer.alloc(Buffer.byteLength(SECRET_VALUE)));
  });

  it("resolves host values once and rejects missing, malformed, duplicate, and colliding values", async () => {
    const environment: NodeJS.ProcessEnv = { [SOURCE_NAME]: SECRET_VALUE };
    let resolutions = 0;
    const host = new HostEnvironmentSecretResolver(
      new Proxy(environment, {
        get(target, property, receiver) {
          if (property === SOURCE_NAME) resolutions += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    );
    const manager = createManager(host);
    const lease = await manager.prepare(
      "exec_command",
      ["api-token"],
      commandBinding(),
    );
    expect(resolutions).toBe(1);
    lease?.destroy();

    await expectCode(
      createManager(new HostEnvironmentSecretResolver({})).prepare(
        "exec_command",
        ["api-token"],
        commandBinding(),
      ),
      "SECRET_VALUE_UNAVAILABLE",
    );
    await expectCode(
      createManager(
        new HostEnvironmentSecretResolver({
          [SOURCE_NAME]: "short",
        }),
      ).prepare("exec_command", ["api-token"], commandBinding()),
      "SECRET_VALUE_INVALID",
    );
    await expectCode(
      createManager(host, {
        targetEnvironment: { [TARGET_NAME]: "/old" },
      }).prepare("exec_command", ["api-token"], commandBinding()),
      "SECRET_POLICY_UNAVAILABLE",
    );

    const duplicateBuffers: Buffer[] = [];
    const duplicateManager = new SecretLeaseManager(
      twoSecretCatalog(),
      {
        resolve: () => {
          const value = Buffer.from(SECRET_VALUE);
          duplicateBuffers.push(value);
          return value;
        },
      },
      deterministicLeaseOptions(),
    );
    await expectCode(
      duplicateManager.prepare(
        "exec_command",
        ["api-token", "signing-key"],
        commandBinding(),
      ),
      "SECRET_VALUE_INVALID",
    );
    expect(duplicateBuffers).toHaveLength(2);
    for (const value of duplicateBuffers) {
      expect(value).toEqual(Buffer.alloc(Buffer.byteLength(SECRET_VALUE)));
    }
  });

  it("binds policy and command identity, expires monotonically, and consumes once", async () => {
    let monotonicNow = 100;
    const manager = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
      { monotonicNow: () => monotonicNow },
    );
    const binding = commandBinding();
    const changed = await manager.prepare(
      "exec_command",
      ["api-token"],
      binding,
    );
    if (changed === undefined) throw new Error("Expected a secret lease.");
    expect(() =>
      changed.rejectUnavailable({ ...binding, timeoutMs: 30_001 }),
    ).toThrowError(expect.objectContaining({ code: "SECRET_POLICY_CHANGED" }));
    expect(changed.destroyed).toBe(true);

    const expired = await manager.prepare(
      "exec_command",
      ["api-token"],
      binding,
    );
    if (expired === undefined) throw new Error("Expected a secret lease.");
    monotonicNow += 1_000;
    expect(() => expired.rejectUnavailable(binding)).toThrowError(
      expect.objectContaining({ code: "SECRET_LEASE_EXPIRED" }),
    );

    monotonicNow = 200;
    const consumed = await manager.prepare(
      "exec_command",
      ["api-token"],
      binding,
    );
    if (consumed === undefined) throw new Error("Expected a secret lease.");
    expect(() => consumed.rejectUnavailable(binding)).toThrowError(
      expect.objectContaining({ code: "SECRET_POLICY_UNAVAILABLE" }),
    );
    expect(() => consumed.rejectUnavailable(binding)).toThrowError(
      expect.objectContaining({ code: "SECRET_REAUTH_REQUIRED" }),
    );
  });

  it("transfers an approved lease once and destroys the owned native buffers", async () => {
    const manager = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
    );
    const binding = commandBinding();
    const lease = await manager.prepare("exec_command", ["api-token"], binding);
    if (lease === undefined) throw new Error("Expected a secret lease.");

    const native = lease.consumeForNative(binding);
    expect(native.evidence).toMatchObject({
      lease_id: LEASE_ID,
      aliases: ["api-token"],
      lifecycle: "resolved",
      cleanup: "not_started",
    });
    expect(native.values[0]?.toString("utf8")).toBe(SECRET_VALUE);
    native.destroy();
    expect(native.values[0]).toEqual(
      Buffer.alloc(Buffer.byteLength(SECRET_VALUE)),
    );
    expect(() => lease.consumeForNative(binding)).toThrowError(
      expect.objectContaining({ code: "SECRET_REAUTH_REQUIRED" }),
    );
  });

  it("rejects unknown or tool-unauthorized aliases without naming host variables", async () => {
    const manager = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
    );
    await expectCode(
      manager.prepare("exec_command", ["unknown-token"], commandBinding()),
      "SECRET_ALIAS_NOT_CONFIGURED",
    );
    const commandOnly = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
      {},
      secretCatalog(["exec_command"]),
    );
    await expectCode(
      commandOnly.prepare("exec_terminal", ["api-token"], {
        ...commandBinding(),
        toolName: "exec_terminal",
      }),
      "SECRET_ALIAS_NOT_CONFIGURED",
    );
  });

  it("requires protected native admission before resolving a value", async () => {
    let resolutions = 0;
    const manager = createManager({
      resolve: () => {
        resolutions += 1;
        return Buffer.from(SECRET_VALUE);
      },
    });
    const unconfined = resolveExecutionPolicy({ workspaceRoot: "/workspace" });
    const unsupported = createExecutionAdmissionSnapshot(
      unconfined,
      resourceContractExecutionCapabilities({
        schema_version: 1,
        backend: "typescript_posix",
        filesystem: { supported: ["unrestricted"], mechanism: "none" },
        network: { supported: ["inherit"], mechanism: "none" },
        process_isolation: { supported: ["inherit"], mechanism: "none" },
        environment: {
          supported: ["explicit"],
          mechanism: "explicit_environment",
          layer: "application",
        },
        supervision: {
          mechanism: "posix_process_group",
          layer: "os",
          durable: false,
        },
      }),
    );
    await expectCode(
      manager.prepare("exec_command", ["api-token"], {
        ...commandBinding(),
        security: unsupported,
      }),
      "SECRET_POLICY_UNAVAILABLE",
    );
    expect(resolutions).toBe(0);
  });
});

describe("Phase 4C3B/C3C command approval", () => {
  it("forwards the approved one-shot lease to exec_terminal without grant reuse", async () => {
    let terminalStarted = false;
    const security = commandBinding().security;
    const runner = {
      root: "/workspace",
      supportsInteractiveProcesses: true,
      prepareTerminal: async () => ({
        argv: ["terminal-tool"],
        cwd: ".",
        timeoutMs: 60_000,
        lifecycle: "background" as const,
        displayName: "secret-terminal",
        title: 'Start terminal "secret-terminal"',
        summary: "Start an interactive background process.",
        preview: 'argv: ["terminal-tool"]',
        security,
        execute: async (
          _signal: AbortSignal,
          lease: import("@koda/runtime-node").SecretLease | undefined,
          binding: SecretCommandBinding | undefined,
        ) => {
          expect(lease).toBeDefined();
          expect(binding?.toolName).toBe("exec_terminal");
          lease?.destroy();
          throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
        },
      }),
    } as unknown as WorkspaceCommandRunner;
    const manager = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
    );
    const tools = new ToolRegistry();
    registerExecTerminalTool(tools, runner, { secretLeaseManager: manager });
    const prepared = await tools.prepare(
      {
        callId: toolCallIdSchema.parse("secret-terminal"),
        name: "exec_terminal",
        arguments: {
          argv: ["terminal-tool"],
          timeout_ms: 60_000,
          lifecycle: "background",
          display_name: "secret-terminal",
          secrets: ["api-token"],
        },
      },
      {
        threadId: threadIdSchema.parse("secret-terminal-thread"),
        turnId: turnIdSchema.parse("secret-terminal-turn"),
        signal: new AbortController().signal,
      },
    );
    if (prepared.status !== "ready") {
      throw new Error("Secret terminal did not prepare.");
    }
    expect(prepared.invocation.approval?.grantCandidate).toBeUndefined();
    expect(prepared.invocation.approval?.details).toContain(
      "fresh approval required",
    );
    await expect(prepared.invocation.execute()).resolves.toMatchObject({
      status: "error",
      error: { code: "SECRET_POLICY_UNAVAILABLE" },
    });
    expect(terminalStarted).toBe(false);
  });

  it("does not reuse grants, leaks no value, and rejects before process side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-secret-command-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const marker = join(root, "must-not-run");
    const argv = [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
    ];
    const policy = resolveExecutionPolicy({
      workspaceRoot: canonicalRoot,
      environmentProfile: "read-only",
    });
    const nativeExecutor = {
      hello: async () => ({
        execution_security: resourceContractExecutionCapabilities(
          macosSeatbeltExecutionCapabilities(),
        ),
      }),
      start: async (input: { secretLease?: { destroy(): void } }) => {
        expect(input.secretLease).toBeDefined();
        input.secretLease?.destroy();
        throw new NativeExecutorError(
          "SECRET_POLICY_UNAVAILABLE",
          "The selected backend cannot enforce the requested secret policy.",
        );
      },
    } as unknown as NativeExecutorClient;
    const runner = await WorkspaceCommandRunner.open(root, {
      executionPolicy: policy,
      nativeExecutor,
    });
    const secretManager = createManager(
      new HostEnvironmentSecretResolver({ [SOURCE_NAME]: SECRET_VALUE }),
    );
    const tools = new ToolRegistry();
    registerExecCommandTool(tools, runner, {
      secretLeaseManager: secretManager,
    });

    const definition = tools
      .definitions()
      .find(({ name }) => name === "exec_command");
    expect(definition?.inputJsonSchema).toMatchObject({
      properties: {
        secrets: { items: { enum: ["api-token"] } },
      },
    });
    expect(JSON.stringify(definition)).not.toContain(SOURCE_NAME);
    expect(JSON.stringify(definition)).not.toContain(SECRET_VALUE);

    const ordinary = await prepareCommand(tools, { argv }, "ordinary-command");
    if (ordinary.status !== "ready")
      throw new Error("Command did not prepare.");
    const candidate = ordinary.invocation.approval?.grantCandidate;
    if (candidate === undefined) throw new Error("Missing grant candidate.");
    await ordinary.invocation.dispose();

    const grants = new ApprovalGrantRegistry();
    const grantManager = grants.forWorkspace(canonicalRoot);
    const grant = grantManager.prepare("exec_command", candidate, {
      expiresInSeconds: 900,
    });
    grant.activate();

    let approvalCalls = 0;
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider: new ScriptedModelProvider([
        {
          events: [
            {
              type: "tool_call",
              callId: toolCallIdSchema.parse("secret-command"),
              name: "exec_command",
              arguments: { argv, secrets: ["api-token"] },
            },
            { type: "completed", finishReason: "tool_calls" },
          ],
        },
        {
          events: [
            {
              type: "assistant_delta",
              text: "Secret execution is unavailable.",
            },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
      tools,
      policy: { evaluate: () => ({ decision: "allow" }) },
      approvals: {
        request: async (request) => {
          approvalCalls += 1;
          expect(request.grantCandidate).toBeUndefined();
          expect(request.details).toContain("fresh approval required");
          expect(request.details).toContain("network: denied");
          expect(request.details).not.toContain(SOURCE_NAME);
          expect(request.details).not.toContain(SECRET_VALUE);
          return { decision: "approved" };
        },
      },
      approvalGrants: grantManager,
      events,
      ids: new DeterministicItemIdFactory("secret-command"),
    }).runTurn({
      threadId: threadIdSchema.parse("secret-command-thread"),
      turnId: turnIdSchema.parse("secret-command-turn"),
      userInput: "Run with the configured secret.",
    });

    expect(result.status).toBe("completed");
    expect(approvalCalls).toBe(1);
    expect(grants.list(canonicalRoot)[0]).toMatchObject({ uses: 0 });
    expect(events.events.map((event) => event.type)).not.toContain(
      "approval.grant_used",
    );
    expect(JSON.stringify(events.events)).not.toContain(SOURCE_NAME);
    expect(JSON.stringify(events.events)).not.toContain(SECRET_VALUE);
    const toolResult = result.items.find(
      (item) => item.type === "tool_result" && item.callId === "secret-command",
    );
    expect(toolResult).toMatchObject({
      status: "error",
      error: { code: "SECRET_POLICY_UNAVAILABLE" },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps invalid application catalogs to a fixed configuration error", () => {
    expect(
      () =>
        new KodaApplication({
          environment: {},
          processDirectory: process.cwd(),
          secretCatalog: {
            schema_version: 1,
            declarations: [
              {
                ...secretCatalog().declarations[0]!,
                target: { kind: "file_env", name: "KODA_RESERVED_FILE" },
              },
            ],
          } as SecretCatalog,
        }),
    ).toThrowError(
      expect.objectContaining({
        name: ConfigurationError.name,
        message: "Secret declaration configuration is invalid.",
      }),
    );
  });
});

function secretCatalog(
  tools: ("exec_command" | "exec_terminal")[] = [
    "exec_command",
    "exec_terminal",
  ],
): SecretCatalog {
  return {
    schema_version: 1,
    declarations: [
      {
        schema_version: 1,
        alias: "api-token",
        source: { kind: "host_env", name: SOURCE_NAME },
        target: { kind: "file_env", name: TARGET_NAME },
        tools,
        lease_ms: 1_000,
      },
    ],
  };
}

function twoSecretCatalog(): SecretCatalog {
  return {
    schema_version: 1,
    declarations: [
      ...secretCatalog(["exec_command"]).declarations,
      {
        schema_version: 1,
        alias: "signing-key",
        source: { kind: "host_env", name: "KODA_C3B_SIGNING_KEY" },
        target: { kind: "file_env", name: "SIGNING_KEY_FILE" },
        tools: ["exec_command"],
        lease_ms: 1_000,
      },
    ],
  };
}

function deterministicLeaseOptions(
  overrides: {
    wallNow?: () => number;
    monotonicNow?: () => number;
    targetEnvironment?: NodeJS.ProcessEnv;
  } = {},
) {
  return {
    wallNow: overrides.wallNow ?? (() => 1_788_000_000_000),
    monotonicNow: overrides.monotonicNow ?? (() => 100),
    nextLeaseId: () => LEASE_ID,
    ...(overrides.targetEnvironment === undefined
      ? {}
      : { targetEnvironment: overrides.targetEnvironment }),
  };
}

function createManager(
  resolver: SecretResolver,
  options: Parameters<typeof deterministicLeaseOptions>[0] = {},
  catalog: SecretCatalog = secretCatalog(),
): SecretLeaseManager {
  return new SecretLeaseManager(
    catalog,
    resolver,
    deterministicLeaseOptions(options),
  );
}

function commandBinding(): SecretCommandBinding {
  const policy = resolveExecutionPolicy({
    workspaceRoot: "/workspace",
    environmentProfile: "read-only",
  });
  const security: ExecutionSecuritySnapshot = createExecutionAdmissionSnapshot(
    policy,
    resourceContractExecutionCapabilities(macosSeatbeltExecutionCapabilities()),
  );
  return {
    toolName: "exec_command",
    workspaceRoot: "/workspace",
    cwd: ".",
    argv: ["tool", "argument"],
    timeoutMs: 30_000,
    security,
  };
}

async function prepareCommand(
  tools: ToolRegistry,
  argumentsValue: JsonObject,
  callId: string,
) {
  return tools.prepare(
    {
      callId: toolCallIdSchema.parse(callId),
      name: "exec_command",
      arguments: argumentsValue,
    },
    {
      threadId: threadIdSchema.parse("secret-preparation-thread"),
      turnId: turnIdSchema.parse("secret-preparation-turn"),
      signal: new AbortController().signal,
    },
  );
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretPolicyError);
    expect((error as SecretPolicyError).code).toBe(code);
    expect((error as Error).message).not.toContain(SECRET_VALUE);
    expect((error as Error).message).not.toContain(SOURCE_NAME);
    return;
  }
  throw new Error(`Expected secret error ${code}.`);
}
