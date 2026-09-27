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
import { threadMetadataSchema } from "@koda/protocol";
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
          permissions: ["workspace:read", "thread:read"],
        },
      ]);
      const readOnly = await devices.issue("tablet", [
        { workspaceId: "project", permissions: ["workspace:read"] },
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
      const application = {
        getThread: async () => ({ value: metadata, diagnostics: [] }),
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
        const deniedThread = await get(
          port,
          certificate,
          "/v1/threads/thread-1",
          readOnly.token,
        );
        expect(deniedThread.status).toBe(404);
        const missing = await get(
          port,
          certificate,
          "/v1/threads/unknown",
          issued.token,
        );
        expect(missing.status).toBe(404);
        await devices.revoke(issued.deviceId);
        const revoked = await get(
          port,
          certificate,
          "/v1/workspaces",
          issued.token,
        );
        expect(revoked.status).toBe(401);
        await expect(
          get(port, undefined, "/v1/workspaces", issued.token),
        ).rejects.toThrow();
      } finally {
        await server.close();
      }
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
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        ...(ca === undefined ? {} : { ca }),
        headers:
          token === undefined ? {} : { authorization: `Bearer ${token}` },
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
    outgoing.end();
  });
}
