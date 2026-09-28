import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== "darwin")("macOS MCP OAuth", () => {
  it.each(["dynamic", "registered"] as const)(
    "%s client validates a loopback callback and invokes over TLS",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "koda-mcp-oauth-flow-"));
      try {
        const certificatePath = join(home, "cert.pem");
        const privateKeyPath = join(home, "key.pem");
        await execFileAsync("openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          privateKeyPath,
          "-out",
          certificatePath,
        ]);
        const freePort = createHttpServer();
        await new Promise<void>((resolve, reject) => {
          freePort.once("error", reject);
          freePort.listen(0, "127.0.0.1", resolve);
        });
        const callbackAddress = freePort.address();
        if (callbackAddress === null || typeof callbackAddress === "string")
          throw new Error();
        const callbackPort = callbackAddress.port;
        await new Promise<void>((resolve) => freePort.close(() => resolve()));

        let origin = "";
        const seen: string[] = [];
        const server = createServer(
          {
            key: await readFile(privateKeyPath),
            cert: await readFile(certificatePath),
          },
          async (request, response) => {
            const url = new URL(request.url ?? "/", origin);
            seen.push(`${request.method} ${url.pathname}`);
            const json = (status: number, data: object) => {
              response.writeHead(status, {
                "content-type": "application/json",
              });
              response.end(JSON.stringify(data));
            };
            if (
              url.pathname.startsWith("/.well-known/oauth-protected-resource")
            ) {
              json(200, {
                resource: `${origin}/mcp`,
                authorization_servers: [origin],
              });
            } else if (
              url.pathname === "/.well-known/oauth-authorization-server"
            ) {
              json(200, {
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                ...(mode === "dynamic"
                  ? { registration_endpoint: `${origin}/register` }
                  : {}),
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                authorization_response_iss_parameter_supported: true,
              });
            } else if (
              url.pathname === "/register" &&
              request.method === "POST"
            ) {
              let body = "";
              for await (const chunk of request) body += chunk.toString();
              json(201, { ...JSON.parse(body), client_id: "koda-test-client" });
            } else if (url.pathname === "/authorize") {
              const redirect = url.searchParams.get("redirect_uri");
              const state = url.searchParams.get("state");
              if (
                !redirect ||
                !state ||
                !url.searchParams.get("code_challenge")
              ) {
                response.writeHead(400).end();
                return;
              }
              const callback = new URL(redirect);
              callback.searchParams.set("code", "fixture-code");
              callback.searchParams.set("state", state);
              callback.searchParams.set("iss", origin);
              response.writeHead(302, { location: callback.href }).end();
            } else if (url.pathname === "/token" && request.method === "POST") {
              let body = "";
              for await (const chunk of request) body += chunk.toString();
              const fields = new URLSearchParams(body);
              if (fields.get("client_id") !== "koda-test-client") {
                json(400, { error: "invalid_client" });
                return;
              }
              if (fields.get("grant_type") === "refresh_token") {
                if (fields.get("refresh_token") !== "fixture-refresh-token") {
                  json(400, { error: "invalid_grant" });
                  return;
                }
                json(200, {
                  access_token: "fixture-rotated-token",
                  refresh_token: "fixture-rotated-refresh-token",
                  token_type: "Bearer",
                  expires_in: 3_600,
                });
                return;
              }
              if (
                fields.get("code") !== "fixture-code" ||
                !fields.get("code_verifier")
              ) {
                json(400, { error: "invalid_grant" });
                return;
              }
              json(200, {
                access_token: "fixture-access-token",
                refresh_token: "fixture-refresh-token",
                token_type: "Bearer",
                expires_in: 3_600,
              });
            } else if (
              url.pathname === "/revoke" &&
              request.method === "POST"
            ) {
              let body = "";
              for await (const chunk of request) body += chunk.toString();
              const token = new URLSearchParams(body).get("token");
              if (
                token !== "fixture-rotated-token" &&
                token !== "fixture-rotated-refresh-token"
              ) {
                response.writeHead(400).end();
                return;
              }
              response.writeHead(200).end();
            } else if (url.pathname === "/mcp" && request.method === "POST") {
              if (
                request.headers.authorization !== "Bearer fixture-rotated-token"
              ) {
                response
                  .writeHead(401, {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                  })
                  .end();
                return;
              }
              let body = "";
              for await (const chunk of request) body += chunk.toString();
              const message = JSON.parse(body) as {
                id?: string | number;
                method?: string;
              };
              if (message.id === undefined) {
                response.writeHead(202).end();
                return;
              }
              const result =
                message.method === "initialize"
                  ? {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "oauth-fixture", version: "1.0.0" },
                    }
                  : message.method === "tools/list"
                    ? {
                        tools: [
                          {
                            name: "echo",
                            inputSchema: {
                              type: "object",
                              properties: { value: { type: "string" } },
                            },
                          },
                        ],
                      }
                    : { content: [{ type: "text", text: "hello" }] };
              json(200, { jsonrpc: "2.0", id: message.id, result });
            } else {
              response.writeHead(404).end();
            }
          },
        );
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error();
        origin = `https://127.0.0.1:${address.port}`;
        try {
          await writeFile(
            join(home, "mcp.json"),
            JSON.stringify({
              version: 1,
              servers: {
                fixture: {
                  transport: "streamable_http",
                  url: `${origin}/mcp`,
                  oauth: {
                    redirect_url: `http://127.0.0.1:${callbackPort}/callback`,
                    ...(mode === "registered"
                      ? { client_id: "koda-test-client" }
                      : {}),
                    revocation_url: `${origin}/revoke`,
                  },
                  remote_tools: ["echo"],
                },
              },
            }),
          );
          const { stdout } = await execFileAsync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../fixtures/mcp-oauth-client.mjs", import.meta.url),
              ),
              home,
            ],
            {
              env: {
                ...process.env,
                NODE_EXTRA_CA_CERTS: certificatePath,
                KODA_MCP_OAUTH_KEY: randomBytes(32).toString("base64"),
              },
              timeout: 15_000,
            },
          );
          expect(JSON.parse(stdout)).toMatchObject({
            tools: ["echo"],
            result: { content: [{ type: "text", text: "hello" }] },
          });
          expect(seen.includes("POST /register")).toBe(mode === "dynamic");
          expect(seen).toContain("GET /authorize");
          expect(seen).toContain("POST /token");
          expect(seen).toContain("POST /mcp");
          expect(seen.filter((item) => item === "POST /revoke")).toHaveLength(
            2,
          );
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
