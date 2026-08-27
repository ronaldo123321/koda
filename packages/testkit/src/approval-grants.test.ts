import {
  AgentLoop,
  EffectToolPolicy,
  ToolRegistry,
  type ApprovalBroker,
  type ApprovalGrantManager,
  type EventSink,
} from "@koda/agent-core";
import { ApprovalGrantRegistry } from "@koda/app";
import {
  APPROVAL_GRANT_DEFAULT_TTL_SECONDS,
  APPROVAL_GRANT_MAXIMUM_TTL_SECONDS,
  approvalGrantIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ApprovalGrantCandidate,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
} from "./index.js";

const timestamp = "2026-08-28T00:00:00.000Z";
const initialNow = Date.parse(timestamp);
const candidate: ApprovalGrantCandidate = {
  kind: "exact_command",
  key: "a".repeat(64),
  summary: 'cwd: "."\ntimeout: 30000 ms\nargv: ["pnpm","test"]',
  defaultExpiresInSeconds: APPROVAL_GRANT_DEFAULT_TTL_SECONDS,
  maximumExpiresInSeconds: APPROVAL_GRANT_MAXIMUM_TTL_SECONDS,
};

describe("session command approval grants", () => {
  it("reserves, activates, scopes, counts, revokes, and expires exact grants", () => {
    let now = initialNow;
    let cursor = 0;
    const registry = new ApprovalGrantRegistry({
      now: () => now,
      nextId: () => {
        cursor += 1;
        return approvalGrantIdSchema.parse(`grant:test-${cursor}`);
      },
    });
    const manager = registry.forWorkspace("/workspace");
    const pending = manager.prepare("exec_command", candidate, {
      expiresInSeconds: 900,
    });

    expect(registry.list("/workspace")).toEqual([]);
    expect(manager.match("exec_command", candidate)).toBeUndefined();
    pending.activate();
    expect(manager.match("exec_command", candidate)?.id).toBe("grant:test-1");
    expect(
      registry.forWorkspace("/other").match("exec_command", candidate),
    ).toBeUndefined();
    expect(
      manager.match("exec_command", { ...candidate, key: "b".repeat(64) }),
    ).toBeUndefined();
    expect(manager.markUsed(pending.record.id)).toBe(true);
    expect(registry.list("/workspace")[0]).toMatchObject({ uses: 1 });
    const replacement = manager.prepare("exec_command", candidate, {
      expiresInSeconds: 1_800,
    });
    replacement.activate();
    expect(registry.list("/workspace")).toEqual([
      expect.objectContaining({ id: "grant:test-2", uses: 0 }),
    ]);
    expect(registry.revoke("/other", replacement.record.id)).toBe(false);
    expect(registry.revoke("/workspace", replacement.record.id)).toBe(true);
    expect(manager.match("exec_command", candidate)).toBeUndefined();

    const expiring = manager.prepare("exec_command", candidate, {
      expiresInSeconds: 60,
    });
    expiring.activate();
    now += 60_000;
    expect(manager.match("exec_command", candidate)).toBeUndefined();
    expect(registry.list("/workspace")).toEqual([]);
  });

  it("durably creates a grant, then reuses it without consulting the broker", async () => {
    let now = initialNow;
    const registry = new ApprovalGrantRegistry({
      now: () => now,
      nextId: () => approvalGrantIdSchema.parse("grant:reusable"),
    });
    const manager = registry.forWorkspace("/workspace");
    let executions = 0;
    const firstEvents = new MemoryEventStore();
    const first = await runCommandTurn({
      events: firstEvents,
      manager,
      callId: "grant-create-call",
      approvals: {
        request: async () => ({
          decision: "approved",
          reason: "Approve and remember.",
          grant: { expiresInSeconds: 900 },
        }),
      },
      onExecute: () => {
        executions += 1;
      },
    });

    expect(first.status).toBe("completed");
    expect(firstEvents.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["approval.grant_created"]),
    );
    expect(
      firstEvents.events.find(
        (event) => event.type === "approval.grant_created",
      ),
    ).toMatchObject({ payload: { grant: { id: "grant:reusable", uses: 0 } } });
    expect(
      firstEvents.events.findIndex(
        (event) => event.type === "approval.grant_created",
      ),
    ).toBeLessThan(
      firstEvents.events.findIndex(
        (event) => event.type === "tool.execution_started",
      ),
    );

    let approvalCalls = 0;
    const secondEvents = new MemoryEventStore();
    const second = await runCommandTurn({
      events: secondEvents,
      manager,
      callId: "grant-use-call",
      approvals: {
        request: async () => {
          approvalCalls += 1;
          return { decision: "rejected" };
        },
      },
      onExecute: () => {
        executions += 1;
      },
    });

    expect(second.status).toBe("completed");
    expect(approvalCalls).toBe(0);
    expect(executions).toBe(2);
    expect(secondEvents.events.map((event) => event.type)).not.toContain(
      "approval.requested",
    );
    expect(
      secondEvents.events.findIndex(
        (event) => event.type === "approval.grant_used",
      ),
    ).toBeLessThan(
      secondEvents.events.findIndex(
        (event) => event.type === "tool.execution_started",
      ),
    );
    expect(registry.list("/workspace")[0]).toMatchObject({ uses: 1 });

    now += 901_000;
    expect(registry.list("/workspace")).toEqual([]);
  });

  it("bounds active plus pending reservations while allowing exact replacement", () => {
    let cursor = 0;
    const registry = new ApprovalGrantRegistry({
      now: () => initialNow,
      nextId: () => {
        cursor += 1;
        return approvalGrantIdSchema.parse(`grant:capacity-${cursor}`);
      },
    });
    const manager = registry.forWorkspace("/workspace");
    for (let index = 0; index < 64; index += 1) {
      const pending = manager.prepare(
        "exec_command",
        { ...candidate, key: index.toString(16).padStart(64, "0") },
        { expiresInSeconds: 900 },
      );
      pending.activate();
    }
    expect(registry.list("/workspace")).toHaveLength(64);
    expect(() =>
      manager.prepare(
        "exec_command",
        { ...candidate, key: "f".repeat(64) },
        { expiresInSeconds: 900 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "APPROVAL_GRANT_LIMIT_EXCEEDED" }),
    );

    const replacement = manager.prepare(
      "exec_command",
      { ...candidate, key: "0".repeat(64) },
      { expiresInSeconds: 1_800 },
    );
    expect(registry.list("/workspace")).toHaveLength(64);
    replacement.activate();
    expect(registry.list("/workspace")).toHaveLength(64);
    expect(registry.list("/workspace")).toContainEqual(
      expect.objectContaining({ id: "grant:capacity-65" }),
    );
  });

  it("never mode wins over a matching grant", async () => {
    const registry = new ApprovalGrantRegistry({
      now: () => initialNow,
      nextId: () => approvalGrantIdSchema.parse("grant:never-mode"),
    });
    const manager = registry.forWorkspace("/workspace");
    const pending = manager.prepare("exec_command", candidate, {
      expiresInSeconds: 900,
    });
    pending.activate();
    let executed = false;
    const events = new MemoryEventStore();
    const result = await runCommandTurn({
      events,
      manager,
      callId: "grant-never-call",
      approvalMode: "never",
      approvals: { request: async () => ({ decision: "approved" }) },
      onExecute: () => {
        executed = true;
      },
    });

    expect(result.status).toBe("completed");
    expect(executed).toBe(false);
    expect(events.events.map((event) => event.type)).not.toContain(
      "approval.grant_used",
    );
    expect(registry.list("/workspace")[0]).toMatchObject({ uses: 0 });
  });

  it("does not activate or execute when grant creation cannot be persisted", async () => {
    const registry = new ApprovalGrantRegistry({
      now: () => initialNow,
      nextId: () => approvalGrantIdSchema.parse("grant:persistence"),
    });
    const durable = new MemoryEventStore();
    const events: EventSink = {
      append: async (event) => {
        if (event.type === "approval.grant_created") {
          throw new Error("disk unavailable");
        }
        await durable.append(event);
      },
    };
    let executed = false;
    const result = await runCommandTurn({
      events,
      manager: registry.forWorkspace("/workspace"),
      callId: "grant-persistence-call",
      approvals: {
        request: async () => ({
          decision: "approved",
          grant: { expiresInSeconds: 900 },
        }),
      },
      onExecute: () => {
        executed = true;
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "EVENT_PERSISTENCE_FAILED" },
    });
    expect(executed).toBe(false);
    expect(registry.list("/workspace")).toEqual([]);
    expect(durable.events.map((event) => event.type)).not.toContain(
      "tool.execution_started",
    );
  });
});

