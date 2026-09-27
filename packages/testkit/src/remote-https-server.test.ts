import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { KodaApplication } from "@koda/app";
import {
  RemoteDeviceStore,
  RemoteThreadStore,
  RemoteWorkspaceStore,
  startRemoteHttpsServer,
} from "@koda/app-server";
import { runRemoteServeCommand } from "@koda/cli";
import { agentEventSchema, threadMetadataSchema } from "@koda/protocol";
import { ArtifactStore, JsonlEventStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "remote HTTPS read transport",
  () => {
    it("requires a trusted certificate and a live scoped device token", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-https-"));
      const workspace = await mkdtemp(join(tmpdir(), "koda-remote-workspace-"));
      const otherWorkspace = await mkdtemp(
        join(tmpdir(), "koda-remote-other-"),
      );
      directories.push(home, workspace, otherWorkspace);
      const certificatePath = join(home, "cert.pem");
      const privateKeyPath = join(home, "key.pem");
      await execFileAsync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-days",
        "1",
      ]);
      await chmod(privateKeyPath, 0o600);
      const certificate = await readFile(certificatePath);
      const workspaces = await RemoteWorkspaceStore.open(home, "owner");
      await workspaces.register("project", workspace);
      await workspaces.register("other", otherWorkspace);
      const devices = await RemoteDeviceStore.open(home, "owner");
      const issued = await devices.issue("phone", [
        {
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read", "turn:start"],
        },
      ]);
      const readOnly = await devices.issue("tablet", [
        { workspaceId: "project", permissions: ["workspace:read"] },
      ]);
      const observer = await devices.issue("observer", [
        {
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read"],
        },
      ]);
      const secondWriter = await devices.issue("laptop", [
        {
          workspaceId: "project",
          permissions: ["workspace:read", "turn:start"],
        },
      ]);
      const controlDevice = await devices.issue("controller", [
        { workspaceId: "project", permissions: ["turn:control"] },
      ]);
      const bindings = await RemoteThreadStore.open(home, "owner");
      await bindings.bind({
        ownerId: "owner",
        workspaceId: "project",
        threadId: "thread-1",
      });
      await bindings.bind({
        ownerId: "owner",
        workspaceId: "project",
        threadId: "thread-2",
      });
      await bindings.bind({
        ownerId: "owner",
        workspaceId: "other",
        threadId: "thread-other",
      });
      const metadata = threadMetadataSchema.parse({
        threadId: "thread-1",
        logFile: join(home, "threads", "thread-1.jsonl"),
        status: "completed",
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:01:00.000Z",
        workspaceRoot: await realpath(workspace),
        turnCount: 1,
        eventCount: 1,
        usage: {
          modelRequests: 0,
          reportedRequests: 0,
          tokens: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
        },
        sourceBytes: 1,
        indexedBytes: 1,
        sourceMtimeMs: 1,
        errorMessage: "private diagnostic",
      });
      const secondMetadata = threadMetadataSchema.parse({
        ...metadata,
        threadId: "thread-2",
        logFile: join(home, "threads", "thread-2.jsonl"),
      });
      const otherMetadata = threadMetadataSchema.parse({
        ...metadata,
        threadId: "thread-other",
        logFile: join(home, "threads", "thread-other.jsonl"),
        workspaceRoot: await realpath(otherWorkspace),
      });
      const artifactApplication = new KodaApplication({
        environment: { KODA_HOME: home },
        processDirectory: workspace,
      });
      const artifactStore = await ArtifactStore.open(join(home, "artifacts"));
      const materialized = await artifactStore.materializeText(
        "Remote artifact 中文 content",
        { inlineBytes: 4 },
      );
      if (materialized.artifact === undefined) {
        throw new Error("Expected a published artifact.");
      }
      const artifact = materialized.artifact;
      const artifactLog = new JsonlEventStore(
        join(home, "threads", "thread-1.jsonl"),
      );
      await artifactLog.append(
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 0,
          timestamp: "2026-09-27T00:00:00.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "turn.context",
          payload: {
            provider: "openai",
            model: "gpt-test",
            workspaceRoot: await realpath(workspace),
            approvalMode: "on-request",
            instructionsSha256: "0".repeat(64),
            repositoryInstructions: [],
          },
        }),
      );
      await artifactLog.append(
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 1,
          timestamp: "2026-09-27T00:00:01.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "artifact.recorded",
          payload: { callId: "artifact-call", name: "read_file", artifact },
        }),
      );
      const largeAnswer = "x".repeat(70_000);
      const replayEvents = [
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 0,
          timestamp: "2026-09-27T00:00:00.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "turn.started",
          payload: {},
        }),
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 1,
          timestamp: "2026-09-27T00:00:01.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "assistant.delta",
          payload: { text: `private path ${workspace}` },
        }),
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 2,
          timestamp: "2026-09-27T00:00:02.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "assistant.delta",
          payload: { text: largeAnswer },
        }),
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 3,
          timestamp: "2026-09-27T00:00:03.000Z",
          threadId: "thread-1",
          turnId: "turn-1",
          type: "turn.failed",
          payload: { code: "TEST_FAILURE", message: `private ${home}` },
        }),
      ];
      let starts = 0;
      let turnCancelled = false;
      let finishTurn: () => void = () => undefined;
      const application = {
        isRemoteRestricted: true,
        startTurnAfter: async (
          _input: unknown,
          _client: unknown,
          beforeStart: (ids: {
            threadId: string;
            turnId: string;
          }) => Promise<void>,
        ) => {
          starts += 1;
          const ids = {
            threadId: `thread-new-${starts}`,
            turnId: `turn-new-${starts}`,
          };
          await beforeStart(ids);
          const completion = new Promise<void>((resolve) => {
            finishTurn = resolve;
          });
          return {
            ...ids,
            completion,
            cancel: () => {
              turnCancelled = true;
              finishTurn();
              return true;
            },
          };
        },
        getThread: async (threadId: string) => ({
          value:
            threadId === "thread-1"
              ? metadata
              : threadId === "thread-2"
                ? secondMetadata
                : threadId === "thread-other"
                  ? otherMetadata
                  : threadId.startsWith("thread-new-")
                    ? { ...metadata, threadId }
                    : undefined,
          diagnostics: [],
        }),
        readThreadEvents: async (input: {
          afterSequence?: number;
          limit?: number;
        }) => {
          const matching = replayEvents.filter(
            (event) => event.sequence > (input.afterSequence ?? -1),
          );
          const events = matching.slice(0, input.limit ?? 100);
          return {
            events,
            hasEarlier: false,
            hasLater: matching.length > events.length,
          };
        },
        listThreadArtifacts:
          artifactApplication.listThreadArtifacts.bind(artifactApplication),
        readArtifact:
          artifactApplication.readArtifact.bind(artifactApplication),
      } as unknown as KodaApplication;
      const server = await startRemoteHttpsServer({
        application,
        kodaHome: home,
        host: "127.0.0.1",
        port: 0,
        certificatePath,
        privateKeyPath,
      });
      const port = Number(server.address.split(":").at(-1));
      let standingSubscription: WebSocket | undefined;
      let standingClosed: Promise<number> | undefined;
      try {
        const unauthorized = await get(port, certificate, "/v1/workspaces");
        expect(unauthorized.status).toBe(401);
        const allowed = await get(
          port,
          certificate,
          "/v1/workspaces",
          issued.token,
        );
        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({ workspaces: ["project"] });
        expect(JSON.stringify(allowed.body)).not.toContain(workspace);
        const firstThreadPage = await get(
          port,
          certificate,
          "/v1/workspaces/project/threads?limit=1",
          issued.token,
        );
        expect(firstThreadPage.body).toMatchObject({
          threads: [{ threadId: "thread-1", workspaceId: "project" }],
          hasMore: true,
          nextAfterThreadId: "thread-1",
        });
        expect(JSON.stringify(firstThreadPage.body)).not.toContain(home);
        const secondThreadPage = await get(
          port,
          certificate,
          "/v1/workspaces/project/threads?after=thread-1&limit=1",
          issued.token,
        );
        expect(secondThreadPage.body).toMatchObject({
          threads: [{ threadId: "thread-2" }],
          hasMore: false,
          nextAfterThreadId: "thread-2",
        });
        expect(JSON.stringify(secondThreadPage.body)).not.toContain(
          "thread-other",
        );
        const otherThreadList = await get(
          port,
          certificate,
          "/v1/workspaces/other/threads",
          issued.token,
        );
        expect(otherThreadList.status).toBe(404);
        const deniedThreadList = await get(
          port,
          certificate,
          "/v1/workspaces/project/threads",
          readOnly.token,
        );
        expect(deniedThreadList.status).toBe(404);
        const invalidThreadCursor = await get(
          port,
          certificate,
          "/v1/workspaces/project/threads?limit=1&limit=2",
          issued.token,
        );
        expect(invalidThreadCursor.status).toBe(400);
        const thread = await get(
          port,
          certificate,
          "/v1/threads/thread-1",
          issued.token,
        );
        expect(thread.status).toBe(200);
        expect(thread.body).toMatchObject({
          threadId: "thread-1",
          workspaceId: "project",
        });
        expect(JSON.stringify(thread.body)).not.toContain(home);
        expect(JSON.stringify(thread.body)).not.toContain("private diagnostic");
        const listedArtifacts = await get(
          port,
          certificate,
          "/v1/threads/thread-1/artifacts?limit=1",
          issued.token,
        );
        expect(listedArtifacts).toEqual({
          status: 200,
          body: {
            artifacts: [{ sequence: 1, artifact }],
            hasEarlier: false,
            nextBeforeSequence: null,
          },
        });
        expect(JSON.stringify(listedArtifacts.body)).not.toContain(workspace);
        expect(JSON.stringify(listedArtifacts.body)).not.toContain(
          "artifact-call",
        );
        const artifactPath = `/v1/threads/thread-1/artifacts/${artifact.id}`;
        const firstArtifactRange = await get(
          port,
          certificate,
          `${artifactPath}?afterByte=0&maxBytes=8`,
          issued.token,
        );
        expect(firstArtifactRange).toMatchObject({
          status: 200,
          body: { artifact, startByte: 0, hasEarlier: false, hasLater: true },
        });
        expect(JSON.stringify(firstArtifactRange.body)).not.toContain(
          workspace,
        );
        expect(
          (await get(port, certificate, artifactPath, readOnly.token)).status,
        ).toBe(404);
        expect(
          (
            await get(
              port,
              certificate,
              `/v1/threads/thread-other/artifacts/${artifact.id}`,
              issued.token,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await get(
              port,
              certificate,
              `${artifactPath}?afterByte=0&beforeByte=8`,
              issued.token,
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await get(
              port,
              certificate,
              "/v1/threads/thread-1/artifacts?limit=1&limit=2",
              issued.token,
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await get(
              port,
              certificate,
              `/v1/threads/thread-1/artifacts/sha256:${"f".repeat(64)}`,
              issued.token,
            )
          ).status,
        ).toBe(404);
        const firstEvents = await get(
          port,
          certificate,
          "/v1/threads/thread-1/events?after=-1&limit=1",
          issued.token,
        );
        expect(firstEvents.body).toMatchObject({
          events: [{ sequence: 0, type: "turn.started" }],
          hasMore: true,
          nextAfterSequence: 0,
        });
        const resumedEvents = await get(
          port,
          certificate,
          "/v1/threads/thread-1/events?after=0&limit=1",
          issued.token,
        );
        expect(resumedEvents.body).toMatchObject({
          events: [{ sequence: 1, type: "assistant.delta" }],
          hasMore: true,
          nextAfterSequence: 1,
        });
        expect(JSON.stringify(resumedEvents.body)).not.toContain(workspace);
        expect(JSON.stringify(resumedEvents.body)).not.toContain(
          "private path",
        );
        const firstUpdates = await get(
          port,
          certificate,
          "/v1/threads/thread-1/updates?after=-1&limit=1",
          issued.token,
        );
        expect(firstUpdates.body).toEqual({
          events: [],
          hasMore: true,
          nextAfterSequence: 0,
        });
        const answer = await get(
          port,
          certificate,
          "/v1/threads/thread-1/updates?after=0&limit=1",
          issued.token,
        );
        expect(answer.body).toMatchObject({
          events: [
            {
              sequence: 1,
              type: "assistant.delta",
              text: `private path ${workspace}`,
            },
          ],
          hasMore: true,
          nextAfterSequence: 1,
        });
        const largeUpdate = await get(
          port,
          certificate,
          "/v1/threads/thread-1/updates?after=1&limit=1",
          issued.token,
        );
        expect(largeUpdate.status).toBe(200);
        expect(largeUpdate.body).toMatchObject({
          events: [{ sequence: 2, type: "assistant.delta", text: largeAnswer }],
          hasMore: true,
          nextAfterSequence: 2,
        });
        const failed = await get(
          port,
          certificate,
          "/v1/threads/thread-1/updates?after=2",
          issued.token,
        );
        expect(failed.body).toMatchObject({
          events: [{ sequence: 3, type: "turn.failed", code: "TEST_FAILURE" }],
          hasMore: false,
          nextAfterSequence: 3,
        });
        expect(JSON.stringify(failed.body)).not.toContain(home);
        const subscriptionUrl = `wss://127.0.0.1:${port}/v1/threads/thread-1/subscribe`;
        const unauthenticatedSubscription = new WebSocket(
          `${subscriptionUrl}?after=-1`,
          { ca: certificate },
        );
        await expect(
          openWebSocket(unauthenticatedSubscription),
        ).rejects.toThrow("Unexpected server response: 401");
        const deniedSubscription = new WebSocket(
          `${subscriptionUrl}?after=-1`,
          {
            ca: certificate,
            headers: { authorization: `Bearer ${readOnly.token}` },
          },
        );
        await expect(openWebSocket(deniedSubscription)).rejects.toThrow(
          "Unexpected server response: 404",
        );
        const firstSubscription = new WebSocket(
          `${subscriptionUrl}?after=0&limit=1`,
          {
            ca: certificate,
            headers: { authorization: `Bearer ${issued.token}` },
          },
        );
        const firstFrames = collectWebSocketFrames(firstSubscription, 6);
        await openWebSocket(firstSubscription);
        expect(await firstFrames).toMatchObject([
          {
            kind: "update",
            event: { sequence: 1, text: `private path ${workspace}` },
          },
          { kind: "cursor", nextAfterSequence: 1 },
          { kind: "update", event: { sequence: 2, text: largeAnswer } },
          { kind: "cursor", nextAfterSequence: 2 },
          { kind: "update", event: { sequence: 3, code: "TEST_FAILURE" } },
          { kind: "cursor", nextAfterSequence: 3 },
        ]);
        const firstClosed = new Promise<void>((resolveClose) =>
          firstSubscription.once("close", () => resolveClose()),
        );
        firstSubscription.close();
        await firstClosed;
        const resumedSubscription = new WebSocket(
          `${subscriptionUrl}?after=1&limit=1`,
          {
            ca: certificate,
            headers: { authorization: `Bearer ${issued.token}` },
          },
        );
        const resumedFrames = collectWebSocketFrames(resumedSubscription, 4);
        await openWebSocket(resumedSubscription);
        expect(await resumedFrames).toMatchObject([
          { kind: "update", event: { sequence: 2, text: largeAnswer } },
          { kind: "cursor", nextAfterSequence: 2 },
          { kind: "update", event: { sequence: 3, code: "TEST_FAILURE" } },
          { kind: "cursor", nextAfterSequence: 3 },
        ]);
        expect(turnCancelled).toBe(false);
        const secondSubscription = new WebSocket(`${subscriptionUrl}?after=3`, {
          ca: certificate,
          headers: { authorization: `Bearer ${observer.token}` },
        });
        await openWebSocket(secondSubscription);
        const liveFrames = collectWebSocketFrames(resumedSubscription, 3);
        const secondLiveFrames = collectWebSocketFrames(secondSubscription, 2);
        replayEvents.push(
          agentEventSchema.parse({
            schemaVersion: 1,
            sequence: 4,
            timestamp: "2026-09-27T00:00:04.000Z",
            threadId: "thread-1",
            turnId: "turn-2",
            type: "turn.started",
            payload: {},
          }),
          agentEventSchema.parse({
            schemaVersion: 1,
            sequence: 5,
            timestamp: "2026-09-27T00:00:05.000Z",
            threadId: "thread-1",
            turnId: "turn-2",
            type: "assistant.delta",
            payload: { text: "Live answer." },
          }),
        );
        expect(await liveFrames).toMatchObject([
          { kind: "cursor", nextAfterSequence: 4 },
          { kind: "update", event: { sequence: 5, text: "Live answer." } },
          { kind: "cursor", nextAfterSequence: 5 },
        ]);
        expect(await secondLiveFrames).toMatchObject([
          { kind: "update", event: { sequence: 5, text: "Live answer." } },
          { kind: "cursor", nextAfterSequence: 5 },
        ]);
        const badCursor = await get(
          port,
          certificate,
          "/v1/threads/thread-1/events?after=0&after=1",
          issued.token,
        );
        expect(badCursor.status).toBe(400);
        const deniedThread = await get(
          port,
          certificate,
          "/v1/threads/thread-1",
          readOnly.token,
        );
        expect(deniedThread.status).toBe(404);
        const deniedEvents = await get(
          port,
          certificate,
          "/v1/threads/thread-1/events?after=-1",
          readOnly.token,
        );
        expect(deniedEvents.status).toBe(404);
        const deniedUpdates = await get(
          port,
          certificate,
          "/v1/threads/thread-1/updates?after=-1",
          readOnly.token,
        );
        expect(deniedUpdates.status).toBe(404);
        await writeFile(
          join(
            home,
            "artifacts",
            "sha256",
            artifact.sha256.slice(0, 2),
            artifact.sha256,
          ),
          "x".repeat(artifact.bytes),
        );
        const corruptedArtifact = await get(
          port,
          certificate,
          artifactPath,
          issued.token,
        );
        expect(corruptedArtifact).toEqual({
          status: 500,
          body: { error: "Internal error" },
        });
        const missing = await get(
          port,
          certificate,
          "/v1/threads/unknown",
          issued.token,
        );
        expect(missing.status).toBe(404);
        const turnBody = {
          requestId: "a".repeat(32),
          prompt: "Explain this workspace.",
        };
        const deniedStart = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          readOnly.token,
          turnBody,
        );
        expect(deniedStart.status).toBe(404);
        const started = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          issued.token,
          turnBody,
        );
        expect(started.status).toBe(202);
        expect(started.body).toMatchObject({
          threadId: "thread-new-1",
          turnId: "turn-new-1",
          replayed: false,
        });
        expect(await bindings.get("thread-new-1")).toMatchObject({
          workspaceId: "project",
        });
        expect(turnCancelled).toBe(false);
        const retried = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          issued.token,
          turnBody,
        );
        expect(retried.status).toBe(202);
        expect(retried.body).toMatchObject({
          threadId: "thread-new-1",
          replayed: true,
        });
        expect(starts).toBe(1);
        const conflict = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          issued.token,
          { ...turnBody, prompt: "Different prompt." },
        );
        expect(conflict.status).toBe(409);
        const crossDevice = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          secondWriter.token,
          turnBody,
        );
        expect(crossDevice.status).toBe(409);
        expect(JSON.stringify(crossDevice.body)).not.toContain("thread-new-1");
        const invalid = await post(
          port,
          certificate,
          "/v1/workspaces/project/turns",
          issued.token,
          { requestId: "b".repeat(32), prompt: "x".repeat(8_193) },
        );
        expect(invalid.status).toBe(400);
        expect(starts).toBe(1);
        const cancelPath = "/v1/threads/thread-new-1/turns/turn-new-1/cancel";
        expect(
          (await post(port, certificate, cancelPath, issued.token)).status,
        ).toBe(404);
        expect(
          (await post(port, certificate, cancelPath, controlDevice.token, {}))
            .status,
        ).toBe(400);
        expect(
          (
            await post(
              port,
              certificate,
              "/v1/threads/thread-2/turns/turn-new-1/cancel",
              controlDevice.token,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await post(
              port,
              certificate,
              "/v1/threads/thread-other/turns/turn-new-1/cancel",
              controlDevice.token,
            )
          ).status,
        ).toBe(404);
        expect(turnCancelled).toBe(false);
        const cancelled = await post(
          port,
          certificate,
          cancelPath,
          controlDevice.token,
        );
        expect(cancelled).toEqual({
          status: 202,
          body: { status: "cancel_requested" },
        });
        expect(turnCancelled).toBe(true);
        const revokedSubscription = new Promise<number>((resolveClose) =>
          resumedSubscription.once("close", (code) => resolveClose(code)),
        );
        await devices.revoke(issued.deviceId);
        expect(await revokedSubscription).toBe(1008);
        const remainingFrames = collectWebSocketFrames(secondSubscription, 2);
        replayEvents.push(
          agentEventSchema.parse({
            schemaVersion: 1,
            sequence: 6,
            timestamp: "2026-09-27T00:00:06.000Z",
            threadId: "thread-1",
            turnId: "turn-2",
            type: "assistant.delta",
            payload: { text: "Other device remains connected." },
          }),
        );
        expect(await remainingFrames).toMatchObject([
          {
            kind: "update",
            event: { sequence: 6, text: "Other device remains connected." },
          },
          { kind: "cursor", nextAfterSequence: 6 },
        ]);
        const secondClosed = new Promise<void>((resolveClose) =>
          secondSubscription.once("close", () => resolveClose()),
        );
        secondSubscription.close();
        await secondClosed;
        const revoked = await get(
          port,
          certificate,
          "/v1/workspaces",
          issued.token,
        );
        expect(revoked.status).toBe(401);
        expect(turnCancelled).toBe(true);
        await expect(
          get(port, undefined, "/v1/workspaces", issued.token),
        ).rejects.toThrow();
        standingSubscription = new WebSocket(
          `wss://127.0.0.1:${port}/v1/threads/thread-1/subscribe?after=5`,
          {
            ca: certificate,
            headers: { authorization: `Bearer ${observer.token}` },
          },
        );
        await openWebSocket(standingSubscription);
        standingClosed = new Promise<number>((resolveClose) =>
          standingSubscription?.once("close", (code) => resolveClose(code)),
        );
        for (let index = 0; index < 7; index += 1) {
          const extra = new WebSocket(
            `wss://127.0.0.1:${port}/v1/threads/thread-1/subscribe?after=5`,
            {
              ca: certificate,
              headers: { authorization: `Bearer ${observer.token}` },
            },
          );
          await openWebSocket(extra);
        }
        const overCapacity = new WebSocket(
          `wss://127.0.0.1:${port}/v1/threads/thread-1/subscribe?after=5`,
          {
            ca: certificate,
            headers: { authorization: `Bearer ${observer.token}` },
          },
        );
        await expect(openWebSocket(overCapacity)).rejects.toThrow(
          "Unexpected server response: 503",
        );
      } finally {
        await server.close();
      }
      await standingClosed;
      expect(standingSubscription?.readyState).toBe(WebSocket.CLOSED);
      expect(turnCancelled).toBe(true);
      const controller = new AbortController();
      let serveOutput = "";
      const serveExit = await runRemoteServeCommand(
        {
          host: "127.0.0.1",
          port: "0",
          certificatePath,
          privateKeyPath,
        },
        {
          environment: { KODA_HOME: home },
          processDirectory: workspace,
          stdout: {
            write: (value) => {
              serveOutput += value;
              controller.abort();
            },
          },
          stderr: { write: () => undefined },
        },
        controller.signal,
      );
      expect(serveExit).toBe(0);
      expect(serveOutput).toContain("Remote HTTPS listening");
      expect(serveOutput).toContain(
        `Certificate SHA-256: ${new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase()}`,
      );
      await chmod(privateKeyPath, 0o644);
      await expect(
        startRemoteHttpsServer({
          application,
          kodaHome: home,
          host: "127.0.0.1",
          port: 0,
          certificatePath,
          privateKeyPath,
        }),
      ).rejects.toThrow("private key file is unsafe");
    });

    it("refuses public and wildcard bind addresses before opening a socket", async () => {
      const application = new KodaApplication({
        environment: {},
        processDirectory: process.cwd(),
      });
      for (const host of ["0.0.0.0", "8.8.8.8", "::", "localhost"]) {
        await expect(
          startRemoteHttpsServer({
            application,
            kodaHome: process.cwd(),
            host,
            port: 0,
            certificatePath: "unused",
            privateKeyPath: "unused",
          }),
        ).rejects.toThrow("private, VPN, or loopback");
      }
    });
  },
);

