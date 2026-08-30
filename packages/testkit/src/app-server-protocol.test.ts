import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  agentEventSchema,
  approvalResolveParamsSchema,
  approvalGrantCandidateSchema,
  approvalGrantRecordSchema,
  approvalGrantsListParamsSchema,
  approvalGrantsListResultSchema,
  approvalGrantsRevokeAllParamsSchema,
  approvalGrantsRevokeParamsSchema,
  artifactReadParamsSchema,
  artifactReadResultSchema,
  contextInstructionReadParamsSchema,
  contextInstructionReadResultSchema,
  contextPreparedPayloadSchema,
  contextReadParamsSchema,
  contextReadResultSchema,
  extensionCatalogParamsSchema,
  extensionCatalogResultSchema,
  extensionReadParamsSchema,
  extensionReadResultSchema,
  initializeParamsSchema,
  initializeResultSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcRequestSchema,
  planAcceptanceResolveParamsSchema,
  planGetParamsSchema,
  planGetResultSchema,
  processAttachResultSchema,
  processInputParamsSchema,
  processReadResultSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsUpdateResultSchema,
  threadEventsParamsSchema,
  threadEventsResultSchema,
  threadArtifactsParamsSchema,
  threadArtifactsResultSchema,
  threadContextParamsSchema,
  threadContextResultSchema,
  threadExtensionsParamsSchema,
  threadExtensionsResultSchema,
  threadGetParamsSchema,
  threadSearchParamsSchema,
  threadSearchResultSchema,
  turnStartParamsSchema,
  turnFinishedNotificationParamsSchema,
  workspaceChangeSetPreparedPayloadSchema,
  workspaceMutationBackupExportResultSchema,
  workspaceMutationConflictResolveParamsSchema,
  workspaceMutationConflictsListResultSchema,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

import {
  linuxProtectedLaunchSecurity,
  macosProtectedLaunchSecurity,
} from "./execution-security-fixtures.js";

