import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProgram, type TextWriter } from "@koda/cli";
import { McpOAuthVault } from "@koda/mcp-client-node";
import { describe, expect, it } from "vitest";

class Writer implements TextWriter {
  public value = "";
  public write(value: string): void {
    this.value += value;
  }
}

describe.skipIf(process.platform !== "darwin")(
  "macOS MCP OAuth owner commands",
  () => {
    it("rotates the encrypted key and removes one server's credentials", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-mcp-oauth-cli-"));
      const oldKey = randomBytes(32).toString("base64");
      const newKey = randomBytes(32).toString("base64");
      const endpoint = "https://mcp.example.test/mcp";
      try {
        await writeFile(
          join(home, "mcp.json"),
          JSON.stringify({
            version: 1,
            servers: {
              fixture: {
                transport: "streamable_http",
                url: endpoint,
                oauth: { redirect_url: "http://127.0.0.1:8765/callback" },
              },
            },
          }),
        );
        const vault = await McpOAuthVault.open(home, oldKey);
        await vault.save("fixture", endpoint, { accessToken: "hidden-token" });
        const rotate = await invoke(home, oldKey, newKey, [
          "mcp",
          "auth",
          "rotate-key",
        ]);
        expect(rotate.exitCode).toBe(0);
        expect(rotate.stdout).not.toContain(oldKey);
        expect(rotate.stdout).not.toContain(newKey);
        const reopened = await McpOAuthVault.open(home, newKey);
        expect(await reopened.load("fixture", endpoint)).toEqual({
          accessToken: "hidden-token",
        });
        const revoke = await invoke(home, newKey, undefined, [
          "mcp",
          "auth",
          "revoke",
          "fixture",
        ]);
        expect(revoke.exitCode).toBe(0);
        expect(revoke.stdout).toContain("Local MCP OAuth credentials removed");
        expect(await reopened.load("fixture", endpoint)).toBeUndefined();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  },
);

async function invoke(
  home: string,
  key: string,
  newKey: string | undefined,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const stdout = new Writer();
  const stderr = new Writer();
  let exitCode = -1;
  const program = createProgram({
    environment: {
      KODA_HOME: home,
      KODA_MCP_OAUTH_KEY: key,
      ...(newKey === undefined ? {} : { KODA_MCP_OAUTH_NEW_KEY: newKey }),
    },
    processDirectory: home,
    stdout,
    stderr,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(["node", "koda", ...args]);
  expect(stderr.value).toBe("");
  return { exitCode, stdout: stdout.value };
}
