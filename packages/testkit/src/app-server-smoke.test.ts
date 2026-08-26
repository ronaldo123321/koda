import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("app-server subprocess", () => {
  it("keeps stdout protocol-only and serves credential-free queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-app-server-smoke-"));
    temporaryDirectories.push(root);
    const entry = join(process.cwd(), "apps", "app-server", "dist", "main.js");
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        KODA_HOME: join(root, "state"),
        OPENAI_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(
      [
        request(1, "initialize", {
          protocolVersion: 1,
          client: { name: "smoke-test" },
        }),
        request(2, "thread/list", {}),
        request(3, "shutdown", {}),
      ].join("\n") + "\n",
    );
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    expect(exit).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(messages[0]?.result).toMatchObject({ protocolVersion: 1 });
    expect(messages[1]?.result).toMatchObject({ threads: [] });
    expect(messages[2]?.result).toEqual({});
  });
});

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
