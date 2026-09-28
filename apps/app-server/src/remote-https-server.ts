import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  ArtifactInspectionError,
  ConfigurationError,
  type KodaApplication,
} from "@koda/app";
import { threadIdSchema, type AgentEvent } from "@koda/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { z, ZodError } from "zod";

import {
  RemoteAccessCatalog,
  RemoteAccessDeniedError,
  type RemoteThreadSummary,
} from "./remote-access.js";
import { RemoteDeviceStore } from "./remote-device-store.js";
import { RemoteThreadStore } from "./remote-thread-store.js";
import {
  RemoteTurnHost,
  RemoteTurnHostCapacityError,
} from "./remote-turn-host.js";
import {
  RemoteTurnRequestConflictError,
  RemoteTurnRequestBusyError,
  RemoteTurnRequestStore,
} from "./remote-turn-request-store.js";
import { RemoteWorkspaceStore } from "./remote-workspace-store.js";

const OWNER_ID = "owner";
const MAX_URL_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_UPDATE_RESPONSE_BYTES = 3 * 1_024 * 1_024;
const MAX_ARTIFACT_RESPONSE_BYTES = 128 * 1_024;
const MAX_WS_FRAME_BYTES = 512 * 1_024;
const MAX_WS_BUFFER_BYTES = 2 * 1_024 * 1_024;
const MAX_SUBSCRIPTIONS = 8;
const MAX_REQUEST_BYTES = 16 * 1_024;
const turnStartSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{32}$/u),
    prompt: z.string().trim().min(1).max(8_192),
    resumeThreadId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
    effects: z
      .array(z.enum(["workspace:mutate", "process:control", "mcp:invoke"]))
      .min(1)
      .max(3)
      .refine((effects) => new Set(effects).size === effects.length)
      .optional(),
  })
  .strict();
