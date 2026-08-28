import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KodaApplication,
  type KodaApplicationDependencies,
  type TurnClient,
} from "@koda/app";
import type { ModelProvider } from "@koda/agent-core";
import {
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
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

describe("KodaApplication command templates", () => {
  it("renders an audited user prompt without adding template text to system instructions", async () => {
    const fixture = await createFixture();
    await writeReviewTemplate(fixture.workspaceRoot, "version one");
    let providerInstructions = "";
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const userMessage = request.items.find(
            (item) => item.type === "user_message",
          );
          expect(userMessage).toMatchObject({
            content: expect.stringContaining(
              "[Koda command template: review; source sha256",
            ),
          });
          expect(userMessage).toMatchObject({
            content: expect.stringContaining(
              "Review src/agent.ts for version one.",
            ),
          });
          expect(JSON.stringify(request.items)).not.toContain(
            '/template review {"target":"src/agent.ts"}',
          );
        },
        events: [
          { type: "assistant_delta", text: "Reviewed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const baseDependencies = dependencies(provider, "template-render");
    const application = new KodaApplication({
      environment: environment(fixture.kodaHome),
      processDirectory: fixture.root,
      dependencies: {
        ...baseDependencies,
        createProvider: (configuration, instructions) => {
          providerInstructions = instructions;
          return baseDependencies.createProvider(configuration, instructions);
        },
      },
    });
    const observed: AgentEvent[] = [];

    const handle = application.startTurn(
      {
        prompt: '/template review {"target":"src/agent.ts"}',
        cwd: fixture.workspaceRoot,
      },
      client(observed),
    );
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
    });

    expect(providerInstructions).not.toContain("Review one target.");
    expect(providerInstructions).not.toContain("Review {{target}}");
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.context",
          payload: expect.objectContaining({
            commandTemplates: [
              expect.objectContaining({
                name: "review",
                selector: "review",
                path: ".koda/commands/review.md",
              }),
            ],
            commandTemplateActivation: expect.objectContaining({
              selector: "review",
              renderedBytes: expect.any(Number),
            }),
          }),
        }),
      ]),
    );
  });

  it("fails invalid activation before constructing a Provider", async () => {
    const fixture = await createFixture();
    await writeReviewTemplate(fixture.workspaceRoot, "correctness");
    let providerCreations = 0;
    const provider = new ScriptedModelProvider([]);
    const baseDependencies = dependencies(provider, "template-invalid");
    const application = new KodaApplication({
      environment: environment(fixture.kodaHome),
      processDirectory: fixture.root,
      dependencies: {
        ...baseDependencies,
        createProvider: (configuration, instructions) => {
          providerCreations += 1;
          return baseDependencies.createProvider(configuration, instructions);
        },
      },
    });

    const handle = application.startTurn(
      { prompt: "/template review {}", cwd: fixture.workspaceRoot },
      client(),
    );

    await expect(handle.completion).resolves.toMatchObject({
      status: "failed",
      error: { code: "COMMAND_TEMPLATE_INVALID_ARGUMENT" },
    });
    expect(providerCreations).toBe(0);
  });

  it("reports resume changes and authorizes bounded current-source inspection", async () => {
    const fixture = await createFixture();
    await writeReviewTemplate(fixture.workspaceRoot, "version one");
    const threadId = threadIdSchema.parse("template-resume-thread");
    const providers = [
      new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "First turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
      new ScriptedModelProvider([
        {
          assertRequest: (request) => {
            expect(request.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "recovery",
                  commandTemplateChanges: [
                    expect.objectContaining({
                      selector: "review",
                      change: "changed",
                    }),
                  ],
                }),
              ]),
            );
          },
          events: [
            { type: "assistant_delta", text: "Second turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
    ];
    let providerCursor = 0;
    let turnCursor = 0;
    const application = new KodaApplication({
      environment: environment(fixture.kodaHome),
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => providers[providerCursor++]!,
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(`template-resume-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `template-resume-item-${turnCursor}`,
            ),
          };
        },
      },
    });

    await expect(
      application.startTurn(
        { prompt: "Start history.", cwd: fixture.workspaceRoot },
        client(),
      ).completion,
    ).resolves.toMatchObject({ status: "completed" });
    await writeReviewTemplate(fixture.workspaceRoot, "version two");
    await expect(
      application.startTurn(
        {
          prompt: "Resume history.",
          cwd: fixture.workspaceRoot,
          resume: threadId,
        },
        client(),
      ).completion,
    ).resolves.toMatchObject({ status: "completed" });

    const contexts = await application.listThreadContexts({
      workspace: fixture.workspaceRoot,
      threadId,
      limit: 10,
    });
    const oldest = contexts.requests.at(-1);
    if (oldest === undefined) {
      throw new Error("Expected the first prepared context.");
    }
    const detail = await application.readContext({
      workspace: fixture.workspaceRoot,
      threadId,
      anchorSequence: oldest.anchorSequence,
    });
    const templateSource = detail.instructions.sources.find(
      (source) => source.kind === "command_template",
    );
    expect(templateSource).toMatchObject({
      path: ".koda/commands/review.md",
      scope: ".",
      status: "modified",
    });
    if (templateSource?.sourceId === undefined) {
      throw new Error("Expected a readable current template source.");
    }
    await expect(
      application.readContextInstruction({
        workspace: fixture.workspaceRoot,
        threadId,
        anchorSequence: oldest.anchorSequence,
        sourceId: templateSource.sourceId,
        maxBytes: 16_384,
      }),
    ).resolves.toMatchObject({
      path: ".koda/commands/review.md",
      content: expect.stringContaining("version two"),
    });
  });
});

async function createFixture(): Promise<{
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "koda-template-application-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "repo");
  await mkdir(workspaceRoot);
  return { root, workspaceRoot, kodaHome: join(root, "state") };
}

async function writeReviewTemplate(
  workspaceRoot: string,
  focus: string,
): Promise<void> {
  const directory = join(workspaceRoot, ".koda", "commands");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "review.md"),
    `---\nname: review\ndescription: Review one target.\nparameters: [{"name":"target","description":"Workspace target.","type":"string","required":true,"max_bytes":1024}]\n---\nReview {{target}} for ${focus}.\n`,
  );
}

function dependencies(
  provider: ModelProvider,
  prefix: string,
): KodaApplicationDependencies {
  return {
    openWorkspace: (root) => ReadOnlyWorkspace.open(root),
    createProvider: () => provider,
    createIds: () => ({
      threadId: threadIdSchema.parse(`${prefix}-thread`),
      turnId: turnIdSchema.parse(`${prefix}-turn`),
      itemIds: new DeterministicItemIdFactory(`${prefix}-item`),
    }),
  };
}

function client(events: AgentEvent[] = []): TurnClient {
  return {
    events: { append: async (event) => void events.push(event) },
    approvals: { request: async () => ({ decision: "rejected" as const }) },
  };
}

function environment(kodaHome: string): NodeJS.ProcessEnv {
  return { KODA_HOME: kodaHome, OPENAI_API_KEY: "offline-test-key" };
}
