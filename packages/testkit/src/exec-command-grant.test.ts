import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ApprovalGrantCandidate,
  type JsonObject,
} from "@koda/protocol";
import {
  WorkspaceCommandRunner,
  c1ExecutionCapabilities,
  executionCapabilitiesDigest,
  executionPolicyDigest,
  resolveExecutionPolicy,
  registerExecCommandTool,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("exec_command approval grant identity", () => {
  it("normalizes defaults and changes on argv, cwd, timeout, or workspace", async () => {
    const firstRoot = await createWorkspace();
    await mkdir(join(firstRoot, "nested"));
    const first = await createRegistry(firstRoot);
    const argv = [process.execPath, "-e", "process.exit(0)"];
    const defaults = await grantCandidate(first, { argv }, "defaults");
    const explicitDefaults = await grantCandidate(
      first,
      { argv, cwd: ".", timeout_ms: 30_000 },
      "explicit-defaults",
    );

    expect(explicitDefaults.key).toBe(defaults.key);
    const canonicalRoot = await realpath(firstRoot);
    const policy = resolveExecutionPolicy({ workspaceRoot: canonicalRoot });
    const capabilities = c1ExecutionCapabilities(
      process.platform === "win32" ? "typescript_windows" : "typescript_posix",
    );
    expect(defaults.key).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            version: 2,
            toolName: "exec_command",
            workspaceRoot: canonicalRoot,
            cwd: ".",
            argv,
            timeoutMs: 30_000,
            policyDigest: executionPolicyDigest(policy),
            backend: capabilities.backend,
            capabilitiesDigest: executionCapabilitiesDigest(capabilities),
          }),
        )
        .digest("hex"),
    );
    await expect(
      grantCandidate(first, { argv: [...argv, "extra"] }, "different-argv"),
    ).resolves.not.toMatchObject({ key: defaults.key });
    await expect(
      grantCandidate(first, { argv, cwd: "nested" }, "different-cwd"),
    ).resolves.not.toMatchObject({ key: defaults.key });
    await expect(
      grantCandidate(first, { argv, timeout_ms: 30_001 }, "different-timeout"),
    ).resolves.not.toMatchObject({ key: defaults.key });

    const secondRoot = await createWorkspace();
    const second = await createRegistry(secondRoot);
    await expect(
      grantCandidate(second, { argv }, "different-workspace"),
    ).resolves.not.toMatchObject({ key: defaults.key });
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-command-grant-"));
  temporaryDirectories.push(root);
  return root;
}

async function createRegistry(root: string): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  registerExecCommandTool(registry, await WorkspaceCommandRunner.open(root));
  return registry;
}

async function grantCandidate(
  registry: ToolRegistry,
  argumentsValue: JsonObject,
  callIdValue: string,
): Promise<ApprovalGrantCandidate> {
  const result = await registry.prepare(
    {
      callId: toolCallIdSchema.parse(callIdValue),
      name: "exec_command",
      arguments: argumentsValue,
    },
    {
      threadId: threadIdSchema.parse("command-grant-thread"),
      turnId: turnIdSchema.parse("command-grant-turn"),
      signal: new AbortController().signal,
    },
  );
  if (result.status !== "ready") {
    throw new Error(
      result.result.status === "error"
        ? result.result.error.message
        : "Unexpected successful preparation result.",
    );
  }
  const candidate = result.invocation.approval?.grantCandidate;
  if (candidate === undefined) {
    throw new Error("exec_command did not produce a grant candidate.");
  }
  return candidate;
}
