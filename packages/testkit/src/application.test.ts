import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KodaApplication,
  type KodaApplicationDependencies,
  type TurnClient,
} from "@koda/app";
import type { ModelProvider } from "@koda/agent-core";
import {
  THREAD_EVENTS_RESULT_BUDGET_BYTES,
  agentEventSchema,
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
} from "@koda/protocol";
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
  it("persists canonical workspace runtime settings and reports credential availability", async () => {
    const fixture = await createFixture();
    const application = new KodaApplication({
      environment: {
        KODA_HOME: fixture.kodaHome,
        OPENAI_API_KEY: "offline-test-key",
      },
      processDirectory: fixture.root,
    });
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);

    expect(application.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai", configured: true }),
        expect.objectContaining({ id: "deepseek", configured: false }),
      ]),
    );
    await expect(
      application.getRuntimeSettings(fixture.workspaceRoot),
    ).resolves.toEqual({
      workspace: canonicalWorkspace,
      revision: 0,
      diagnostics: [],
    });
    await expect(
      application.updateRuntimeSettings({
        workspace: fixture.workspaceRoot,
        provider: "openai",
        model: "gpt-workspace",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({
      workspace: canonicalWorkspace,
      revision: 1,
      preference: { provider: "openai", model: "gpt-workspace" },
    });
    await expect(
      application.getRuntimeSettings(fixture.workspaceRoot),
    ).resolves.toMatchObject({
      revision: 1,
      preference: { provider: "openai", model: "gpt-workspace" },
    });
    await expect(
      application.updateRuntimeSettings({
        workspace: fixture.workspaceRoot,
        provider: "deepseek",
        model: "deepseek-chat",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_MISSING" });
    await expect(
      application.updateRuntimeSettings({
        workspace: fixture.workspaceRoot,
        provider: "openai",
        model: "gpt-stale",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
    await expect(
      application.getRuntimeSettings(join(fixture.workspaceRoot, "missing")),
    ).rejects.toMatchObject({ code: "INVALID_RUNTIME_SETTINGS" });
  });

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

  it("reads authoritative thread history with stable exclusive cursors", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("history-page-thread");
    const path = join(fixture.kodaHome, "threads", `${threadId}.jsonl`);
    const store = new JsonlEventStore(path);
    for (let sequence = 0; sequence < 5; sequence += 1) {
      await store.append(historyEvent(threadId, sequence));
    }
    const application = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });

    const latest = await application.readThreadEvents({
      threadId,
      limit: 2,
    });
    expect(latest.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(latest).toMatchObject({
      hasEarlier: true,
      hasLater: false,
      nextBeforeSequence: 3,
    });
    if (latest.nextBeforeSequence === undefined) {
      throw new Error("Latest history page did not provide a cursor.");
    }

    await store.append(historyEvent(threadId, 5));
    const earlier = await application.readThreadEvents({
      threadId,
      beforeSequence: latest.nextBeforeSequence,
      limit: 2,
    });
    expect(earlier.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(earlier).toMatchObject({
      hasEarlier: true,
      hasLater: true,
      nextBeforeSequence: 1,
      nextAfterSequence: 2,
    });
    if (earlier.nextBeforeSequence === undefined) {
      throw new Error("Earlier history page did not provide a cursor.");
    }

    const oldest = await application.readThreadEvents({
      threadId,
      beforeSequence: earlier.nextBeforeSequence,
    });
    expect(oldest.events.map((event) => event.sequence)).toEqual([0]);
    expect(oldest.hasEarlier).toBe(false);
    expect(oldest.hasLater).toBe(true);
    expect(oldest.nextBeforeSequence).toBeUndefined();

    const forward = await application.readThreadEvents({
      threadId,
      afterSequence: 2,
      limit: 2,
    });
    expect(forward.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(forward).toMatchObject({
      hasEarlier: true,
      hasLater: true,
      nextBeforeSequence: 3,
      nextAfterSequence: 4,
    });
    if (forward.nextAfterSequence === undefined) {
      throw new Error("Forward history page did not provide a cursor.");
    }
    const newest = await application.readThreadEvents({
      threadId,
      afterSequence: forward.nextAfterSequence,
    });
    expect(newest.events.map((event) => event.sequence)).toEqual([5]);
    expect(newest).toMatchObject({ hasEarlier: true, hasLater: false });

    await expect(
      application.readThreadEvents({
        threadId,
        beforeSequence: 3,
        afterSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_THREAD_EVENT_CURSOR" });
  });

  it("bounds history pages without truncating durable events", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("history-budget-thread");
    const store = new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
    );
    const payload = "x".repeat(
      Math.floor(THREAD_EVENTS_RESULT_BUDGET_BYTES / 2),
    );
    await store.append(historyEvent(threadId, 0, payload));
    await store.append(historyEvent(threadId, 1, payload));
    const application = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });

    const page = await application.readThreadEvents({ threadId });
    expect(page.events.map((event) => event.sequence)).toEqual([1]);
    expect(page).toMatchObject({ hasEarlier: true, nextBeforeSequence: 1 });

    const oversizedThreadId = threadIdSchema.parse("oversized-history-thread");
    await new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${oversizedThreadId}.jsonl`),
    ).append(
      historyEvent(
        oversizedThreadId,
        0,
        "x".repeat(THREAD_EVENTS_RESULT_BUDGET_BYTES),
      ),
    );
    await expect(
      application.readThreadEvents({ threadId: oversizedThreadId }),
    ).rejects.toMatchObject({ code: "THREAD_EVENT_TOO_LARGE" });
  });

  it("fails explicitly for missing, partial, and non-contiguous history logs", async () => {
    const fixture = await createFixture();
    const application = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });
    await expect(
      application.readThreadEvents({ threadId: "missing-history" }),
    ).rejects.toMatchObject({ code: "THREAD_EVENT_LOG_NOT_FOUND" });

    const emptyThread = threadIdSchema.parse("empty-history");
    await mkdir(join(fixture.kodaHome, "threads"), { recursive: true });
    await writeFile(
      join(fixture.kodaHome, "threads", `${emptyThread}.jsonl`),
      "",
      "utf8",
    );
    await expect(
      application.readThreadEvents({ threadId: emptyThread }),
    ).rejects.toMatchObject({ code: "THREAD_EVENT_LOG_CORRUPT" });

    const partialThread = threadIdSchema.parse("partial-history");
    const partialPath = join(
      fixture.kodaHome,
      "threads",
      `${partialThread}.jsonl`,
    );
    await new JsonlEventStore(partialPath).append(
      historyEvent(partialThread, 0),
    );
    await appendFile(partialPath, '{"schemaVersion":1', "utf8");
    await expect(
      application.readThreadEvents({ threadId: partialThread }),
    ).rejects.toMatchObject({ code: "THREAD_EVENT_LOG_CORRUPT" });

    const corruptThread = threadIdSchema.parse("sequence-history");
    const corruptPath = join(
      fixture.kodaHome,
      "threads",
      `${corruptThread}.jsonl`,
    );
    await mkdir(join(fixture.kodaHome, "threads"), { recursive: true });
    await writeFile(
      corruptPath,
      `${JSON.stringify(historyEvent(corruptThread, 0))}\n${JSON.stringify(historyEvent(corruptThread, 2))}\n`,
      "utf8",
    );
    await expect(
      application.readThreadEvents({ threadId: corruptThread }),
    ).rejects.toMatchObject({ code: "THREAD_EVENT_LOG_CORRUPT" });
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

  it("rejects cross-provider resume before creating another provider", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("provider-resume-thread");
    let providerCreations = 0;
    let turnCursor = 0;
    const provider = new ScriptedModelProvider([
      {
        events: [
          { type: "assistant_delta", text: "Anthropic turn." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const application = new KodaApplication({
      environment: {
        ANTHROPIC_API_KEY: "offline-anthropic-key",
        DEEPSEEK_API_KEY: "offline-deepseek-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => {
          providerCreations += 1;
          return provider;
        },
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(`provider-resume-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `provider-resume-item-${turnCursor}`,
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
      {
        prompt: "Start with Anthropic.",
        cwd: fixture.workspaceRoot,
        provider: "anthropic",
      },
      client,
    );
    await expect(first.completion).resolves.toMatchObject({
      status: "completed",
    });

    const resumed = application.startTurn(
      {
        prompt: "Try to switch.",
        cwd: fixture.workspaceRoot,
        provider: "deepseek",
        resume: threadId,
      },
      client,
    );
    await expect(resumed.completion).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "INVALID_CONFIGURATION",
        message:
          "Thread provider 'anthropic' cannot be resumed with provider 'deepseek'.",
      },
    });
    expect(providerCreations).toBe(1);
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

function historyEvent(
  threadId: ThreadId,
  sequence: number,
  text = `event ${sequence}`,
): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-27T00:00:00.000Z",
    threadId,
    turnId: "history-turn",
    type: "assistant.delta",
    payload: { text },
  });
}

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
