import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createProgram, type TextWriter } from "@koda/cli";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryWriter implements TextWriter {
  public value = "";
  public write(value: string): void {
    this.value += value;
  }
}

describe("MCP owner review command", () => {
  it("shows exact tool definition digests before they are pinned", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-mcp-review-"));
    directories.push(home);
    const fixtureServer = fileURLToPath(
      new URL("../fixtures/mcp-server.mjs", import.meta.url),
    );
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            command: process.execPath,
            args: [fixtureServer],
            remote_tools: ["echo"],
          },
        },
      }),
    );
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    let exitCode = -1;
    const program = createProgram({
      environment: { KODA_HOME: home },
      processDirectory: home,
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(["node", "koda", "mcp", "inspect", "fixture"]);
    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(JSON.parse(stdout.value)).toContainEqual(
      expect.objectContaining({
        name: "echo",
        definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        definition: expect.objectContaining({
          name: "echo",
          description: "Echo a value from the test MCP server.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      }),
    );
  });
});
