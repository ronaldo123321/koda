import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KodaApplication,
  type KodaApplicationDependencies,
  type TurnClient,
} from "@koda/app";
import type { ModelProvider } from "@koda/agent-core";
import { threadIdSchema, turnIdSchema, type AgentEvent } from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { JsonlEventStore, ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KodaApplication", () => {
  it("runs and resumes through one transport-neutral workflow", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("application-thread");
    let recoveryObserved = false;
    const providers = [
      new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "First app turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
      new ScriptedModelProvider([
        {
          assertRequest: (request) => {
            recoveryObserved = request.items.some(
              (item) => item.type === "recovery",
            );
          },
          events: [
            { type: "assistant_delta", text: "Second app turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
    ];
    let providerCursor = 0;
    let turnCursor = 0;
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => {
          const provider = providers[providerCursor];
          if (provider === undefined) {
            throw new Error("Unexpected application provider request.");
          }
          providerCursor += 1;
          return provider;
        },
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(`application-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `application-item-${turnCursor}`,
            ),
          };
        },
      },
    });
    const observed: AgentEvent[] = [];
    let everyNotificationWasDurable = true;
    const client: TurnClient = {
      events: {
        append: async (event) => {
          observed.push(event);
          const durable = await new JsonlEventStore(
            join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
          ).readAll();
          everyNotificationWasDurable &&= durable.events.some(
            (persisted) => persisted.sequence === event.sequence,
          );
        },
      },
      approvals: rejectApprovals(),
    };

    const first = application.startTurn(
      { prompt: "Start.", cwd: fixture.workspaceRoot },
      client,
    );
    expect(first.threadId).toBe(threadId);
    await expect(first.completion).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    const second = application.startTurn(
      {
        prompt: "Continue.",
        cwd: fixture.workspaceRoot,
        resume: threadId,
      },
      client,
    );
    await expect(second.completion).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });

    expect(recoveryObserved).toBe(true);
    expect(everyNotificationWasDurable).toBe(true);
    expect(
      observed.filter((event) => event.type === "turn.started"),
    ).toHaveLength(2);

    const queryApplication = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });
    const listed = await queryApplication.listThreads();
    expect(listed.value).toEqual([
      expect.objectContaining({ threadId, status: "completed" }),
    ]);
    await expect(queryApplication.getThread(threadId)).resolves.toMatchObject({
      value: { threadId, status: "completed" },
    });
  });

  it("cancels a live provider and records a terminal event", async () => {
    const fixture = await createFixture();
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        started?.();
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "cancel-application"),
    });
    const events: AgentEvent[] = [];
    const handle = application.startTurn(
      { prompt: "Wait.", cwd: fixture.workspaceRoot },
      {
        events: { append: async (event) => void events.push(event) },
        approvals: rejectApprovals(),
      },
    );

    await providerStarted;
    expect(handle.cancel("Cancelled by application test.")).toBe(true);
    expect(handle.cancel("Duplicate cancellation.")).toBe(false);
    await expect(handle.completion).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 130,
      error: { code: "TURN_CANCELLED" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.cancelled",
      payload: { reason: "Cancelled by application test." },
    });
  });

  it("allows the thread lease to reject a concurrent same-thread turn", async () => {
    const fixture = await createFixture();
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        started?.();
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    let turnCursor = 0;
    const sharedThreadId = threadIdSchema.parse("shared-application-thread");
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => provider,
        createIds: () => {
          turnCursor += 1;
          return {
            threadId: sharedThreadId,
            turnId: turnIdSchema.parse(`shared-application-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `shared-application-item-${turnCursor}`,
            ),
          };
        },
      },
    });
    const client: TurnClient = {
      events: { append: async () => undefined },
      approvals: rejectApprovals(),
    };
    const first = application.startTurn(
      { prompt: "Hold the lease.", cwd: fixture.workspaceRoot },
      client,
    );
    await providerStarted;
    const second = application.startTurn(
      { prompt: "Compete for the lease.", cwd: fixture.workspaceRoot },
      client,
    );

    await expect(second.completion).resolves.toMatchObject({
      status: "failed",
      error: { code: "THREAD_BUSY" },
    });
    first.cancel("Concurrent lease test complete.");
    await expect(first.completion).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("allows different thread leases to run concurrently", async () => {
    const fixture = await createFixture();
    let startedCount = 0;
    let bothStarted: (() => void) | undefined;
    const providersStarted = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        startedCount += 1;
        if (startedCount === 2) {
          bothStarted?.();
        }
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    let turnCursor = 0;
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => provider,
        createIds: () => {
          turnCursor += 1;
          return {
            threadId: threadIdSchema.parse(
              `parallel-application-thread-${turnCursor}`,
            ),
            turnId: turnIdSchema.parse(
              `parallel-application-turn-${turnCursor}`,
            ),
            itemIds: new DeterministicItemIdFactory(
              `parallel-application-item-${turnCursor}`,
            ),
          };
        },
      },
    });
    const client: TurnClient = {
      events: { append: async () => undefined },
      approvals: rejectApprovals(),
    };
    const first = application.startTurn(
      { prompt: "Run first.", cwd: fixture.workspaceRoot },
      client,
    );
    const second = application.startTurn(
      { prompt: "Run second.", cwd: fixture.workspaceRoot },
      client,
    );

    await providersStarted;
    expect(first.threadId).not.toBe(second.threadId);
    first.cancel("Concurrent turn test complete.");
    second.cancel("Concurrent turn test complete.");
    await expect(
      Promise.all([first.completion, second.completion]),
    ).resolves.toEqual([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });
});

async function createFixture(): Promise<{
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "koda-application-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "repo");
  await mkdir(workspaceRoot);
  return { root, workspaceRoot, kodaHome: join(root, "state") };
}

function dependencies(
  provider: ModelProvider,
  prefix: string,
): KodaApplicationDependencies {
  return {
    openWorkspace: (root) => ReadOnlyWorkspace.open(root),
    createProvider: () => provider,
    createIds: () => ({
      threadId: threadIdSchema.parse(`${prefix}-thread`),
      turnId: turnIdSchema.parse(`${prefix}-turn`),
      itemIds: new DeterministicItemIdFactory(`${prefix}-item`),
    }),
  };
}

function rejectApprovals() {
  return {
    request: async () => ({ decision: "rejected" as const }),
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
