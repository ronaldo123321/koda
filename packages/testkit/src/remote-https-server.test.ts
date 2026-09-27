import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import { afterEach, describe, expect, it } from "vitest";

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
      directories.push(home, workspace);
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
      const secondWriter = await devices.issue("laptop", [
        {
          workspaceId: "project",
          permissions: ["workspace:read", "turn:start"],
        },
      ]);
      const bindings = await RemoteThreadStore.open(home, "owner");
      await bindings.bind({
        ownerId: "owner",
        workspaceId: "project",
        threadId: "thread-1",
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
        getThread: async () => ({ value: metadata, diagnostics: [] }),
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
          "/v1/threads/thread-1/events?after=0",
          issued.token,
        );
        expect(resumedEvents.body).toMatchObject({
          events: [{ sequence: 1, type: "assistant.delta" }],
          hasMore: false,
          nextAfterSequence: 1,
        });
        expect(JSON.stringify(resumedEvents.body)).not.toContain(workspace);
        expect(JSON.stringify(resumedEvents.body)).not.toContain(
          "private path",
        );
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
        await devices.revoke(issued.deviceId);
        const revoked = await get(
          port,
          certificate,
          "/v1/workspaces",
          issued.token,
        );
        expect(revoked.status).toBe(401);
        expect(turnCancelled).toBe(false);
        await expect(
          get(port, undefined, "/v1/workspaces", issued.token),
        ).rejects.toThrow();
      } finally {
        await server.close();
      }
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
  body: object,
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