const approvalResolutionSchema = z
  .object({
    turnId: z.string().min(1).max(128),
    callId: z.string().min(1).max(256),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();

export interface RemoteHttpsServerOptions {
  application: KodaApplication;
  kodaHome: string;
  host: string;
  port: number;
  certificatePath: string;
  privateKeyPath: string;
}

export interface RunningRemoteHttpsServer {
  address: string;
  certificateSha256: string;
  close(): Promise<void>;
}

export async function startRemoteHttpsServer(
  options: RemoteHttpsServerOptions,
): Promise<RunningRemoteHttpsServer> {
  if (!isAllowedHost(options.host)) {
    throw new Error(
      "Remote host must be a literal private, VPN, or loopback IP address.",
    );
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("Remote port is invalid.");
  }
  const [certificate, privateKey] = await Promise.all([
    readFile(resolve(options.certificatePath)),
    readPrivateKey(options.privateKeyPath),
  ]);
  const certificateSha256 = new X509Certificate(certificate).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  const [devices, workspaces, threads, requests] = await Promise.all([
    RemoteDeviceStore.open(options.kodaHome, OWNER_ID),
    RemoteWorkspaceStore.open(options.kodaHome, OWNER_ID),
    RemoteThreadStore.open(options.kodaHome, OWNER_ID),
    RemoteTurnRequestStore.open(options.kodaHome, OWNER_ID),
  ]);
  const turnHost = new RemoteTurnHost(options.application, threads, requests);
  const subscriptions = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1_024,
  });
  let pendingSubscriptions = 0;
  let closingSubscriptions = false;
  const server = createServer(
    {
      cert: certificate,
      key: privateKey,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8 * 1_024,
    },
    (request, response) => {
      void handleRequest(
        request,
        response,
        options.application,
        devices,
        workspaces,
        threads,
        turnHost,
      );
    },
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 32;
  server.on("upgrade", (request, socket, head) => {
    if (closingSubscriptions) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (
      subscriptions.clients.size + pendingSubscriptions >=
      MAX_SUBSCRIPTIONS
    ) {
      rejectUpgrade(socket, 503);
      return;
    }
    pendingSubscriptions += 1;
    void acceptSubscription(
      request,
      socket,
      head,
      subscriptions,
      options.application,
      devices,
      workspaces,
      threads,
    ).finally(() => {
      pendingSubscriptions -= 1;
    });
  });

  try {
    await listen(server, options.host, options.port);
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Remote HTTPS listener has no TCP address.");
  }
  return {
    address: `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    certificateSha256,
    close: async () => {
      closingSubscriptions = true;
      for (const client of subscriptions.clients) client.terminate();
      await new Promise<void>((resolveClose) =>
        subscriptions.close(() => resolveClose()),
      );
      const closing = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      });
      server.closeAllConnections();
      await closing;
      await turnHost.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  application: KodaApplication,
  devices: RemoteDeviceStore,
  workspaces: RemoteWorkspaceStore,
  threads: RemoteThreadStore,
  turnHost: RemoteTurnHost,
): Promise<void> {
  try {
    const authorization = bearerToken(request);
    if (authorization === undefined) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    let verified;
    try {
      verified = await devices.verify(authorization);
    } catch (error) {
      if (!(error instanceof RemoteAccessDeniedError)) throw error;
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.url === undefined || request.url.length > MAX_URL_LENGTH) {
      send(response, 400, { error: "Invalid request" });
      return;
    }
    const url = new URL(request.url, "https://localhost");
    if (
      !request.url.startsWith("/") ||
      request.url.startsWith("//") ||
      url.hash !== ""
    ) {
      send(response, 404, { error: "Unavailable" });
      return;
    }
    const definitions = await workspaces.list();
    const catalog = await RemoteAccessCatalog.create(
      OWNER_ID,
      definitions,
      verified.grants,
    );
    const startMatch =
      /^\/v1\/workspaces\/([a-z][a-z0-9-]{0,63})\/turns$/u.exec(url.pathname);
    if (request.method === "POST" && startMatch !== null && url.search === "") {
      const workspaceId = startMatch[1];
      if (workspaceId === undefined) throw new RemoteInvalidRequestError();
      const body = turnStartSchema.parse(await readJsonBody(request));
      const result = await turnHost.start(verified.principal, catalog, {
        workspaceId,
        requestId: body.requestId,
        prompt: body.prompt,
        ...(body.resumeThreadId === undefined
          ? {}
          : { resumeThreadId: body.resumeThreadId }),
        ...(body.effects === undefined ? {} : { effects: body.effects }),
      });
      send(response, result.status === "started" ? 202 : 409, result);
      return;
    }
    const cancelMatch =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/turns\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/cancel$/u.exec(
        url.pathname,
      );
    if (
      request.method === "POST" &&
      cancelMatch !== null &&
      url.search === ""
    ) {
      if (
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      ) {
        send(response, 400, { error: "Invalid request" });
        return;
      }
      const threadId = cancelMatch[1];
      const turnId = cancelMatch[2];
      if (threadId === undefined || turnId === undefined)
        throw new RemoteInvalidRequestError();
      const cancelled = await turnHost.cancel(
        verified.principal,
        catalog,
        threadId,
        turnId,
      );
      send(
        response,
        cancelled ? 202 : 404,
        cancelled ? { status: "cancel_requested" } : { error: "Unavailable" },
      );
      return;
    }
    const approvalResolveMatch =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/approvals\/resolve$/u.exec(
        url.pathname,
      );
    if (
      request.method === "POST" &&
      approvalResolveMatch !== null &&
      url.search === ""
    ) {
      const threadId = approvalResolveMatch[1];
      if (threadId === undefined) throw new RemoteInvalidRequestError();
      const body = approvalResolutionSchema.parse(await readJsonBody(request));
      const resolved = await turnHost.resolveApproval(
        verified.principal,
        catalog,
        threadId,
        body.turnId,
        body.callId,
        body.decision,
      );
      send(
        response,
        resolved ? 202 : 404,
        resolved ? { status: "resolved" } : { error: "Unavailable" },
      );
      return;
    }
    if (
      request.method !== "GET" ||
      request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      send(response, 400, { error: "Invalid request" });
      return;
    }
    if (url.pathname === "/v1/workspaces" && url.search === "") {
      const ids: string[] = [];
      for (const grant of verified.grants) {
        try {
          await catalog.authorizeWorkspace(
            verified.principal,
            grant.workspaceId,
            "workspace:read",
          );
          ids.push(grant.workspaceId);
        } catch (error) {
          if (!(error instanceof RemoteAccessDeniedError)) throw error;
        }
      }
      send(response, 200, { workspaces: ids.sort() });
      return;
    }
    const approvalsMatch =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/approvals$/u.exec(
        url.pathname,
      );
    if (approvalsMatch !== null && url.search === "") {
      const threadId = approvalsMatch[1];
      if (threadId === undefined) throw new RemoteInvalidRequestError();
      const approvals = await turnHost.listApprovals(
        verified.principal,
        catalog,
        threadId,
      );
      send(response, 200, { approvals }, MAX_UPDATE_RESPONSE_BYTES);
      return;
    }
    const listMatch =
      /^\/v1\/workspaces\/([a-z][a-z0-9-]{0,63})\/threads$/u.exec(url.pathname);
    if (listMatch !== null) {
      const workspaceId = listMatch[1];
      if (workspaceId === undefined) throw new RemoteInvalidRequestError();
      await catalog.authorizeWorkspace(
        verified.principal,
        workspaceId,
        "thread:read",
      );
      const cursor = parseThreadCursor(url);
      if (cursor === undefined) {
        send(response, 400, { error: "Invalid thread cursor" });
        return;
      }
      const visible: RemoteThreadSummary[] = [];
      for (const binding of await threads.list(workspaceId)) {
        if (cursor.after !== undefined && binding.threadId <= cursor.after)
          continue;
        const metadata = (await application.getThread(binding.threadId)).value;
        if (metadata === undefined) continue;
        try {
          visible.push(
            await catalog.projectThread(verified.principal, binding, metadata),
          );
        } catch (error) {
          if (!(error instanceof RemoteAccessDeniedError)) throw error;
          continue;
        }
        if (visible.length > cursor.limit) break;
      }
      const hasMore = visible.length > cursor.limit;
      const page = visible.slice(0, cursor.limit);
      send(response, 200, {
        threads: page,
        hasMore,
        nextAfterThreadId: page.at(-1)?.threadId ?? cursor.after ?? null,
      });
      return;
    }
    const match =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/(?:events|updates|activity))?$/u.exec(
        url.pathname,
      );
    const artifactsMatch =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/artifacts(?:\/(sha256:[a-f0-9]{64}))?$/u.exec(
        url.pathname,
      );
    if (artifactsMatch !== null) {
      const threadIdText = artifactsMatch[1];
      if (threadIdText === undefined) throw new RemoteInvalidRequestError();
      const threadId = threadIdSchema.parse(threadIdText);
      const root = await catalog.authorizeThread(
        verified.principal,
        await threads.get(threadId),
        "thread:read",
      );
      const metadata = (await application.getThread(threadId)).value;
      if (metadata?.workspaceRoot !== root) {
        send(response, 404, { error: "Unavailable" });
        return;
      }
      const artifactId = artifactsMatch[2];
      if (artifactId === undefined) {
        const cursor = parseArtifactListCursor(url);
        if (cursor === undefined) throw new RemoteInvalidRequestError();
        const result = await application.listThreadArtifacts({
          workspace: root,
          threadId,
          ...cursor,
        });
        send(response, 200, {
          artifacts: result.artifacts.map(({ sequence, artifact }) => ({
            sequence,
            artifact,
          })),
          hasEarlier: result.hasEarlier,
          nextBeforeSequence: result.nextBeforeSequence ?? null,
        });
      } else {
        const cursor = parseArtifactReadCursor(url);
        if (cursor === undefined) throw new RemoteInvalidRequestError();
        const result = await application.readArtifact({
          workspace: root,
          threadId,
          artifactId,
          ...cursor,
        });
        send(
          response,
          200,
          {
            artifact: result.artifact,
            content: result.content,
            startByte: result.startByte,
            endByte: result.endByte,
            totalBytes: result.totalBytes,
            hasEarlier: result.hasEarlier,
            hasLater: result.hasLater,
          },
          MAX_ARTIFACT_RESPONSE_BYTES,
        );
      }
      return;
    }
    if (match !== null) {
      const threadId = match[1];
      if (threadId === undefined) {
        send(response, 404, { error: "Unavailable" });
        return;
      }
      const binding = await threads.get(threadId);
      const root = await catalog.authorizeThread(
        verified.principal,
        binding,
        "thread:read",
      );
      const metadata = (await application.getThread(threadId)).value;
      if (metadata === undefined || metadata.workspaceRoot !== root) {
        send(response, 404, { error: "Unavailable" });
        return;
      }
      if (
        match[2] === "/events" ||
        match[2] === "/updates" ||
        match[2] === "/activity"
      ) {
        const cursor = parseEventCursor(url);
        if (cursor === undefined) {
          send(response, 400, { error: "Invalid event cursor" });
          return;
        }
        const page = await application.readThreadEvents({
          threadId,
          afterSequence: cursor.after,
          limit: cursor.limit,
        });
        const updates = match[2] === "/updates";
        const activity = match[2] === "/activity";
        const events = updates
          ? page.events.flatMap(projectRemoteUpdate)
          : activity
            ? page.events.map(projectRemoteActivity)
            : page.events.map((event) => ({
                sequence: event.sequence,
                timestamp: event.timestamp,
                turnId: event.turnId,
                type: event.type,
              }));
        send(
          response,
          200,
          {
            events,
            hasMore: page.hasLater,
            nextAfterSequence: page.events.at(-1)?.sequence ?? cursor.after,
          },
          updates || activity ? MAX_UPDATE_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
        );
        return;
      }
      if (url.search !== "") {
        send(response, 404, { error: "Unavailable" });
        return;
      }
      const summary: RemoteThreadSummary = await catalog.projectThread(
        verified.principal,
        binding,
        metadata,
      );
      send(response, 200, summary);
      return;
    }
    send(response, 404, { error: "Unavailable" });
  } catch (error) {
    if (error instanceof RemoteAccessDeniedError) {
      send(response, 404, { error: "Unavailable" });
    } else if (
      error instanceof ArtifactInspectionError &&
      (error.code === "ARTIFACT_NOT_REFERENCED" ||
        error.code === "THREAD_WORKSPACE_MISMATCH")
    ) {
      send(response, 404, { error: "Unavailable" });
    } else if (error instanceof RemoteTurnRequestBusyError) {
      send(response, 409, { error: "Request in progress" });
    } else if (error instanceof RemoteTurnRequestConflictError) {
      send(response, 409, { error: "Request conflict" });
    } else if (error instanceof RemoteTurnHostCapacityError) {
      send(response, 429, { error: "Turn capacity reached" });
    } else if (
      error instanceof RemoteInvalidRequestError ||
      error instanceof ZodError ||
      error instanceof ConfigurationError
    ) {
      send(response, 400, { error: "Invalid request" });
    } else {
      send(response, 500, { error: "Internal error" });
    }
  }
}

async function acceptSubscription(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  subscriptions: WebSocketServer,
  application: KodaApplication,
  devices: RemoteDeviceStore,
  workspaces: RemoteWorkspaceStore,
  threads: RemoteThreadStore,
): Promise<void> {
  try {
    const token = bearerToken(request);
    if (token === undefined) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (
      request.method !== "GET" ||
      request.url === undefined ||
      request.url.length > MAX_URL_LENGTH ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//") ||
      request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      rejectUpgrade(socket, 400);
      return;
    }
    const url = new URL(request.url, "https://localhost");
    const match =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/subscribe$/u.exec(
        url.pathname,
      );
    const cursor = parseEventCursor(url, true);
    if (match === null || cursor === undefined || url.hash !== "") {
      rejectUpgrade(socket, 404);
      return;
    }
    const threadId = match[1];
    if (threadId === undefined) throw new RemoteInvalidRequestError();
    const verified = await devices.verify(token);
    const catalog = await RemoteAccessCatalog.create(
      OWNER_ID,
      await workspaces.list(),
      verified.grants,
    );
    const root = await catalog.authorizeThread(
      verified.principal,
      await threads.get(threadId),
      "thread:read",
    );
    const metadata = (await application.getThread(threadId)).value;
    if (metadata?.workspaceRoot !== root) throw new RemoteAccessDeniedError();
    subscriptions.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => client.terminate());
      client.on("message", () => client.close(1008));
      void streamSubscription(
        client,
        token,
        threadId,
        cursor.after,
        cursor.limit,
        url.searchParams.get("view") === "activity",
        application,
        devices,
        workspaces,
        threads,
      );
    });
  } catch (error) {
    rejectUpgrade(socket, error instanceof RemoteAccessDeniedError ? 404 : 500);
  }
}

async function streamSubscription(
  client: WebSocket,
  token: string,
  threadId: string,
  initialAfter: number,
  limit: number,
  activity: boolean,
  application: KodaApplication,
  devices: RemoteDeviceStore,
  workspaces: RemoteWorkspaceStore,
  threads: RemoteThreadStore,
): Promise<void> {
  let after = initialAfter;
  try {
    while (client.readyState === WebSocket.OPEN) {
      const verified = await devices.verify(token);
      const catalog = await RemoteAccessCatalog.create(
        OWNER_ID,
        await workspaces.list(),
        verified.grants,
      );
      const root = await catalog.authorizeThread(
        verified.principal,
        await threads.get(threadId),
        "thread:read",
      );
      const metadata = (await application.getThread(threadId)).value;
      if (metadata?.workspaceRoot !== root) throw new RemoteAccessDeniedError();
      const page = await application.readThreadEvents({
        threadId,
        afterSequence: after,
        limit,
      });
      for (const event of page.events) {
        const projected = activity
          ? [projectRemoteActivity(event)]
          : projectRemoteUpdate(event);
        for (const update of projected) {
          if (!sendWebSocket(client, { kind: "update", event: update })) return;
        }
      }
      const last = page.events.at(-1);
      if (last !== undefined) {
        after = last.sequence;
        if (
          !sendWebSocket(client, { kind: "cursor", nextAfterSequence: after })
        )
          return;
      }
      if (!page.hasLater) await waitForSubscription(client);
    }
  } catch (error) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(error instanceof RemoteAccessDeniedError ? 1008 : 1011);
    }
  }
}

function sendWebSocket(client: WebSocket, body: object): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  const content = JSON.stringify(body);
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_WS_FRAME_BYTES) {
    client.close(1009);
    return false;
  }
  if (client.bufferedAmount + bytes > MAX_WS_BUFFER_BYTES) {
    client.close(1013);
    return false;
  }
  client.send(content);
  return true;
}

async function waitForSubscription(client: WebSocket): Promise<void> {
  await new Promise<void>((resolveWait) => {
    const onClose = () => {
      clearTimeout(timer);
      resolveWait();
    };
    const timer = setTimeout(() => {
      client.off("close", onClose);
      resolveWait();
    }, 500);
    client.once("close", onClose);
  });
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.once("error", () => socket.destroy());
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 404
        ? "Not Found"
        : status === 503
          ? "Service Unavailable"
          : status === 500
            ? "Internal Server Error"
            : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

class RemoteInvalidRequestError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new RemoteInvalidRequestError();
  }
  const length = request.headers["content-length"];
  if (
    length !== undefined &&
    (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)
  ) {
    throw new RemoteInvalidRequestError();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new RemoteInvalidRequestError();
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RemoteInvalidRequestError();
  }
}

function parseEventCursor(
  url: URL,
  allowActivityView = false,
): { after: number; limit: number } | undefined {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "after" &&
      key !== "limit" &&
      !(allowActivityView && key === "view")
    )
      return undefined;
  }
  if (
    url.searchParams.getAll("after").length > 1 ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("view").length > 1 ||
    (url.searchParams.has("view") &&
      (!allowActivityView || url.searchParams.get("view") !== "activity"))
  )
    return undefined;
  const afterText = url.searchParams.get("after") ?? "-1";
  const limitText = url.searchParams.get("limit") ?? "100";
  if (!/^(?:-1|0|[1-9]\d*)$/u.test(afterText) || !/^[1-9]\d*$/u.test(limitText))
    return undefined;
  const after = Number(afterText);
  const limit = Number(limitText);
  if (
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(limit) ||
    limit > 100
  )
    return undefined;
  return { after, limit };
}

function parseThreadCursor(
  url: URL,
): { after?: string; limit: number } | undefined {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") return undefined;
  }
  if (
    url.searchParams.getAll("after").length > 1 ||
    url.searchParams.getAll("limit").length > 1
  )
    return undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const limitText = url.searchParams.get("limit") ?? "25";
  if (
    (after !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(after)) ||
    !/^[1-9]\d*$/u.test(limitText)
  )
    return undefined;
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit > 25) return undefined;
  return { ...(after === undefined ? {} : { after }), limit };
}

function parseArtifactListCursor(
  url: URL,
): { beforeSequence?: number; limit: number } | undefined {
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "before" && key !== "limit",
    )
  )
    return undefined;
  if (
    url.searchParams.getAll("before").length > 1 ||
    url.searchParams.getAll("limit").length > 1
  )
    return undefined;
  const before = url.searchParams.get("before");
  const limit = parseBoundedInteger(
    url.searchParams.get("limit") ?? "25",
    1,
    25,
  );
  const beforeSequence =
    before === null
      ? undefined
      : parseBoundedInteger(before, 0, Number.MAX_SAFE_INTEGER);
  if (limit === undefined || (before !== null && beforeSequence === undefined))
    return undefined;
  return { ...(beforeSequence === undefined ? {} : { beforeSequence }), limit };
}

function parseArtifactReadCursor(
  url: URL,
): { beforeByte?: number; afterByte?: number; maxBytes: number } | undefined {
  if (
    [...url.searchParams.keys()].some(
      (key) =>
        key !== "beforeByte" && key !== "afterByte" && key !== "maxBytes",
    )
  )
    return undefined;
  if (
    ["beforeByte", "afterByte", "maxBytes"].some(
      (key) => url.searchParams.getAll(key).length > 1,
    )
  )
    return undefined;
  const before = url.searchParams.get("beforeByte");
  const after = url.searchParams.get("afterByte");
  if (before !== null && after !== null) return undefined;
  const beforeByte =
    before === null
      ? undefined
      : parseBoundedInteger(before, 0, Number.MAX_SAFE_INTEGER);
  const afterByte =
    after === null
      ? undefined
      : parseBoundedInteger(after, 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = parseBoundedInteger(
    url.searchParams.get("maxBytes") ?? "16384",
    4,
    16_384,
  );
  if (
    maxBytes === undefined ||
    (before !== null && beforeByte === undefined) ||
    (after !== null && afterByte === undefined)
  )
    return undefined;
  return {
    ...(beforeByte === undefined ? {} : { beforeByte }),
    ...(afterByte === undefined ? {} : { afterByte }),
    maxBytes,
  };
}

function parseBoundedInteger(
  text: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const headers = request.rawHeaders;
  let token: string | undefined;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() !== "authorization") continue;
    if (token !== undefined) return undefined;
    const match = /^Bearer (koda-r1\.[A-Za-z0-9._-]+)$/u.exec(
      headers[index + 1] ?? "",
    );
    if (match === null) return undefined;
    token = match[1];
  }
  return token;
}

function send(
  response: ServerResponse,
  status: number,
  body: object,
  maximumBytes = MAX_RESPONSE_BYTES,
): void {
  if (response.headersSent || response.destroyed) return;
  const content = JSON.stringify(body);
  if (Buffer.byteLength(content) > maximumBytes) {
    send(response, 500, { error: "Internal error" });
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(content),
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function projectRemoteUpdate(event: AgentEvent): object[] {
  const common = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    turnId: event.turnId,
    type: event.type,
  };
  switch (event.type) {
    case "assistant.delta":
      return [{ ...common, text: event.payload.text }];
    case "turn.completed":
    case "turn.cancelled":
      return [common];
    case "turn.failed":
      return [{ ...common, code: event.payload.code }];
    default:
      return [];
  }
}

function projectRemoteActivity(event: AgentEvent): object {
  const common = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    turnId: event.turnId,
    type: event.type,
  };
  switch (event.type) {
    case "assistant.delta":
      return { ...common, text: event.payload.text };
    case "turn.failed":
      return { ...common, code: event.payload.code };
    case "turn.completed":
      return { ...common, steps: event.payload.steps };
    case "model.usage":
      return { ...common, step: event.payload.step };
    case "item.recorded":
      return { ...common, itemType: event.payload.item.type };
    case "tool.started":
    case "tool.execution_started":
    case "tool.completed":
      return {
        ...common,
        callId: event.payload.callId,
        ...(event.type === "tool.execution_started"
          ? { effect: event.payload.effect }
          : event.type === "tool.completed"
            ? { status: event.payload.status }
            : {}),
      };
    case "process.started":
    case "process.exited":
    case "process.termination_requested":
    case "process.termination_completed":
      return {
        ...common,
        callId: event.payload.callId,
        ...(event.type === "process.exited"
          ? { exitCode: event.payload.exitCode }
          : event.type === "process.termination_completed"
            ? { outcome: event.payload.outcome }
            : {}),
      };
    case "artifact.recorded":
    case "workspace.change_set_prepared":
    case "workspace.change_set_committed":
    case "workspace.change_set_rolled_back":
    case "workspace.change_set_uncertain":
    case "workspace.change_set_resolved":
    case "approval.requested":
    case "approval.resolved":
    case "approval.grant_created":
    case "approval.grant_used":
      return {
        ...common,
        callId: event.payload.callId,
        ...(event.type === "approval.resolved"
          ? { decision: event.payload.decision }
          : {}),
      };
    default:
      return common;
  }
}

async function readPrivateKey(path: string): Promise<Buffer> {
  const handle = await open(
    resolve(path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size > 64 * 1_024
    ) {
      throw new Error("Remote TLS private key file is unsafe.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isAllowedHost(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split(".").map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second !== undefined && second >= 64 && second <= 127)
    );
  }
  if (family === 6) {
    const normalized = host.toLowerCase();
    return (
      normalized === "::1" ||
      /^f[cd]/u.test(normalized) ||
      /^fe[89ab]/u.test(normalized)
    );
  }
  return false;
}

async function listen(
  server: Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}
