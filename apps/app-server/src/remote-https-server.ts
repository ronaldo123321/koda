import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ConfigurationError, type KodaApplication } from "@koda/app";
import type { AgentEvent } from "@koda/protocol";
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
  RemoteTurnRequestStore,
} from "./remote-turn-request-store.js";
import { RemoteWorkspaceStore } from "./remote-workspace-store.js";

const OWNER_ID = "owner";
const MAX_URL_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_UPDATE_RESPONSE_BYTES = 3 * 1_024 * 1_024;
const MAX_REQUEST_BYTES = 16 * 1_024;
const turnStartSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{32}$/u),
    prompt: z.string().trim().min(1).max(8_192),
    resumeThreadId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
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
  const [devices, workspaces, threads, requests] = await Promise.all([
    RemoteDeviceStore.open(options.kodaHome, OWNER_ID),
    RemoteWorkspaceStore.open(options.kodaHome, OWNER_ID),
    RemoteThreadStore.open(options.kodaHome, OWNER_ID),
    RemoteTurnRequestStore.open(options.kodaHome, OWNER_ID),
  ]);
  const turnHost = new RemoteTurnHost(options.application, threads, requests);
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
  server.on("upgrade", (_request, socket) => socket.destroy());

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
    close: async () => {
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
    if (!request.url.startsWith("/") || url.hash !== "") {
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
      });
      send(response, result.status === "reserved" ? 409 : 202, result);
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
    const match =
      /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\/(?:events|updates))?$/u.exec(
        url.pathname,
      );
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
      if (match[2] === "/events" || match[2] === "/updates") {
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
        const events = updates
          ? page.events.flatMap(projectRemoteUpdate)
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
          updates ? MAX_UPDATE_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
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
): { after: number; limit: number } | undefined {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") return undefined;
  }
  if (
    url.searchParams.getAll("after").length > 1 ||
    url.searchParams.getAll("limit").length > 1
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
