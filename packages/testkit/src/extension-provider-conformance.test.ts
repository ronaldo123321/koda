import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KodaApplication } from "@koda/app";
import {
  threadIdSchema,
  turnIdSchema,
  type ModelProviderId,
} from "@koda/protocol";
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

describe("extension provider conformance", () => {
  it("projects the same frozen extension metadata to every supported provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-extension-providers-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const skillDirectory = join(workspace, ".koda", "skills", "portable");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: portable\ndescription: Provider-neutral extension guidance.\n---\nThis body is disclosed only through read_skill.\n",
    );
    const providers: ModelProviderId[] = [
      "openai",
      "anthropic",
      "deepseek",
      "kimi",
      "glm",
    ];
    const instructions = new Map<ModelProviderId, string>();

    for (const providerId of providers) {
      const provider = new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "done" },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]);
      const application = new KodaApplication({
        environment: {
          KODA_HOME: join(root, `state-${providerId}`),
          OPENAI_API_KEY: "offline",
          ANTHROPIC_API_KEY: "offline",
          DEEPSEEK_API_KEY: "offline",
          MOONSHOT_API_KEY: "offline",
          ZAI_API_KEY: "offline",
        },
        processDirectory: root,
        dependencies: {
          openWorkspace: (path) => ReadOnlyWorkspace.open(path),
          createProvider: (configuration, projectedInstructions) => {
            instructions.set(configuration.provider, projectedInstructions);
            return provider;
          },
          createIds: () => ({
            threadId: threadIdSchema.parse(`extension-${providerId}-thread`),
            turnId: turnIdSchema.parse(`extension-${providerId}-turn`),
            itemIds: new DeterministicItemIdFactory(
              `extension-${providerId}-item`,
            ),
          }),
        },
      });
      const handle = application.startTurn(
        { prompt: "Inspect extensions.", cwd: workspace, provider: providerId },
        {
          events: { append: async () => undefined },
          approvals: {
            request: async () => ({ decision: "rejected" as const }),
          },
        },
      );
      await expect(handle.completion).resolves.toMatchObject({
        status: "completed",
      });
    }

    expect(instructions.size).toBe(providers.length);
    expect(new Set(instructions.values()).size).toBe(1);
    const projected = instructions.get("openai")!;
    expect(projected).toContain("portable");
    expect(projected).toContain("Provider-neutral extension guidance.");
    expect(projected).not.toContain(
      "This body is disclosed only through read_skill.",
    );
  });
});
