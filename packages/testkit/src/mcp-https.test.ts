import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

describe.skipIf(process.platform === "win32")("HTTPS MCP transport", () => {
  it("calls a real TLS MCP endpoint and refuses endpoint redirects", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-mcp-https-"));
    directories.push(home);
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
    const paths: string[] = [];
    const server = createServer(
      {
        key: await readFile(privateKeyPath),
        cert: await readFile(certificatePath),
      },
      async (request, response) => {
        paths.push(request.url ?? "");
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/mcp" }).end();
          return;
        }
        if (request.url === "/oversize") {
          response.writeHead(200, { "content-type": "application/json" });
          const bytes = Buffer.alloc(8 * 1_024 * 1_024 + 1, 120);
          response.write(bytes.subarray(0, 4_096));
          response.end(bytes.subarray(4_096));
          return;
        }
        if (request.url !== "/mcp") {
          response.writeHead(404).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
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
                serverInfo: { name: "https-fixture", version: "1.0.0" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      description: "Echo one value.",
                      inputSchema: {
                        type: "object",
                        properties: { value: { type: "string" } },
                      },
                    },
                  ],
                }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: "hello" }] }
                : undefined;
        response.writeHead(result === undefined ? 404 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
        );
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("HTTPS fixture has no port.");
      }
      const url = `https://127.0.0.1:${address.port}`;
      const runClient = async (path: string) => {
        await writeFile(
          join(home, "mcp.json"),
          JSON.stringify({
            version: 1,
            servers: {
              fixture: {
                transport: "streamable_http",
                url: `${url}${path}`,
                remote_tools: ["echo"],
              },
            },
          }),
        );
        return execFileAsync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../fixtures/mcp-https-client.mjs", import.meta.url),
            ),
            home,
          ],
          {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath },
            timeout: 10_000,
          },
        );
      };
      const { stdout } = await runClient("/mcp");
      expect(JSON.parse(stdout)).toMatchObject({
        tools: ["echo"],
        remoteTools: ["mcp__fixture__echo"],
        result: { content: [{ type: "text", text: "hello" }] },
      });
      expect(paths).toContain("/mcp");
      paths.length = 0;
      await expect(runClient("/redirect")).rejects.toThrow();
      expect(paths).toContain("/redirect");
      expect(paths).not.toContain("/mcp");
      await expect(runClient("/oversize")).rejects.toMatchObject({
        stderr: expect.stringContaining("response exceeds the byte limit"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
