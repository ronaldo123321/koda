import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionInspectionError, KodaApplication } from "@koda/app";
import {
  agentEventSchema,
  extensionCatalogResultSchema,
  extensionReadResultSchema,
  threadIdSchema,
  threadExtensionsResultSchema,
} from "@koda/protocol";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("extension inspection", () => {
  it("discovers a stable safe catalog and reads only validated current sources without spawning plugins", async () => {
    const fixture = await createFixture();
    const application = createApplication(fixture);

    const first = extensionCatalogResultSchema.parse(
      await application.inspectExtensionCatalog({
        workspace: fixture.workspace,
      }),
    );
    const second = extensionCatalogResultSchema.parse(
      await application.inspectExtensionCatalog({
        workspace: fixture.workspace,
      }),
    );

    expect(second).toEqual(first);
    expect(first.workspace).toBe(await realpath(fixture.workspace));
    expect(first.skills).toHaveLength(1);
    expect(first.commandTemplates).toHaveLength(1);
    expect(first.configuredPlugins).toEqual([
      expect.objectContaining({
        pluginId: "fixture",
        required: false,
        capabilities: ["skills", "tools"],
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain(fixture.marker);
    expect(JSON.stringify(first)).not.toContain("FIXTURE_SECRET");
    await expect(access(fixture.marker)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const skill = first.skills[0]!;
    expect(
      extensionReadResultSchema.parse(
        await application.readExtensionSource({
          workspace: fixture.workspace,
          kind: "skill",
          sourceId: skill.skillId,
        }),
      ),
    ).toMatchObject({
      sourceId: skill.skillId,
      sha256: skill.sha256,
      content: expect.stringContaining("Review the selected code."),
    });
    const template = first.commandTemplates[0]!;
    expect(
      extensionReadResultSchema.parse(
        await application.readExtensionSource({
          workspace: fixture.workspace,
          kind: "command_template",
          sourceId: template.templateId,
        }),
      ),
    ).toMatchObject({
      sourceId: template.templateId,
      sha256: template.sha256,
      content: expect.stringContaining("Summarize this workspace."),
    });
    await expect(access(fixture.marker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for unlisted source identities and malformed plugin manifests", async () => {
    const fixture = await createFixture();
    const application = createApplication(fixture);
    await expect(
      application.readExtensionSource({
        workspace: fixture.workspace,
        kind: "skill",
        sourceId: `skill:${"f".repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      name: "ExtensionInspectionError",
      code: "EXTENSION_SOURCE_NOT_FOUND",
    } satisfies Partial<ExtensionInspectionError>);

    await writeFile(
      fixture.pluginConfig,
      JSON.stringify({
        version: 1,
        plugins: {
          fixture: {
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            capabilities: ["tools"],
            unexpected: true,
          },
        },
      }),
    );
    await expect(
      application.inspectExtensionCatalog({ workspace: fixture.workspace }),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFIGURATION_INVALID" });
  });

  it("returns the latest or exact durable Thread extension snapshot after workspace authorization", async () => {
    const fixture = await createFixture();
    const application = createApplication(fixture);
    const current = await application.inspectExtensionCatalog({
      workspace: fixture.workspace,
    });
    const threadId = threadIdSchema.parse("extension-history");
    const events = [
      lifecycleEvent(0, threadId, "extension-turn-old", "turn.started", {}),
      turnContextEvent({
        sequence: 1,
        threadId,
        turnId: "extension-turn-old",
        workspace: current.workspace,
        skills: [],
        commandTemplates: [],
        plugins: [],
      }),
      lifecycleEvent(2, threadId, "extension-turn-old", "turn.completed", {
        steps: 1,
      }),
      lifecycleEvent(3, threadId, "extension-turn-current", "turn.started", {}),
      turnContextEvent({
        sequence: 4,
        threadId,
        turnId: "extension-turn-current",
        workspace: current.workspace,
        skills: current.skills,
        commandTemplates: current.commandTemplates,
        plugins: [
          {
            pluginId: "fixture",
            status: "disabled",
            required: false,
            manifestSha256: current.configuredPlugins[0]!.manifestSha256,
            errorCode: "PLUGIN_START_FAILED",
          },
        ],
        toolCatalogGeneration: {
          generationId: `tool-catalog:${"b".repeat(64)}`,
          toolCount: 3,
          toolsSha256: "c".repeat(64),
        },
      }),
      lifecycleEvent(5, threadId, "extension-turn-current", "turn.completed", {
        steps: 1,
      }),
    ];
    const threadDirectory = join(fixture.state, "threads");
    await mkdir(threadDirectory, { recursive: true });
    await writeFile(
      join(threadDirectory, `${threadId}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    expect(
      threadExtensionsResultSchema.parse(
        await application.inspectThreadExtensions({
          workspace: fixture.workspace,
          threadId,
        }),
      ),
    ).toMatchObject({
      anchorSequence: 4,
      turnId: "extension-turn-current",
      skills: current.skills,
      commandTemplates: current.commandTemplates,
      plugins: [{ pluginId: "fixture", status: "disabled" }],
      toolCatalogGeneration: { toolCount: 3 },
    });
    expect(
      await application.inspectThreadExtensions({
        workspace: fixture.workspace,
        threadId,
        anchorSequence: 1,
      }),
    ).toMatchObject({
      anchorSequence: 1,
      turnId: "extension-turn-old",
      skills: [],
      commandTemplates: [],
      plugins: [],
    });
    await expect(
      application.inspectThreadExtensions({
        workspace: fixture.workspace,
        threadId,
        anchorSequence: 99,
      }),
    ).rejects.toMatchObject({
      code: "THREAD_EXTENSION_SNAPSHOT_NOT_FOUND",
    });

    const otherWorkspace = join(fixture.root, "other");
    await mkdir(otherWorkspace);
    await expect(
      application.inspectThreadExtensions({
        workspace: otherWorkspace,
        threadId,
      }),
    ).rejects.toMatchObject({ code: "THREAD_WORKSPACE_MISMATCH" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-extension-inspection-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const skillDirectory = join(workspace, ".koda", "skills", "review");
  const templateDirectory = join(workspace, ".koda", "commands");
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(templateDirectory, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: review\ndescription: Review current code.\n---\nReview the selected code.\n",
  );
  await writeFile(
    join(templateDirectory, "summary.md"),
    "---\nname: summary\ndescription: Summarize this workspace.\nparameters: []\n---\nSummarize this workspace.\n",
  );
  const marker = join(root, "plugin-started.txt");
  const pluginConfig = join(state, "plugins.json");
  await writeFile(
    pluginConfig,
    JSON.stringify({
      version: 1,
      plugins: {
        fixture: {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
          ],
          env: ["FIXTURE_SECRET"],
          required: false,
          capabilities: ["tools", "skills"],
        },
      },
    }),
  );
  return { root, workspace, state, marker, pluginConfig };
}

function createApplication(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return new KodaApplication({
    environment: {
      KODA_HOME: fixture.state,
      FIXTURE_SECRET: "must-not-leak",
    },
    processDirectory: fixture.root,
  });
}

function turnContextEvent(input: {
  sequence: number;
  threadId: string;
  turnId: string;
  workspace: string;
  skills: unknown[];
  commandTemplates: unknown[];
  plugins: unknown[];
  toolCatalogGeneration?: unknown;
}) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence: input.sequence,
    timestamp: `2026-08-28T00:00:0${input.sequence}.000Z`,
    threadId: input.threadId,
    turnId: input.turnId,
    type: "turn.context",
    payload: {
      provider: "openai",
      model: "fixture-model",
      workspaceRoot: input.workspace,
      approvalMode: "on-request",
      instructionsSha256: "a".repeat(64),
      repositoryInstructions: [],
      skills: input.skills,
      commandTemplates: input.commandTemplates,
      plugins: input.plugins,
      ...(input.toolCatalogGeneration === undefined
        ? {}
        : { toolCatalogGeneration: input.toolCatalogGeneration }),
    },
  });
}

function lifecycleEvent(
  sequence: number,
  threadId: string,
  turnId: string,
  type: "turn.started" | "turn.completed",
  payload: unknown,
) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: `2026-08-28T00:00:0${sequence}.000Z`,
    threadId,
    turnId,
    type,
    payload,
  });
}
