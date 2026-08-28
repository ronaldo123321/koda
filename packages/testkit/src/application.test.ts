import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
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
  artifactIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import {
  ArtifactStore,
  JsonlEventStore,
  ReadOnlyWorkspace,
  WorkspaceMutationJournalStore,
  loadProjectSkills,
} from "@koda/runtime-node";
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
    await expect(
      queryApplication.getPlan({
        workspace: fixture.workspaceRoot,
        threadId,
      }),
    ).resolves.toMatchObject({
      threadId,
      recovery: {
        previousTurnId: "application-turn-2",
        previousStatus: "completed",
        needsRevalidation: false,
        uncertainToolCalls: [],
      },
    });
    expect(
      await queryApplication.getPlan({
        workspace: fixture.workspaceRoot,
        threadId,
      }),
    ).not.toHaveProperty("plan");
  });

  it("repairs an interrupted workspace transaction and reconciles its originating audit before a new turn", async () => {
    const fixture = await createFixture();
    const originThreadId = threadIdSchema.parse("mutation-origin-thread");
    const originTurnId = turnIdSchema.parse("mutation-origin-turn");
    const callId = toolCallIdSchema.parse("mutation-origin-call");
    const planSha256 = sha256("mutation-origin-plan");
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(fixture.workspaceRoot, "tracked.txt"), before);
    const originEvents = new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${originThreadId}.jsonl`),
    );
    await originEvents.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        threadId: originThreadId,
        turnId: originTurnId,
        type: "turn.started",
        payload: {},
      }),
    );
    await originEvents.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        threadId: originThreadId,
        turnId: originTurnId,
        type: "tool.execution_started",
        payload: { callId, name: "apply_changes", effect: "write" },
      }),
    );
    await originEvents.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 2,
        timestamp: "2026-08-28T00:00:02.000Z",
        threadId: originThreadId,
        turnId: originTurnId,
        type: "workspace.change_set_prepared",
        payload: {
          callId,
          name: "apply_changes",
          planSha256,
          changes: [
            {
              index: 0,
              operation: "update",
              path: "tracked.txt",
              beforeSha256: sha256(before),
              afterSha256: sha256(after),
              bytes: after.byteLength,
            },
            {
              index: 1,
              operation: "create",
              path: "not-created.txt",
              beforeSha256: null,
              afterSha256: sha256("not created\n"),
              bytes: Buffer.byteLength("not created\n"),
            },
          ],
        },
      }),
    );
    const journal = await WorkspaceMutationJournalStore.open(
      fixture.kodaHome,
      fixture.workspaceRoot,
    );
    await journal.begin({
      identity: {
        threadId: originThreadId,
        turnId: originTurnId,
        callId,
        toolName: "apply_changes",
      },
      planSha256,
      changes: [
        {
          index: 0,
          operation: "update",
          path: "tracked.txt",
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
          bytes: after.byteLength,
          beforeMode: 0o644,
          afterMode: 0o644,
          beforeBytes: before,
          stagedPath:
            ".tracked.txt.koda-change-00000000-0000-4000-8000-000000000000.tmp",
        },
        {
          index: 1,
          operation: "create",
          path: "not-created.txt",
          beforeSha256: null,
          afterSha256: sha256("not created\n"),
          bytes: Buffer.byteLength("not created\n"),
          beforeMode: null,
          afterMode: 0o644,
          stagedPath:
            ".not-created.txt.koda-change-00000000-0000-4000-8000-000000000001.tmp",
        },
      ],
    });
    await writeFile(join(fixture.workspaceRoot, "tracked.txt"), after);

    const diagnostics: string[] = [];
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(
        new ScriptedModelProvider([
          {
            events: [
              { type: "assistant_delta", text: "Recovery observed." },
              { type: "completed", finishReason: "stop" },
            ],
          },
        ]),
        "mutation-recovery",
      ),
    });
    const handle = application.startTurn(
      { prompt: "Continue safely.", cwd: fixture.workspaceRoot },
      {
        events: { append: async () => undefined },
        approvals: rejectApprovals(),
        diagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      },
    );

    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      readFile(join(fixture.workspaceRoot, "tracked.txt"), "utf8"),
    ).resolves.toBe("before\n");
    expect(diagnostics).toContain("WORKSPACE_MUTATION_RECOVERED");
    expect((await originEvents.readAllRequired()).events.at(-1)).toMatchObject({
      type: "workspace.change_set_rolled_back",
      payload: {
        callId,
        planSha256,
        appliedCount: 1,
        restoredPaths: ["tracked.txt"],
      },
    });
    await expect(journal.recoverPending()).resolves.toEqual([]);
  });

  it("inspects, exports, and durably accepts a quarantined workspace conflict", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("mutation-resolution-thread");
    const turnId = turnIdSchema.parse("mutation-resolution-turn");
    const callId = toolCallIdSchema.parse("mutation-resolution-call");
    const planSha256 = sha256("mutation-resolution-plan");
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(fixture.workspaceRoot, "tracked.txt"), before);
    const eventStore = new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
    );
    const events: AgentEvent[] = [
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        threadId,
        turnId,
        type: "turn.started",
        payload: {},
      }),
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        threadId,
        turnId,
        type: "tool.execution_started",
        payload: { callId, name: "apply_changes", effect: "write" },
      }),
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 2,
        timestamp: "2026-08-28T00:00:02.000Z",
        threadId,
        turnId,
        type: "workspace.change_set_prepared",
        payload: {
          callId,
          name: "apply_changes",
          planSha256,
          changes: [
            {
              index: 0,
              operation: "update",
              path: "tracked.txt",
              beforeSha256: sha256(before),
              afterSha256: sha256(after),
              bytes: after.byteLength,
            },
          ],
        },
      }),
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 3,
        timestamp: "2026-08-28T00:00:03.000Z",
        threadId,
        turnId,
        type: "workspace.change_set_uncertain",
        payload: {
          callId,
          name: "apply_changes",
          planSha256,
          appliedCount: 0,
          uncertainPaths: ["tracked.txt"],
          errorCode: "PROCESS_INTERRUPTED",
        },
      }),
    ];
    for (const event of events) {
      await eventStore.append(event);
    }
    const journal = await WorkspaceMutationJournalStore.open(
      fixture.kodaHome,
      fixture.workspaceRoot,
    );
    await journal.begin({
      identity: {
        threadId,
        turnId,
        callId,
        toolName: "apply_changes",
      },
      planSha256,
      changes: [
        {
          index: 0,
          operation: "update",
          path: "tracked.txt",
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
          bytes: after.byteLength,
          beforeMode: 0o644,
          afterMode: 0o644,
          beforeBytes: before,
          stagedPath:
            ".tracked.txt.koda-change-00000000-0000-4000-8000-000000000000.tmp",
        },
      ],
    });
    await writeFile(join(fixture.workspaceRoot, "tracked.txt"), "external\n");
    await journal.recoverPending();

    const application = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });
    const listed = await application.listWorkspaceMutationConflicts(
      fixture.workspaceRoot,
    );
    expect(listed.conflicts).toHaveLength(1);
    const conflict = listed.conflicts[0]!;
    const exported = await application.exportWorkspaceMutationBackup({
      workspace: fixture.workspaceRoot,
      conflictId: conflict.conflictId,
      stateToken: conflict.stateToken,
      operationIndex: 0,
    });
    expect(exported.bytes).toEqual(before);
    await expect(
      application.resolveWorkspaceMutationConflict({
        workspace: fixture.workspaceRoot,
        conflictId: conflict.conflictId,
        stateToken: conflict.stateToken,
        resolution: "accept_current",
      }),
    ).resolves.toMatchObject({
      receipt: { resolution: "accepted_current" },
      audit: { status: "reconciled" },
      acknowledged: true,
    });
    await expect(
      readFile(join(fixture.workspaceRoot, "tracked.txt"), "utf8"),
    ).resolves.toBe("external\n");
    await expect(
      application.listWorkspaceMutationConflicts(fixture.workspaceRoot),
    ).resolves.toMatchObject({ conflicts: [] });
    expect((await eventStore.readAllRequired()).events.at(-1)).toMatchObject({
      type: "workspace.change_set_resolved",
      payload: {
        callId,
        resolution: "accepted_current",
        stateToken: conflict.stateToken,
      },
    });

    const restartCallId = toolCallIdSchema.parse(
      "mutation-resolution-restart-call",
    );
    const restartPlanSha256 = sha256("mutation-resolution-restart-plan");
    const acceptedBefore = Buffer.from("external\n");
    const acceptedAfter = Buffer.from("approved after restart\n");
    await eventStore.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 5,
        timestamp: "2026-08-28T00:00:05.000Z",
        threadId,
        turnId,
        type: "tool.execution_started",
        payload: {
          callId: restartCallId,
          name: "apply_changes",
          effect: "write",
        },
      }),
    );
    await eventStore.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 6,
        timestamp: "2026-08-28T00:00:06.000Z",
        threadId,
        turnId,
        type: "workspace.change_set_prepared",
        payload: {
          callId: restartCallId,
          name: "apply_changes",
          planSha256: restartPlanSha256,
          changes: [
            {
              index: 0,
              operation: "update",
              path: "tracked.txt",
              beforeSha256: sha256(acceptedBefore),
              afterSha256: sha256(acceptedAfter),
              bytes: acceptedAfter.byteLength,
            },
          ],
        },
      }),
    );
    await eventStore.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 7,
        timestamp: "2026-08-28T00:00:07.000Z",
        threadId,
        turnId,
        type: "workspace.change_set_uncertain",
        payload: {
          callId: restartCallId,
          name: "apply_changes",
          planSha256: restartPlanSha256,
          appliedCount: 0,
          uncertainPaths: ["tracked.txt"],
          errorCode: "PROCESS_INTERRUPTED",
        },
      }),
    );
    await journal.begin({
      identity: {
        threadId,
        turnId,
        callId: restartCallId,
        toolName: "apply_changes",
      },
      planSha256: restartPlanSha256,
      changes: [
        {
          index: 0,
          operation: "update",
          path: "tracked.txt",
          beforeSha256: sha256(acceptedBefore),
          afterSha256: sha256(acceptedAfter),
          bytes: acceptedAfter.byteLength,
          beforeMode: 0o644,
          afterMode: 0o644,
          beforeBytes: acceptedBefore,
          stagedPath:
            ".tracked.txt.koda-change-00000000-0000-4000-8000-000000000001.tmp",
        },
      ],
    });
    await writeFile(
      join(fixture.workspaceRoot, "tracked.txt"),
      "second external\n",
    );
    await journal.recoverPending();
    const [restartConflict] = await journal.listConflicts();
    await journal.resolveConflict({
      conflictId: restartConflict!.conflictId,
      stateToken: restartConflict!.stateToken,
      resolution: "accept_current",
    });

    const restartDiagnostics: string[] = [];
    const restartApplication = new KodaApplication({
      environment: {
        KODA_HOME: fixture.kodaHome,
        OPENAI_API_KEY: "offline-test-key",
      },
      processDirectory: fixture.root,
      dependencies: dependencies(
        new ScriptedModelProvider([
          {
            events: [
              { type: "assistant_delta", text: "Pending receipt reconciled." },
              { type: "completed", finishReason: "stop" },
            ],
          },
        ]),
        "mutation-resolution-restart",
      ),
    });
    const restartHandle = restartApplication.startTurn(
      { prompt: "Verify restart reconciliation.", cwd: fixture.workspaceRoot },
      {
        events: { append: async () => undefined },
        approvals: rejectApprovals(),
        diagnostic: (diagnostic) => restartDiagnostics.push(diagnostic.code),
      },
    );
    await expect(restartHandle.completion).resolves.toMatchObject({
      status: "completed",
    });
    expect(restartDiagnostics).toContain(
      "WORKSPACE_MUTATION_CONFLICT_RESOLVED",
    );
    await expect(journal.listPendingResolutionReceipts()).resolves.toEqual([]);
    expect((await eventStore.readAllRequired()).events.at(-1)).toMatchObject({
      type: "workspace.change_set_resolved",
      payload: {
        callId: restartCallId,
        resolution: "accepted_current",
        stateToken: restartConflict!.stateToken,
      },
    });
  });

  it("freezes project Skills, exposes read_skill, and persists activation evidence", async () => {
    const fixture = await createFixture();
    const skillDirectory = join(
      fixture.workspaceRoot,
      ".koda",
      "skills",
      "testing",
    );
    await mkdir(skillDirectory, { recursive: true });
    const skillContent =
      "---\nname: testing\ndescription: Run focused validation.\n---\nUse BODY-FROZEN for this Turn.\n";
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(skillPath, skillContent);
    const skill = (await loadProjectSkills(fixture.workspaceRoot)).sources[0]!;
    let effectiveInstructions = "";
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "read_skill" }),
            ]),
          );
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("application-skill-call"),
            name: "read_skill",
            arguments: { skill_id: skill.skillId },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "tool_result",
                name: "read_skill",
                output: expect.objectContaining({
                  skill_id: skill.skillId,
                  content: skillContent,
                }),
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "Skill applied." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const baseDependencies = dependencies(provider, "application-skill");
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        ...baseDependencies,
        createProvider: (configuration, instructions) => {
          effectiveInstructions = instructions;
          return baseDependencies.createProvider(configuration, instructions);
        },
      },
    });
    const observed: AgentEvent[] = [];

    const handle = application.startTurn(
      { prompt: "Use the testing Skill.", cwd: fixture.workspaceRoot },
      {
        events: { append: async (event) => void observed.push(event) },
        approvals: rejectApprovals(),
      },
    );
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });

    expect(effectiveInstructions).toContain("testing: Run focused validation.");
    expect(effectiveInstructions).toContain(skill.skillId);
    expect(effectiveInstructions).not.toContain("BODY-FROZEN");
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.context",
          payload: expect.objectContaining({
            skills: [expect.objectContaining({ skillId: skill.skillId })],
          }),
        }),
        expect.objectContaining({
          type: "tool.completed",
          payload: expect.objectContaining({
            callId: "application-skill-call",
            name: "read_skill",
            status: "success",
          }),
        }),
      ]),
    );
  });

  it("reports changed Skills on resume and exposes them through context inspection", async () => {
    const fixture = await createFixture();
    const skillDirectory = join(
      fixture.workspaceRoot,
      ".koda",
      "skills",
      "review",
    );
    await mkdir(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: review\ndescription: Review version one.\n---\nOriginal review guidance.\n",
    );
    const threadId = threadIdSchema.parse("application-skill-resume-thread");
    const providers = [
      new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "First Skill turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
      new ScriptedModelProvider([
        {
          assertRequest: (request) => {
            expect(request.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "recovery",
                  skillChanges: [
                    expect.objectContaining({
                      name: "review",
                      change: "changed",
                    }),
                  ],
                }),
              ]),
            );
          },
          events: [
            { type: "assistant_delta", text: "Second Skill turn." },
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
        createProvider: () => providers[providerCursor++]!,
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(
              `application-skill-resume-turn-${turnCursor}`,
            ),
            itemIds: new DeterministicItemIdFactory(
              `application-skill-resume-item-${turnCursor}`,
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
      { prompt: "Start Skill history.", cwd: fixture.workspaceRoot },
      client,
    );
    await expect(first.completion).resolves.toMatchObject({
      status: "completed",
    });
    await writeFile(
      skillPath,
      "---\nname: review\ndescription: Review version two.\n---\nCurrent review guidance.\n",
    );
    const second = application.startTurn(
      {
        prompt: "Resume Skill history.",
        cwd: fixture.workspaceRoot,
        resume: threadId,
      },
      client,
    );
    await expect(second.completion).resolves.toMatchObject({
      status: "completed",
    });

    const contexts = await application.listThreadContexts({
      workspace: fixture.workspaceRoot,
      threadId,
      limit: 10,
    });
    const oldest = contexts.requests.at(-1);
    if (oldest === undefined) {
      throw new Error("Expected the first prepared context.");
    }
    const detail = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence: oldest.anchorSequence,
    });
    const skillSource = detail.instructions.sources.find(
      (source) => source.kind === "skill",
    );
    expect(skillSource).toMatchObject({
      kind: "skill",
      path: ".koda/skills/review/SKILL.md",
      scope: ".",
      status: "modified",
    });
    if (skillSource?.sourceId === undefined) {
      throw new Error("Expected a readable current Skill source.");
    }
    await expect(
      application.readContextInstruction({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence: oldest.anchorSequence,
        sourceId: skillSource.sourceId,
        maxBytes: 16_384,
      }),
    ).resolves.toMatchObject({
      path: ".koda/skills/review/SKILL.md",
      content: expect.stringContaining("Current review guidance."),
    });
  });

  it("restores a durable Plan on resume and reconstructs its pinned model context", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("application-plan-thread");
    let resumedPlanObserved = false;
    const providers = [
      new ScriptedModelProvider([
        {
          events: [
            {
              type: "tool_call",
              callId: toolCallIdSchema.parse("application-plan-call"),
              name: "update_plan",
              arguments: {
                expected_revision: 0,
                objective: "Implement the feature",
                stages: [
                  {
                    id: "stage-build",
                    title: "Build it",
                    requires_acceptance: false,
                    acceptance_criteria: [],
                    evidence: [],
                    todos: [
                      {
                        id: "todo-code",
                        title: "Write the code",
                        status: "in_progress",
                      },
                    ],
                  },
                ],
              },
            },
            { type: "completed", finishReason: "tool_calls" },
          ],
        },
        {
          assertRequest: (request) => {
            expect(request.items.at(-1)).toMatchObject({
              type: "plan_state",
              plan: { revision: 1 },
            });
          },
          events: [{ type: "completed", finishReason: "stop" }],
        },
      ]),
      new ScriptedModelProvider([
        {
          assertRequest: (request) => {
            resumedPlanObserved = request.items.some(
              (item) => item.type === "plan_state" && item.plan.revision === 1,
            );
          },
          events: [{ type: "completed", finishReason: "stop" }],
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
        createProvider: () => providers[providerCursor++]!,
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(`application-plan-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `application-plan-item-${turnCursor}`,
            ),
          };
        },
      },
    });
    const client: TurnClient = {
      events: { append: async () => undefined },
      approvals: rejectApprovals(),
    };

    await expect(
      application.startTurn(
        { prompt: "Create the plan.", cwd: fixture.workspaceRoot },
        client,
      ).completion,
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      application.getPlan({ workspace: fixture.workspaceRoot, threadId }),
    ).resolves.toMatchObject({
      threadId,
      plan: {
        revision: 1,
        objective: "Implement the feature",
        stages: [{ id: "stage-build", status: "active" }],
      },
      checkpoint: { planRevision: 1, reason: "turn_completion" },
      recovery: {
        previousTurnId: "application-plan-turn-1",
        previousStatus: "completed",
        needsRevalidation: false,
        uncertainToolCalls: [],
      },
    });
    const otherWorkspace = join(fixture.root, "other-workspace");
    await mkdir(otherWorkspace);
    await expect(
      application.getPlan({ workspace: otherWorkspace, threadId }),
    ).rejects.toMatchObject({ code: "THREAD_WORKSPACE_MISMATCH" });
    const durable = await new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
    ).readAllRequired();
    const preparedWithPlan = durable.events.find(
      (event) =>
        event.type === "context.prepared" &&
        event.payload.planState !== undefined,
    );
    if (preparedWithPlan?.type !== "context.prepared") {
      throw new Error("Expected a prepared context with pinned Plan state.");
    }
    await expect(
      application.readContext({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence: preparedWithPlan.sequence,
      }),
    ).resolves.toMatchObject({
      reconstruction: {
        valid: true,
        activeItemTypes: expect.arrayContaining([
          { type: "plan_state", count: 1 },
        ]),
      },
    });

    await expect(
      application.startTurn(
        {
          prompt: "Continue.",
          cwd: fixture.workspaceRoot,
          resume: threadId,
        },
        client,
      ).completion,
    ).resolves.toMatchObject({ status: "completed" });
    expect(resumedPlanObserved).toBe(true);
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

  it("audits precise and legacy context requests with bounded current instructions", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.workspaceRoot, "AGENTS.md"),
      "Use the repository test command.\n",
      "utf8",
    );
    const threadId = threadIdSchema.parse("context-inspection-thread");
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () =>
          new ScriptedModelProvider([
            {
              events: [
                { type: "assistant_delta", text: "Inspected." },
                {
                  type: "completed",
                  finishReason: "stop",
                  responseId: "context-response",
                  usage: {
                    inputTokens: 42,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 8,
                    reasoningOutputTokens: 0,
                    totalTokens: 50,
                  },
                },
              ],
            },
          ]),
        createIds: () => ({
          threadId,
          turnId: turnIdSchema.parse("context-inspection-turn"),
          itemIds: new DeterministicItemIdFactory("context-inspection-item"),
        }),
      },
    });
    const handle = application.startTurn(
      { prompt: "Inspect context.", cwd: fixture.workspaceRoot },
      {
        events: { append: async () => undefined },
        approvals: rejectApprovals(),
      },
    );
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);

    const page = await application.listThreadContexts({
      workspace: fixture.workspaceRoot,
      threadId,
    });
    expect(page).toMatchObject({
      workspace: canonicalWorkspace,
      threadId,
      hasEarlier: false,
      requests: [
        {
          precise: true,
          provider: "openai",
          measuredInputTokens: 42,
          activeItemCount: 1,
        },
      ],
    });
    const anchorSequence = page.requests[0]?.anchorSequence;
    if (anchorSequence === undefined) {
      throw new Error("Expected a context request anchor.");
    }
    const detail = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence,
    });
    expect(detail).toMatchObject({
      request: { precise: true },
      usage: { responseId: "context-response" },
      reconstruction: { activeItemCount: 1, valid: true },
      instructions: { effectiveMatchesHistorical: true },
    });
    expect(
      detail.instructions.sources.find((source) => source.path === "AGENTS.md"),
    ).toMatchObject({ status: "unchanged" });

    await writeFile(
      join(fixture.workspaceRoot, "AGENTS.md"),
      "Use the changed repository command.\n",
      "utf8",
    );
    const changed = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence,
    });
    expect(changed.instructions.effectiveMatchesHistorical).toBe(false);
    const changedSource = changed.instructions.sources.find(
      (source) => source.path === "AGENTS.md",
    );
    expect(changedSource).toMatchObject({ status: "modified" });
    if (changedSource?.sourceId === undefined) {
      throw new Error("Expected a readable current instruction source.");
    }
    await expect(
      application.readContextInstruction({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence,
        sourceId: changedSource.sourceId,
        maxBytes: 64,
      }),
    ).resolves.toMatchObject({
      path: "AGENTS.md",
      content: "Use the changed repository command.\n",
      hasEarlier: false,
      hasLater: false,
    });

    await writeFile(
      join(fixture.workspaceRoot, "KODA.md"),
      "Use the newly added instruction.\n",
      "utf8",
    );
    const added = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence,
    });
    expect(
      added.instructions.sources.find((source) => source.path === "KODA.md"),
    ).toMatchObject({ status: "added" });

    await rm(join(fixture.workspaceRoot, "AGENTS.md"));
    const missing = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence,
    });
    const missingSource = missing.instructions.sources.find(
      (source) => source.path === "AGENTS.md",
    );
    expect(missingSource).toMatchObject({ status: "missing" });
    expect(missingSource).not.toHaveProperty("sourceId");

    const otherWorkspace = join(fixture.root, "other-context-workspace");
    await mkdir(otherWorkspace);
    await expect(
      application.listThreadContexts({
        workspace: otherWorkspace,
        threadId,
      }),
    ).rejects.toMatchObject({ code: "THREAD_WORKSPACE_MISMATCH" });

    await expect(
      application.readContextInstruction({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence,
        sourceId: `ctxsrc:${"f".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_INSTRUCTION_NOT_FOUND" });

    const eventPath = join(fixture.kodaHome, "threads", `${threadId}.jsonl`);
    const original = await new JsonlEventStore(eventPath).readAllRequired();
    const preparedIndex = original.events.findIndex(
      (event) => event.type === "context.prepared",
    );
    const prepared = original.events[preparedIndex];
    if (prepared?.type !== "context.prepared") {
      throw new Error("Expected durable context telemetry.");
    }
    const corrupt = original.events.map((event, index) =>
      index === preparedIndex
        ? agentEventSchema.parse({
            ...event,
            payload: {
              ...prepared.payload,
              activeItemsSha256: "0".repeat(64),
            },
          })
        : event,
    );
    await writeFile(
      eventPath,
      `${corrupt.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    await expect(
      application.readContext({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SNAPSHOT_CORRUPT" });

    const legacy = original.events
      .filter((event) => event.type !== "context.prepared")
      .map((event, sequence) => agentEventSchema.parse({ ...event, sequence }));
    await writeFile(
      eventPath,
      `${legacy.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    const legacyPage = await application.listThreadContexts({
      workspace: fixture.workspaceRoot,
      threadId,
    });
    expect(legacyPage.requests).toEqual([
      expect.objectContaining({ precise: false, measuredInputTokens: 42 }),
    ]);
    const legacyAnchor = legacyPage.requests[0]?.anchorSequence;
    if (legacyAnchor === undefined) {
      throw new Error("Expected a legacy request anchor.");
    }
    await expect(
      application.readContext({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence: legacyAnchor,
      }),
    ).resolves.toMatchObject({
      request: { precise: false },
      usage: { usage: { inputTokens: 42 } },
    });
  });

  it("authorizes thread-scoped artifact discovery and verified reads", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("artifact-application-thread");
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);
    const artifactStore = await ArtifactStore.open(
      join(fixture.kodaHome, "artifacts"),
    );
    const first = await artifactStore.materializeText(
      "first artifact 中文 content",
      { inlineBytes: 4 },
    );
    const second = await artifactStore.materializeText(
      '{"second":"artifact content"}',
      { inlineBytes: 4, mediaType: "application/json" },
    );
    const unsupported = await artifactStore.materializeText("binary artifact", {
      inlineBytes: 4,
      mediaType: "application/octet-stream",
    });
    if (
      first.artifact === undefined ||
      second.artifact === undefined ||
      unsupported.artifact === undefined
    ) {
      throw new Error("Expected published artifacts.");
    }
    const log = new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
    );
    await log.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId,
        turnId: "artifact-turn",
        type: "turn.context",
        payload: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: canonicalWorkspace,
          approvalMode: "on-request",
          instructionsSha256: "0".repeat(64),
          repositoryInstructions: [],
        },
      }),
    );
    for (const [sequence, artifact, name] of [
      [1, first.artifact, "read_file"],
      [2, first.artifact, "read_file_again"],
      [3, second.artifact, "mcp_result"],
    ] as const) {
      await log.append(
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence,
          timestamp: "2026-08-27T00:00:00.000Z",
          threadId,
          turnId: "artifact-turn",
          type: "artifact.recorded",
          payload: {
            callId: toolCallIdSchema.parse(`artifact-call-${sequence}`),
            name,
            artifact,
          },
        }),
      );
    }
    const application = new KodaApplication({
      environment: { KODA_HOME: fixture.kodaHome },
      processDirectory: fixture.root,
    });

    const latest = await application.listThreadArtifacts({
      workspace: fixture.workspaceRoot,
      threadId,
      limit: 1,
    });
    expect(latest).toMatchObject({
      workspace: canonicalWorkspace,
      artifacts: [{ sequence: 3, artifact: second.artifact }],
      hasEarlier: true,
      nextBeforeSequence: 3,
    });
    const earlier = await application.listThreadArtifacts({
      workspace: fixture.workspaceRoot,
      threadId,
      beforeSequence: latest.nextBeforeSequence,
      limit: 10,
    });
    expect(earlier.artifacts).toEqual([
      expect.objectContaining({ sequence: 2, artifact: first.artifact }),
    ]);
    expect(earlier.hasEarlier).toBe(false);

    await expect(
      application.readArtifact({
        workspace: fixture.workspaceRoot,
        threadId,
        artifactId: first.artifact.id,
        afterByte: 0,
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({
      workspace: canonicalWorkspace,
      threadId,
      artifact: first.artifact,
      startByte: 0,
      hasEarlier: false,
      hasLater: true,
    });
    await expect(
      application.readArtifact({
        workspace: fixture.workspaceRoot,
        threadId,
        artifactId: artifactIdSchema.parse(`sha256:${"f".repeat(64)}`),
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_REFERENCED" });
    const otherWorkspace = join(fixture.root, "other");
    await mkdir(otherWorkspace);
    await expect(
      application.listThreadArtifacts({
        workspace: otherWorkspace,
        threadId,
      }),
    ).rejects.toMatchObject({ code: "THREAD_WORKSPACE_MISMATCH" });

    await log.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 4,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId,
        turnId: "artifact-turn",
        type: "artifact.recorded",
        payload: {
          callId: "artifact-call-4",
          name: "binary_result",
          artifact: unsupported.artifact,
        },
      }),
    );
    await expect(
      application.readArtifact({
        workspace: fixture.workspaceRoot,
        threadId,
        artifactId: unsupported.artifact.id,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MEDIA_TYPE_UNSUPPORTED" });

    await rm(
      join(
        fixture.kodaHome,
        "artifacts",
        "sha256",
        first.artifact.sha256.slice(0, 2),
        first.artifact.sha256,
      ),
    );
    await expect(
      application.readArtifact({
        workspace: fixture.workspaceRoot,
        threadId,
        artifactId: first.artifact.id,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });

    await writeFile(
      join(
        fixture.kodaHome,
        "artifacts",
        "sha256",
        second.artifact.sha256.slice(0, 2),
        second.artifact.sha256,
      ),
      "x".repeat(second.artifact.bytes),
    );
    await expect(
      application.readArtifact({
        workspace: fixture.workspaceRoot,
        threadId,
        artifactId: second.artifact.id,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
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

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