async function runCommandTurn(options: {
  events: EventSink;
  manager: ApprovalGrantManager;
  approvals: ApprovalBroker;
  callId: string;
  approvalMode?: "on-request" | "never";
  onExecute(): void;
}) {
  const callId = toolCallIdSchema.parse(options.callId);
  const tools = new ToolRegistry();
  tools.register({
    spec: {
      name: "exec_command",
      description: "Test an exact command grant.",
      inputJsonSchema: { type: "object" },
    },
    inputSchema: z.object({ argv: z.array(z.string()) }),
    concurrency: "exclusive",
    effect: "execute",
    prepare: async () => ({
      approval: {
        title: 'Run "pnpm"',
        summary: 'Run a foreground command in ".".',
        details: candidate.summary,
        grantCandidate: candidate,
      },
      execute: async () => {
        options.onExecute();
        return { exit_code: 0 };
      },
    }),
  });
  const provider = new ScriptedModelProvider([
    {
      events: [
        {
          type: "tool_call",
          callId,
          name: "exec_command",
          arguments: { argv: ["pnpm", "test"] },
        },
        { type: "completed", finishReason: "tool_calls" },
      ],
    },
    {
      events: [
        { type: "assistant_delta", text: "Command handled." },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
  return new AgentLoop({
    provider,
    tools,
    policy: new EffectToolPolicy(options.approvalMode ?? "on-request"),
    approvals: options.approvals,
    approvalGrants: options.manager,
    events: options.events,
    ids: new DeterministicItemIdFactory(options.callId),
    clock: new FixedClock(timestamp),
  }).runTurn({
    threadId: threadIdSchema.parse(`thread-${options.callId}`),
    turnId: turnIdSchema.parse(`turn-${options.callId}`),
    userInput: "Run tests.",
  });
}