describe("app-server protocol", () => {
  it("accepts strict versioned requests and safe JSON-RPC IDs", () => {
    expect(APP_SERVER_PROTOCOL_VERSION).toBe(15);
    expect(
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: { name: "test-client", version: "1.0.0" },
        },
      }),
    ).toMatchObject({ id: 1, method: "initialize" });
    expect(() =>
      initializeParamsSchema.parse({
        protocolVersion: 8,
        client: { name: "legacy-client" },
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: Number.MAX_SAFE_INTEGER + 1,
        method: "initialize",
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        extra: true,
      }),
    ).toThrow();
  });

  it("negotiates planning capabilities and validates exact Plan RPC identities", () => {
    expect(
      initializeResultSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        server: { name: "koda-app-server", version: "test" },
        capabilities: {
          threadQueries: true,
          turnStart: true,
          turnResume: true,
          turnCancellation: true,
          interactiveApproval: true,
          durableEventNotifications: true,
          threadEvents: true,
          threadSearch: true,
          bidirectionalThreadEvents: true,
          runtimeSettings: true,
          artifactInspection: true,
          contextInspection: true,
          multiFileChanges: true,
          patchDocuments: true,
          approvalGrants: true,
          planning: true,
          planCheckpoints: true,
          stageAcceptance: true,
          extensionInspection: true,
          skills: true,
          commandTemplates: true,
          dynamicToolCatalog: true,
          plugins: true,
          workspaceMutationRecovery: true,
          interactiveProcesses: false,
        },
        providers: [
          {
            id: "openai",
            displayName: "OpenAI",
            credentialEnvironmentVariable: "OPENAI_API_KEY",
            defaultModel: "test-model",
            configured: true,
          },
        ],
      }).capabilities,
    ).toMatchObject({
      planning: true,
      planCheckpoints: true,
      stageAcceptance: true,
      extensionInspection: true,
      skills: true,
      commandTemplates: true,
      dynamicToolCatalog: true,
      plugins: true,
      workspaceMutationRecovery: true,
      interactiveProcesses: false,
    });

    expect(
      planGetParamsSchema.parse({
        workspace: "/workspace",
        threadId: "planning-thread",
      }),
    ).toEqual({ workspace: "/workspace", threadId: "planning-thread" });
    expect(
      planGetResultSchema.parse({
        workspace: "/workspace",
        threadId: "planning-thread",
        recovery: {
          previousTurnId: "planning-turn",
          previousStatus: "completed",
          needsRevalidation: false,
          uncertainToolCalls: [],
        },
      }),
    ).not.toHaveProperty("plan");

    const identity = {
      threadId: "planning-thread",
      turnId: "planning-turn",
      callId: "planning-call",
      planId: "plan:planning",
      planRevision: 1,
      stageId: "stage:verify",
    } as const;
    expect(
      planAcceptanceResolveParamsSchema.parse({
        ...identity,
        decision: "accepted",
      }),
    ).toMatchObject(identity);
    expect(() =>
      planAcceptanceResolveParamsSchema.parse({
        ...identity,
        decision: "changes_requested",
      }),
    ).toThrow();
    expect(() =>
      planAcceptanceResolveParamsSchema.parse({
        ...identity,
        decision: "accepted",
        feedback: "Already accepted.",
      }),
    ).toThrow();
    expect(
      planAcceptanceResolveParamsSchema.parse({
        ...identity,
        decision: "changes_requested",
        feedback: "Add a recovery test.",
      }),
    ).toHaveProperty("feedback", "Add a recovery test.");
  });

  it("validates bounded token-bound workspace mutation recovery messages", () => {
    const conflict = {
      conflictId: `wmc_${"a".repeat(64)}`,
      threadId: "recovery-thread",
      turnId: "recovery-turn",
      callId: "recovery-call",
      toolName: "apply_changes",
      planSha256: "b".repeat(64),
      createdAt: "2026-08-28T00:00:00.000Z",
      status: "conflicted",
      stateToken: "c".repeat(64),
      changes: [
        {
          index: 0,
          operation: "update",
          path: "README.md",
          beforeSha256: "d".repeat(64),
          afterSha256: "e".repeat(64),
          beforeMode: 0o644,
          afterMode: 0o644,
          source: {
            kind: "file",
            sha256: "f".repeat(64),
            mode: 0o644,
          },
          stagedPath:
            ".README.md.koda-change-00000000-0000-4000-8000-000000000000.tmp",
          stagedState: { kind: "absent" },
          backup: { bytes: 7, sha256: "d".repeat(64) },
        },
      ],
    };
    expect(
      workspaceMutationConflictsListResultSchema.parse({
        workspace: "/workspace",
        conflicts: [conflict],
      }),
    ).toMatchObject({ conflicts: [{ stateToken: "c".repeat(64) }] });
    expect(
      workspaceMutationConflictResolveParamsSchema.parse({
        workspace: "/workspace",
        conflictId: conflict.conflictId,
        stateToken: conflict.stateToken,
        resolution: "restore_original",
      }),
    ).toMatchObject({ resolution: "restore_original" });
    expect(
      workspaceMutationBackupExportResultSchema.parse({
        workspace: "/workspace",
        conflictId: conflict.conflictId,
        operationIndex: 0,
        sha256: "d".repeat(64),
        bytes: Buffer.byteLength("before"),
        contentBase64: Buffer.from("before").toString("base64"),
      }),
    ).toMatchObject({ bytes: Buffer.byteLength("before") });
    expect(() =>
      workspaceMutationConflictResolveParamsSchema.parse({
        workspace: "/workspace",
        conflictId: conflict.conflictId,
        stateToken: "0".repeat(64),
        resolution: "restore-original",
      }),
    ).toThrow();
  });

  it("validates strict bounded extension catalogs, source reads, and historical snapshots", () => {
    const skill = {
      skillId: `skill:${"a".repeat(64)}`,
      name: "review",
      description: "Review current code.",
      path: ".koda/skills/review/SKILL.md",
      scope: ".",
      bytes: 64,
      sha256: "b".repeat(64),
    };
    const template = {
      templateId: `command-template:${"c".repeat(64)}`,
      name: "summary",
      description: "Summarize the workspace.",
      selector: "summary",
      path: ".koda/commands/summary.md",
      scope: ".",
      bytes: 72,
      sha256: "d".repeat(64),
      parameters: [],
    };
    expect(
      extensionCatalogParamsSchema.parse({ workspace: "/workspace" }),
    ).toEqual({ workspace: "/workspace" });
    expect(
      extensionCatalogResultSchema.parse({
        workspace: "/workspace",
        catalogSha256: "e".repeat(64),
        skills: [skill],
        commandTemplates: [template],
        configuredPlugins: [
          {
            pluginId: "reviewer",
            required: false,
            capabilities: ["skills", "tools"],
            manifestSha256: "f".repeat(64),
          },
        ],
      }),
    ).toMatchObject({ skills: [skill], commandTemplates: [template] });
    expect(
      extensionReadParamsSchema.parse({
        workspace: "/workspace",
        kind: "skill",
        sourceId: skill.skillId,
      }),
    ).toMatchObject({ kind: "skill", sourceId: skill.skillId });
    expect(() =>
      extensionReadParamsSchema.parse({
        workspace: "/workspace",
        kind: "command_template",
        sourceId: skill.skillId,
      }),
    ).toThrow();
    expect(
      extensionReadResultSchema.parse({
        workspace: "/workspace",
        kind: "skill",
        sourceId: skill.skillId,
        path: skill.path,
        scope: skill.scope,
        sha256: skill.sha256,
        totalBytes: 3,
        content: "界",
      }),
    ).toMatchObject({ totalBytes: 3 });
    expect(() =>
      extensionReadResultSchema.parse({
        workspace: "/workspace",
        kind: "skill",
        sourceId: skill.skillId,
        path: skill.path,
        scope: skill.scope,
        sha256: skill.sha256,
        totalBytes: 2,
        content: "界",
      }),
    ).toThrow();
    expect(
      threadExtensionsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "extension-thread",
        anchorSequence: 4,
      }),
    ).toMatchObject({ anchorSequence: 4 });
    expect(
      threadExtensionsResultSchema.parse({
        workspace: "/workspace",
        threadId: "extension-thread",
        turnId: "extension-turn",
        anchorSequence: 4,
        skills: [skill],
        commandTemplates: [template],
        plugins: [],
      }),
    ).toMatchObject({ turnId: "extension-turn" });
  });

  it("carries a safe paused terminal without converting it into failure", () => {
    expect(
      turnFinishedNotificationParamsSchema.parse({
        threadId: "paused-thread",
        turnId: "paused-turn",
        status: "paused",
        exitCode: 0,
      }),
    ).toMatchObject({ status: "paused", exitCode: 0 });
    expect(() =>
      turnFinishedNotificationParamsSchema.parse({
        threadId: "paused-thread",
        turnId: "paused-turn",
        status: "paused",
        exitCode: 1,
      }),
    ).toThrow();
  });

  it("validates method parameters without accepting transport secrets", () => {
    expect(
      initializeParamsSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: { name: "desktop" },
      }),
    ).toMatchObject({ protocolVersion: APP_SERVER_PROTOCOL_VERSION });
    expect(
      turnStartParamsSchema.parse({
        prompt: "Inspect the repository.",
        cwd: ".",
        provider: "deepseek",
        approvalMode: "on-request",
      }),
    ).not.toHaveProperty("apiKey");
    expect(() =>
      turnStartParamsSchema.parse({
        prompt: "Inspect.",
        apiKey: "must-not-cross-protocol",
      }),
    ).toThrow();
    expect(() =>
      turnStartParamsSchema.parse({
        prompt: "Inspect.",
        provider: "custom-provider",
      }),
    ).toThrow();
    expect(() =>
      threadGetParamsSchema.parse({ threadId: "../unsafe" }),
    ).toThrow();
    expect(() =>
      approvalResolveParamsSchema.parse({
        turnId: "turn",
        callId: "call",
        decision: "always",
      }),
    ).toThrow();
  });

  it("validates bounded process sessions without native credentials", () => {
    const processSessionId = "00000000-0000-4000-8000-000000000001";
    const security = macosProtectedLaunchSecurity();
    const attached = processAttachResultSchema.parse({
      processSessionId,
      process: {
        jobId: "job-1",
        displayName: "Dev server",
        cwd: "/workspace",
        state: "running",
        lifecycle: "background",
        createdAtMs: 1,
        updatedAtMs: 2,
        pid: 42,
        security,
      },
      inputState: "owned",
      rows: 24,
      cols: 80,
      cursor: 10,
      earliestCursor: 5,
      latestCursor: 20,
      complete: false,
    });
    expect(attached).not.toHaveProperty("capabilityToken");
    expect(attached.process.security).toEqual(security);
    expect(
      processAttachResultSchema.parse({
        ...attached,
        process: {
          ...attached.process,
          security: linuxProtectedLaunchSecurity(),
        },
      }).process.security,
    ).toMatchObject({
      schema_version: 3,
      platform: "linux",
      sandbox_runtime: { mechanism: "linux_bubblewrap" },
    });
    expect(() =>
      processAttachResultSchema.parse({
        processSessionId,
        process: {
          jobId: "job-1",
          displayName: "Dev server",
          cwd: "/workspace",
          state: "running",
          lifecycle: "background",
          createdAtMs: 1,
          updatedAtMs: 2,
          pid: 42,
          security,
        },
        inputState: "owned",
        rows: 24,
        cols: 80,
        cursor: 4,
        earliestCursor: 5,
        latestCursor: 20,
        complete: false,
      }),
    ).toThrow();
    expect(
      processReadResultSchema.parse({
        status: "ok",
        processSessionId,
        inputState: "read_only",
        cursor: 5,
        nextCursor: 8,
        earliestCursor: 5,
        latestCursor: 8,
        complete: true,
        dataBase64: Buffer.from("abc").toString("base64"),
      }),
    ).toMatchObject({ inputState: "read_only" });
    expect(() =>
      processInputParamsSchema.parse({
        processSessionId,
        dataBase64: Buffer.alloc(16_385).toString("base64"),
      }),
    ).toThrow();
    expect(() =>
      processInputParamsSchema.parse({
        processSessionId,
        dataBase64: "YWJj",
        leaseToken: "must-stay-server-side",
      }),
    ).toThrow();
  });

  it("represents structured JSON-RPC errors", () => {
    expect(
      jsonRpcErrorResponseSchema.parse({
        jsonrpc: "2.0",
        id: "request-1",
        error: {
          code: APP_SERVER_RPC_ERROR_CODE.NOT_INITIALIZED,
          message: "Server is not initialized.",
          data: { code: "SERVER_NOT_INITIALIZED" },
        },
      }),
    ).toMatchObject({
      id: "request-1",
      error: { data: { code: "SERVER_NOT_INITIALIZED" } },
    });
  });

  it("validates exact-command grant candidates, decisions, records, and RPCs", () => {
    const candidate = approvalGrantCandidateSchema.parse({
      kind: "exact_command",
      key: "a".repeat(64),
      summary: 'argv: ["pnpm","test"]',
      defaultExpiresInSeconds: 900,
      maximumExpiresInSeconds: 3600,
    });
    const record = approvalGrantRecordSchema.parse({
      id: "grant:protocol",
      kind: candidate.kind,
      toolName: "exec_command",
      workspaceRoot: "/workspace",
      key: candidate.key,
      summary: candidate.summary,
      createdAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-08-28T00:15:00.000Z",
      uses: 0,
    });

    expect(
      approvalResolveParamsSchema.parse({
        turnId: "turn",
        callId: "call",
        decision: "approved",
        grant: { expiresInSeconds: 900 },
      }),
    ).toHaveProperty("grant.expiresInSeconds", 900);
    expect(() =>
      approvalResolveParamsSchema.parse({
        turnId: "turn",
        callId: "call",
        decision: "rejected",
        grant: { expiresInSeconds: 900 },
      }),
    ).toThrow();
    expect(() =>
      approvalResolveParamsSchema.parse({
        turnId: "turn",
        callId: "call",
        decision: "approved",
        grant: { expiresInSeconds: 59 },
      }),
    ).toThrow();
    expect(
      approvalGrantsListResultSchema.parse({
        workspace: "/workspace",
        grants: [record],
      }),
    ).toMatchObject({ grants: [{ id: "grant:protocol" }] });
    expect(
      approvalGrantsListParamsSchema.parse({ workspace: "/workspace" }),
    ).toEqual({ workspace: "/workspace" });
    expect(
      approvalGrantsRevokeParamsSchema.parse({
        workspace: "/workspace",
        grantId: "grant:protocol",
      }),
    ).toHaveProperty("grantId", "grant:protocol");
    expect(
      approvalGrantsRevokeAllParamsSchema.parse({ workspace: "/workspace" }),
    ).toEqual({ workspace: "/workspace" });
    expect(() =>
      approvalGrantRecordSchema.parse({ ...record, uses: -1 }),
    ).toThrow();
  });

  it("validates strict chronological thread event pages", () => {
    expect(
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: 10,
        limit: 25,
      }),
    ).toMatchObject({ beforeSequence: 10, limit: 25 });
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        limit: 201,
      }),
    ).toThrow();
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: -1,
      }),
    ).toThrow();
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: 4,
        afterSequence: 2,
      }),
    ).toThrow();

    const first = historyEvent(3);
    const second = historyEvent(4);
    expect(
      threadEventsResultSchema.parse({
        events: [first, second],
        hasEarlier: true,
        hasLater: true,
        nextBeforeSequence: 3,
        nextAfterSequence: 4,
      }),
    ).toMatchObject({
      hasEarlier: true,
      hasLater: true,
      nextBeforeSequence: 3,
      nextAfterSequence: 4,
    });
    expect(() =>
      threadEventsResultSchema.parse({
        events: [second, first],
        hasEarlier: true,
        hasLater: false,
        nextBeforeSequence: 4,
      }),
    ).toThrow();
    expect(() =>
      threadEventsResultSchema.parse({
        events: [first],
        hasEarlier: false,
        hasLater: false,
        nextBeforeSequence: 3,
      }),
    ).toThrow();
  });

  it("validates bounded revision-paginated thread search", () => {
    expect(
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "修复 parser",
        limit: 25,
      }),
    ).toMatchObject({ query: "修复 parser", limit: 25 });
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "one two three four five six seven eight nine",
      }),
    ).toThrow();
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "x".repeat(257),
      }),
    ).toThrow();
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "   ",
      }),
    ).toThrow();

    const match = {
      threadId: "history-thread",
      sequence: 4,
      kind: "assistant_message",
      timestamp: "2026-08-27T00:00:00.000Z",
      snippet: "parser repaired",
      threadUpdatedAt: "2026-08-27T00:00:01.000Z",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      turnCount: 1,
    } as const;
    expect(
      threadSearchResultSchema.parse({
        matches: [match],
        revision: 2,
        hasMore: true,
        nextCursor: {
          revision: 2,
          updatedAt: match.threadUpdatedAt,
          threadId: match.threadId,
          sequence: match.sequence,
        },
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 2, hasMore: true });
    expect(() =>
      threadSearchResultSchema.parse({
        matches: [match],
        revision: 2,
        hasMore: true,
        nextCursor: {
          revision: 1,
          updatedAt: match.threadUpdatedAt,
          threadId: match.threadId,
          sequence: match.sequence,
        },
        diagnostics: [],
      }),
    ).toThrow();
  });

  it("validates strict revision-checked runtime settings without secrets", () => {
    expect(
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "deepseek",
        model: "deepseek-chat",
        expectedRevision: 2,
      }),
    ).toEqual({
      workspace: "/workspace",
      provider: "deepseek",
      model: "deepseek-chat",
      expectedRevision: 2,
    });
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "bad\nmodel",
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "x".repeat(257),
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "gpt-test",
        expectedRevision: 0,
        apiKey: "must-not-cross-protocol",
      }),
    ).toThrow();

    expect(
      settingsGetResultSchema.parse({
        workspace: "/workspace",
        revision: 0,
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 0 });
    expect(() =>
      settingsGetResultSchema.parse({
        workspace: "/workspace",
        revision: 1,
        diagnostics: [],
      }),
    ).toThrow();
    expect(
      settingsUpdateResultSchema.parse({
        workspace: "/workspace",
        revision: 3,
        preference: {
          provider: "deepseek",
          model: "deepseek-chat",
          updatedAt: "2026-08-27T08:00:00.000Z",
        },
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 3 });
  });

  it("validates thread-scoped artifact discovery and UTF-8 ranges", () => {
    const hash = "a".repeat(64);
    const artifact = {
      type: "artifact",
      id: `sha256:${hash}`,
      sha256: hash,
      bytes: 6,
      mediaType: "text/plain; charset=utf-8",
    } as const;
    expect(
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        beforeSequence: 20,
        limit: 10,
      }),
    ).toMatchObject({ beforeSequence: 20, limit: 10 });
    expect(() =>
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        limit: 0,
      }),
    ).toThrow();
    expect(() =>
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        limit: 101,
      }),
    ).toThrow();
    expect(
      threadArtifactsResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifacts: [
          {
            sequence: 12,
            callId: "artifact-call",
            name: "read_file",
            artifact,
          },
        ],
        hasEarlier: true,
        nextBeforeSequence: 12,
      }),
    ).toMatchObject({ hasEarlier: true, nextBeforeSequence: 12 });
    expect(() =>
      threadArtifactsResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifacts: [
          {
            sequence: 12,
            callId: "artifact-call",
            name: "read_file",
            artifact,
          },
        ],
        hasEarlier: false,
        nextBeforeSequence: 12,
      }),
    ).toThrow();

    expect(
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        afterByte: 0,
        maxBytes: 16_384,
      }),
    ).toMatchObject({ artifactId: artifact.id, afterByte: 0 });
    expect(() =>
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        maxBytes: 3,
      }),
    ).toThrow();
    expect(() =>
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        beforeByte: 6,
        afterByte: 0,
      }),
    ).toThrow();
    expect(
      artifactReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifact,
        content: "你好",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toMatchObject({ content: "你好", endByte: 6 });
    expect(() =>
      artifactReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifact,
        content: "你",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toThrow();
  });

  it("validates precise context snapshots and opaque instruction ranges", () => {
    const hash = "a".repeat(64);
    const toolHash = "b".repeat(64);
    const sourceId = `ctxsrc:${"c".repeat(64)}`;
    const telemetry = {
      step: 1,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      safetyMarginTokens: 1_000,
      inputBudgetTokens: 8_000,
      fixedInputTokens: 100,
      rawEstimatedInputTokens: 200,
      estimatedInputTokens: 220,
      calibrationFactor: 1.1,
      activeItemCount: 1,
      activeItemTypes: [{ type: "user_message", count: 1 }],
      activeItemsSha256: hash,
      toolCount: 2,
      toolsSha256: toolHash,
    } as const;
    const request = {
      anchorSequence: 3,
      turnId: "context-turn",
      step: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      precise: true,
      provider: "openai",
      model: "gpt-test",
      estimatedInputTokens: 220,
      inputBudgetTokens: 8_000,
      activeItemCount: 1,
      toolCount: 2,
    } as const;

    expect(
      threadContextParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        beforeSequence: 10,
        limit: 100,
      }),
    ).toMatchObject({ beforeSequence: 10, limit: 100 });
    expect(() =>
      threadContextParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        limit: 101,
      }),
    ).toThrow();
    expect(
      threadContextResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        requests: [request],
        hasEarlier: true,
        nextBeforeSequence: 3,
      }),
    ).toMatchObject({ hasEarlier: true, nextBeforeSequence: 3 });
    expect(() =>
      threadContextResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        requests: [request],
        hasEarlier: false,
        nextBeforeSequence: 3,
      }),
    ).toThrow();

    expect(
      contextReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
      }),
    ).toMatchObject({ anchorSequence: 3 });
    expect(
      contextReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        request,
        turnContext: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: "/workspace",
          approvalMode: "on-request",
          instructionsSha256: hash,
          repositoryInstructions: [],
        },
        telemetry,
        reconstruction: {
          activeItemCount: 1,
          activeItemTypes: [{ type: "user_message", count: 1 }],
          activeItemsSha256: hash,
          valid: true,
        },
        instructions: {
          historicalEffectiveSha256: hash,
          currentEffectiveSha256: hash,
          effectiveMatchesHistorical: true,
          sources: [
            {
              kind: "effective",
              sourceId,
              path: "effective",
              scope: ".",
              status: "unchanged",
              historical: { sha256: hash },
              current: { bytes: 10, sha256: hash },
            },
          ],
        },
      }),
    ).toMatchObject({ telemetry: { step: 1 } });
    expect(() =>
      contextReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        request,
        turnContext: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: "/workspace",
          approvalMode: "on-request",
          instructionsSha256: hash,
          repositoryInstructions: [],
        },
        instructions: {
          historicalEffectiveSha256: hash,
          currentEffectiveSha256: hash,
          effectiveMatchesHistorical: true,
          sources: [],
        },
      }),
    ).toThrow();

    expect(
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        afterByte: 0,
        maxBytes: 16_384,
      }),
    ).toMatchObject({ sourceId, afterByte: 0 });
    expect(() =>
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId: "AGENTS.md",
      }),
    ).toThrow();
    expect(() =>
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        beforeByte: 6,
        afterByte: 0,
      }),
    ).toThrow();
    expect(
      contextInstructionReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        path: "AGENTS.md",
        content: "你好",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toMatchObject({ content: "你好" });

    expect(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 3,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId: "context-thread",
        turnId: "context-turn",
        type: "context.prepared",
        payload: telemetry,
      }),
    ).toMatchObject({ type: "context.prepared" });
    expect(() =>
      contextPreparedPayloadSchema.parse({
        ...telemetry,
        activeItemCount: 2,
        activeItemTypes: [
          { type: "assistant_message", count: 1 },
          { type: "user_message", count: 1 },
        ],
      }),
    ).toThrow();

    const changeSet = {
      planSha256: "b".repeat(64),
      changes: [
        {
          index: 0,
          operation: "move" as const,
          path: "old.txt",
          destination: "new.txt",
          beforeSha256: "c".repeat(64),
          afterSha256: "c".repeat(64),
          bytes: 12,
        },
      ],
    };
    expect(workspaceChangeSetPreparedPayloadSchema.parse(changeSet)).toEqual(
      changeSet,
    );
    expect(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 4,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId: "context-thread",
        turnId: "context-turn",
        type: "workspace.change_set_prepared",
        payload: {
          callId: "change-set-call",
          name: "apply_changes",
          ...changeSet,
        },
      }),
    ).toMatchObject({ type: "workspace.change_set_prepared" });
    expect(() =>
      workspaceChangeSetPreparedPayloadSchema.parse({
        ...changeSet,
        changes: [
          {
            ...changeSet.changes[0],
            afterSha256: "d".repeat(64),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      workspaceChangeSetPreparedPayloadSchema.parse({
        ...changeSet,
        changes: [
          changeSet.changes[0],
          {
            index: 1,
            operation: "create",
            path: "new.txt",
            beforeSha256: null,
            afterSha256: "e".repeat(64),
            bytes: 1,
          },
        ],
      }),
    ).toThrow();
  });
});

function historyEvent(sequence: number) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-27T00:00:00.000Z",
    threadId: "history-thread",
    turnId: "history-turn",
    type: "assistant.delta",
    payload: { text: `event ${sequence}` },
  });
}
