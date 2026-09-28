import { createServer } from "node:http";

import { auth, type FetchLike } from "@modelcontextprotocol/client";

import {
  loadMcpConfiguration,
  type LoadMcpConfigurationOptions,
} from "./config.js";
import { McpOAuthProvider } from "./oauth-provider.js";
import { McpOAuthVault } from "./oauth-vault.js";

const MAX_AUTH_RESPONSE_BYTES = 1_048_576;

export interface McpOAuthLoginOptions extends LoadMcpConfigurationOptions {
  signal: AbortSignal;
  onAuthorizationUrl(url: URL): void | Promise<void>;
}

export async function loginMcpOAuthServer(
  serverId: string,
  options: McpOAuthLoginOptions,
): Promise<void> {
  const configuration = await loadMcpConfiguration(options);
  const server = configuration.servers.find((item) => item.id === serverId);
  if (
    server?.transport !== "streamable_http" ||
    server.oauthRedirectUrl === undefined
  ) {
    throw new Error("Configured HTTPS MCP OAuth server is unavailable.");
  }
  const key = options.environment.KODA_MCP_OAUTH_KEY;
  if (key === undefined) {
    throw new Error("KODA_MCP_OAUTH_KEY is required.");
  }
  const vault = await McpOAuthVault.open(options.kodaHome, key);
  const provider = new McpOAuthProvider(
    vault,
    serverId,
    server.url,
    server.oauthRedirectUrl,
    options.onAuthorizationUrl,
    server.oauthClientId,
  );
  const redirect = new URL(server.oauthRedirectUrl);
  const port = Number(redirect.port);
  const callback = createServer();
  let complete: ((value: { code: string; iss?: string }) => void) | undefined;
  const received = new Promise<{ code: string; iss?: string }>((resolve) => {
    complete = resolve;
  });
  let accepted = false;
  let validating = false;
  callback.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", redirect);
      if (
        request.method !== "GET" ||
        request.headers.host !== redirect.host ||
        url.pathname !== redirect.pathname ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length !== 1 ||
        url.searchParams.getAll("iss").length > 1 ||
        accepted ||
        validating
      ) {
        response.writeHead(400).end("Invalid OAuth callback.");
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (code.length === 0 || code.length > 4_096) {
        response.writeHead(400).end("Invalid OAuth callback.");
        return;
      }
      validating = true;
      try {
        await provider.verifyCallback(state);
      } catch {
        validating = false;
        response.writeHead(400).end("Invalid OAuth callback.");
        return;
      }
      validating = false;
      accepted = true;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "Koda received the authorization response. Return to the terminal.",
      );
      complete?.({
        code,
        ...(url.searchParams.has("iss")
          ? { iss: url.searchParams.get("iss") ?? "" }
          : {}),
      });
    })().catch(() => response.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    callback.once("error", reject);
    callback.listen(port, "127.0.0.1", () => {
      callback.removeListener("error", reject);
      resolve();
    });
  });
  try {
    const first = await auth(provider, {
      serverUrl: server.url,
      fetchFn: boundedOAuthFetch,
    });
    if (first === "AUTHORIZED") return;
    const authorization = await waitForCallback(received, options.signal);
    options.signal.throwIfAborted();
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: authorization.code,
      ...(authorization.iss === undefined ? {} : { iss: authorization.iss }),
      fetchFn: boundedOAuthFetch,
    });
    if (result !== "AUTHORIZED") {
      throw new Error("MCP OAuth authorization did not complete.");
    }
  } finally {
    try {
      await provider.clearPending();
    } finally {
      callback.closeAllConnections();
      await new Promise<void>((resolve) => callback.close(() => resolve()));
    }
  }
}

async function waitForCallback(
  received: Promise<{ code: string; iss?: string }>,
  signal: AbortSignal,
): Promise<{ code: string; iss?: string }> {
  signal.throwIfAborted();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP OAuth callback expired.")),
          10 * 60_000,
        );
        onAbort = () => reject(new Error("MCP OAuth authorization cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export async function revokeMcpOAuthServer(
  serverId: string,
  options: LoadMcpConfigurationOptions,
): Promise<"remote_revoked" | "local_only"> {
  const configuration = await loadMcpConfiguration(options);
  const server = configuration.servers.find((item) => item.id === serverId);
  if (
    server?.transport !== "streamable_http" ||
    server.oauthRedirectUrl === undefined
  ) {
    throw new Error("Configured HTTPS MCP OAuth server is unavailable.");
  }
  const key = options.environment.KODA_MCP_OAUTH_KEY;
  if (key === undefined) throw new Error("KODA_MCP_OAUTH_KEY is required.");
  const vault = await McpOAuthVault.open(options.kodaHome, key);
  let credentials:
    | { accessToken: string; refreshToken?: string; clientId: string }
    | undefined;
  if (server.oauthRevocationUrl !== undefined) {
    const provider = new McpOAuthProvider(
      vault,
      serverId,
      server.url,
      server.oauthRedirectUrl,
      undefined,
      server.oauthClientId,
    );
    const tokens = await provider.tokens();
    const issuer = tokens?.issuer;
    const client =
      issuer === undefined
        ? undefined
        : await provider.clientInformation({ issuer });
    if (tokens !== undefined && client !== undefined) {
      credentials = {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token === undefined
          ? {}
          : { refreshToken: tokens.refresh_token }),
        clientId: client.client_id,
      };
    }
  }
  await vault.remove(serverId, server.url);
  let remoteRevoked = false;
  if (server.oauthRevocationUrl !== undefined && credentials !== undefined) {
    try {
      const values = [credentials.accessToken, credentials.refreshToken].filter(
        (token): token is string => token !== undefined,
      );
      remoteRevoked = true;
      for (const token of values) {
        const response = await boundedOAuthFetch(server.oauthRevocationUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, client_id: credentials.clientId }),
          signal: AbortSignal.timeout(10_000),
        });
        remoteRevoked = response.ok && remoteRevoked;
        await response.body?.cancel();
      }
    } catch {
      remoteRevoked = false;
    }
  }
  return remoteRevoked ? "remote_revoked" : "local_only";
}

const boundedOAuthFetch: FetchLike = async (input, init) => {
  const url = new URL(input.toString());
  if (url.protocol !== "https:") {
    throw new Error("MCP OAuth requires HTTPS authorization endpoints.");
  }
  const response = await fetch(input, { ...init, redirect: "error" });
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_AUTH_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("MCP OAuth response exceeds the byte limit.");
  }
  if (response.body === null) return response;
  let total = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_AUTH_RESPONSE_BYTES) {
          throw new Error("MCP OAuth response exceeds the byte limit.");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