async function get(
  port: number,
  ca: Buffer | undefined,
  path: string,
  token?: string,
): Promise<{ status: number | undefined; body: unknown }> {
  return requestJson(port, ca, path, "GET", token);
}

async function post(
  port: number,
  ca: Buffer,
  path: string,
  token: string,
  body?: object,
): Promise<{ status: number | undefined; body: unknown }> {
  return requestJson(port, ca, path, "POST", token, body);
}

async function requestJson(
  port: number,
  ca: Buffer | undefined,
  path: string,
  method: "GET" | "POST",
  token?: string,
  body?: object,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const content = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        ...(ca === undefined ? {} : { ca }),
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(content === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          try {
            resolveRequest({
              status: incoming.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            rejectRequest(error);
          }
        });
        incoming.on("error", rejectRequest);
      },
    );
    outgoing.on("error", rejectRequest);
    outgoing.end(content);
  });
}

async function openWebSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
}

function collectWebSocketFrames(
  socket: WebSocket,
  count: number,
): Promise<unknown[]> {
  return new Promise((resolveFrames, rejectFrames) => {
    const frames: unknown[] = [];
    const timeout = setTimeout(
      () => rejectFrames(new Error("WebSocket timed out.")),
      5_000,
    );
    socket.on("message", (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length === count) {
        clearTimeout(timeout);
        resolveFrames(frames);
      }
    });
    socket.once("error", rejectFrames);
  });
}
