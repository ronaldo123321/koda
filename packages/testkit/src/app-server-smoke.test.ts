import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { reducePlanUpdate } from "@koda/agent-core";
import {
  APP_SERVER_PROTOCOL_VERSION,
  agentEventSchema,
  planIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("app-server subprocess", () => {
  it("keeps stdout protocol-only and serves credential-free queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-app-server-smoke-"));
    temporaryDirectories.push(root);
    const state = join(root, "state");
    const pluginMarker = join(root, "plugin-started.txt");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: {
          smoke: {
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(pluginMarker)}, 'started')`,
            ],
            required: false,
            capabilities: ["tools"],
          },
        },
      }),
    );
    const entry = join(process.cwd(), "apps", "app-server", "dist", "main.js");
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        KODA_HOME: state,
        OPENAI_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(
      [
        request(1, "initialize", {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: { name: "smoke-test" },
        }),
        request(2, "thread/list", {}),
        request(3, "extension/catalog", { workspace: "." }),
        request(4, "shutdown", {}),
      ].join("\n") + "\n",
    );
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    expect(exit).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
    expect(messages[0]?.result).toMatchObject({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    });
    expect(messages[1]?.result).toMatchObject({ threads: [] });
    expect(messages[2]?.result).toMatchObject({
      workspace: await realpath(root),
      configuredPlugins: [{ pluginId: "smoke", required: false }],
    });
    expect(messages[3]?.result).toEqual({});
    await expect(access(pluginMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers an interrupted Plan but never resurrects its acceptance capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-plan-crash-smoke-"));
    temporaryDirectories.push(root);
    const workspacePath = join(root, "repo");
    const kodaHome = join(root, "state");
    const threadId = threadIdSchema.parse("crashed-plan-thread");
    const turnId = turnIdSchema.parse("crashed-plan-turn");
    const callId = toolCallIdSchema.parse("crashed-plan-call");
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    await mkdir(join(kodaHome, "threads"), { recursive: true });
    const plan = reducePlanUpdate({
      planId: planIdSchema.parse("plan:crashed"),
      update: {
        expectedRevision: 0,
        objective: "Recover an interrupted gated Plan.",
        stages: [
          {
            id: "stage:crashed",
            title: "Review interrupted work",
            requiresAcceptance: true,
            acceptanceCriteria: ["The work is revalidated after restart."],
            summary: "The interrupted work was ready for review.",
            evidence: [{ kind: "tool_call", callId }],
            todos: [
              {
                id: "todo:crashed",
                title: "Prepare interrupted work",
                status: "completed",
                outcome: "Prepared before the process stopped.",
              },
            ],
          },
        ],
      },
    });
    const events = [
      event(0, threadId, turnId, "turn.started", {}),
      event(1, threadId, turnId, "turn.context", {
        provider: "openai",
        model: "offline-model",
        workspaceRoot: workspace,
        approvalMode: "on-request",
        instructionsSha256: "a".repeat(64),
        repositoryInstructions: [],
      }),
      event(2, threadId, turnId, "tool.started", {
        callId,
        name: "update_plan",
        executionBoundary: true,
      }),
      event(3, threadId, turnId, "tool.execution_started", {
        callId,
        name: "update_plan",
        effect: "control",
      }),
      event(4, threadId, turnId, "plan.updated", {
        callId,
        source: "model_update",
        plan,
      }),
      event(5, threadId, turnId, "plan.checkpointed", {
        checkpoint: {
          checkpointId: "checkpoint:crashed",
          planId: plan.planId,
          planRevision: plan.revision,
          activeStageId: plan.stages[0]!.id,
          lastSafeSequence: 4,
          reason: "plan_update",
          evidence: [{ kind: "event", sequence: 4 }],
        },
      }),
      event(6, threadId, turnId, "plan.acceptance_requested", {
        callId,
        planId: plan.planId,
        planRevision: plan.revision,
        stageId: plan.stages[0]!.id,
        criteria: plan.stages[0]!.acceptanceCriteria,
        summary: plan.stages[0]!.summary!,
        evidence: plan.stages[0]!.evidence,
      }),
    ];
    await writeFile(
      join(kodaHome, "threads", `${threadId}.jsonl`),
      `${events.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`,
    );

    const entry = join(process.cwd(), "apps", "app-server", "dist", "main.js");
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        KODA_HOME: kodaHome,
        OPENAI_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(
      [
        request(1, "initialize", {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: { name: "plan-crash-smoke" },
        }),
        request(2, "plan/get", { workspace, threadId }),
        request(3, "plan/acceptance/resolve", {
          threadId,
          turnId,
          callId,
          planId: plan.planId,
          planRevision: plan.revision,
          stageId: plan.stages[0]!.id,
          decision: "accepted",
        }),
        request(4, "shutdown", {}),
      ].join("\n") + "\n",
    );
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    expect(exit).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages[1]).toMatchObject({
      result: {
        threadId,
        plan: {
          planId: plan.planId,
          revision: 1,
          status: "active",
          stages: [{ id: "stage:crashed", status: "awaiting_acceptance" }],
        },
        checkpoint: { checkpointId: "checkpoint:crashed", planRevision: 1 },
        recovery: {
          previousTurnId: turnId,
          previousStatus: "interrupted",
          needsRevalidation: false,
        },
      },
    });
    expect(messages[2]?.error).toMatchObject({
      data: { code: "TURN_NOT_FOUND" },
    });
    expect(messages[3]?.result).toEqual({});
  });
});

function event(
  sequence: number,
  threadId: ReturnType<typeof threadIdSchema.parse>,
  turnId: ReturnType<typeof turnIdSchema.parse>,
  type: string,
  payload: unknown,
) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-28T00:00:00.000Z",
    threadId,
    turnId,
    type,
    payload,
  });
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
