import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCommand,
  type RunCommandDependencies,
  type TextWriter,
} from "@koda/cli";
import { threadIdSchema, turnIdSchema } from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryWriter implements TextWriter {
  public value = "";

  public write(text: string): void {
    this.value += text;
  }
}

describe("CLI command templates", () => {
  it("passes an explicit template invocation through the shared application renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-template-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const commandDirectory = join(workspaceRoot, ".koda", "commands");
    await mkdir(commandDirectory, { recursive: true });
    await writeFile(
      join(commandDirectory, "review.md"),
      '---\nname: review\ndescription: Review one target.\nparameters: [{"name":"target","description":"Workspace target.","type":"string","required":true,"max_bytes":1024}]\n---\nReview {{target}} from the CLI.\n',
    );
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "user_message",
                content: expect.stringContaining(
                  "Review src/agent.ts from the CLI.",
                ),
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "CLI template rendered." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("template-cli-thread"),
        turnId: turnIdSchema.parse("template-cli-turn"),
        itemIds: new DeterministicItemIdFactory("template-cli-item"),
      }),
    };
    const stdout = new MemoryWriter();

    await expect(
      runCommand(
        {
          prompt: '/template review {"target":"src/agent.ts"}',
          cwd: workspaceRoot,
          signal: new AbortController().signal,
        },
        {
          environment: {
            KODA_HOME: join(root, "state"),
            OPENAI_API_KEY: "offline-test-key",
          },
          processDirectory: root,
          stdout,
          stderr: new MemoryWriter(),
        },
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(stdout.value).toContain("CLI template rendered.");
  });
});
