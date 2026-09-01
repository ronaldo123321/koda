import {
  createProgram,
  runSetupCommand,
  type SetupClient,
  type TextWriter,
} from "@koda/cli";
import {
  runtimeProviderMetadataSchema,
  setupResultSchema,
  settingsGetResultSchema,
  settingsUpdateResultSchema,
  type ModelProviderId,
  type RuntimeProviderMetadata,
  type SettingsGetResult,
} from "@koda/protocol";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

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

describe("macOS Preview UX1A setup command", () => {
  it("stores an explicit workspace preference and emits a secret-free JSON contract", async () => {
    const fixture = await workspaceFixture();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const sentinel = "sentinel-deepseek-secret";
    const client = new FakeSetupClient({
      settings: settingsGetResultSchema.parse({
        workspace: fixture.workspace,
        revision: 0,
        diagnostics: [],
      }),
      providers: providers({ deepseek: true }),
    });

    const exitCode = await runSetupCommand(
      {
        cwd: fixture.workspace,
        provider: "deepseek",
        model: "deepseek-test-model",
        json: true,
      },
      {
        environment: { DEEPSEEK_API_KEY: sentinel },
        processDirectory: fixture.root,
        stdout,
        stderr,
        connectAppServer: async () => client,
      },
    );

    expect(exitCode, stderr.value).toBe(0);
    expect(client.updates).toEqual([
      {
        workspace: fixture.workspace,
        provider: "deepseek",
        model: "deepseek-test-model",
        expectedRevision: 0,
      },
    ]);
    expect(setupResultSchema.parse(JSON.parse(stdout.value))).toEqual({
      schema_version: 1,
      workspace: fixture.workspace,
      provider: "deepseek",
      model: "deepseek-test-model",
      credential_environment_variable: "DEEPSEEK_API_KEY",
      credential_available: true,
      preference_saved: true,
      settings_revision: 1,
      check: { status: "not_run" },
    });
    expect(`${stdout.value}${stderr.value}`).not.toContain(sentinel);
    expect(client.shutdownCalls).toBe(1);
  });

  it("does not rewrite an already-current preference", async () => {
    const fixture = await workspaceFixture();
    const stdout = new MemoryWriter();
    const client = new FakeSetupClient({
      settings: settingsGetResultSchema.parse({
        workspace: fixture.workspace,
        revision: 4,
        preference: {
          provider: "kimi",
          model: "kimi-existing",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        diagnostics: [],
      }),
      providers: providers({}),
    });

    const exitCode = await runSetupCommand(
      { cwd: fixture.workspace, json: true },
      {
        environment: {},
        processDirectory: fixture.root,
        stdout,
        stderr: new MemoryWriter(),
        connectAppServer: async () => client,
      },
    );

    expect(exitCode).toBe(0);
    expect(client.updates).toEqual([]);
    expect(setupResultSchema.parse(JSON.parse(stdout.value))).toMatchObject({
      provider: "kimi",
      model: "kimi-existing",
      preference_saved: false,
      settings_revision: 4,
    });
  });

  it("uses environment selection noninteractively and prompts for human setup", async () => {
    const fixture = await workspaceFixture();
    const noninteractiveClient = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({}),
    });
    const noninteractiveOut = new MemoryWriter();

    expect(
      await runSetupCommand(
        { cwd: fixture.workspace, json: true },
        {
          environment: {
            KODA_PROVIDER: "glm",
            KODA_MODEL: "glm-environment-model",
          },
          processDirectory: fixture.root,
          stdout: noninteractiveOut,
          stderr: new MemoryWriter(),
          connectAppServer: async () => noninteractiveClient,
        },
      ),
    ).toBe(0);
    expect(JSON.parse(noninteractiveOut.value)).toMatchObject({
      provider: "glm",
      model: "glm-environment-model",
    });

    const interactiveClient = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({}),
    });
    const interactiveOut = new MemoryWriter();
    const stdin = Object.assign(new PassThrough(), { isTTY: true as const });
    const answers = ["3", "deepseek-interactive-model"];
    expect(
      await runSetupCommand(
        { cwd: fixture.workspace },
        {
          environment: {},
          processDirectory: fixture.root,
          stdin,
          stdout: interactiveOut,
          stderr: new MemoryWriter(),
          connectAppServer: async () => interactiveClient,
          prompt: async () => answers.shift() ?? "",
        },
      ),
    ).toBe(0);
    expect(interactiveClient.updates[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-interactive-model",
    });
    expect(interactiveOut.value).toContain("Available providers:");
    expect(interactiveOut.value).toContain(
      "export DEEPSEEK_API_KEY='<your-key>'",
    );
    expect(interactiveOut.value).toContain("koda chat -C");
  });

  it("redacts provider credentials from bounded JSON errors", async () => {
    const fixture = await workspaceFixture();
    const sentinel = "sentinel-openai-secret";
    const stderr = new MemoryWriter();
    const client = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({ openai: true }),
      getError: new Error(`failed while handling ${sentinel}`),
    });

    expect(
      await runSetupCommand(
        { cwd: fixture.workspace, json: true },
        {
          environment: { OPENAI_API_KEY: sentinel },
          processDirectory: fixture.root,
          stdout: new MemoryWriter(),
          stderr,
          connectAppServer: async () => client,
        },
      ),
    ).toBe(1);
    expect(stderr.value).not.toContain(sentinel);
    expect(JSON.parse(stderr.value)).toEqual({
      schema_version: 1,
      error: {
        code: "KODA_SETUP_FAILED",
        message: "failed while handling [REDACTED]",
      },
    });
    expect(client.shutdownCalls).toBe(1);
  });

  it("exposes setup help without connecting to a provider", async () => {
    const stdout = new MemoryWriter();
    const program = createProgram({
      environment: {},
      processDirectory: "/workspace",
      stdout,
      stderr: new MemoryWriter(),
      setExitCode: () => undefined,
    });

    await expect(
      program.parseAsync(["node", "koda", "setup", "--help"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(stdout.value).toContain("Configure a workspace provider and model");
    expect(stdout.value).toContain("--provider <provider>");
    expect(stdout.value).toContain("--json");
  });
});

class FakeSetupClient implements SetupClient {
  public readonly initialization: {
    readonly providers: readonly RuntimeProviderMetadata[];
  };
  public readonly updates: Array<{
    workspace: string;
    provider: ModelProviderId;
    model: string;
    expectedRevision: number;
  }> = [];
  public shutdownCalls = 0;

  public constructor(
    private readonly options: {
      settings: SettingsGetResult;
      providers: readonly RuntimeProviderMetadata[];
      getError?: Error;
    },
  ) {
    this.initialization = { providers: options.providers };
  }

  public async getRuntimeSettings(): Promise<SettingsGetResult> {
    if (this.options.getError !== undefined) {
      throw this.options.getError;
    }
    return this.options.settings;
  }

  public async updateRuntimeSettings(input: {
    workspace: string;
    provider: ModelProviderId;
    model: string;
    expectedRevision: number;
  }) {
    this.updates.push(input);
    return settingsUpdateResultSchema.parse({
      workspace: input.workspace,
      revision: input.expectedRevision + 1,
      preference: {
        provider: input.provider,
        model: input.model,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      diagnostics: [],
    });
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

function providers(
  configured: Partial<Record<ModelProviderId, boolean>>,
): RuntimeProviderMetadata[] {
  const definitions = [
    ["openai", "OpenAI", "OPENAI_API_KEY", "gpt-5.6-terra"],
    ["anthropic", "Anthropic", "ANTHROPIC_API_KEY", "claude-sonnet-5"],
    ["deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "deepseek-v4-pro"],
    ["kimi", "Kimi", "MOONSHOT_API_KEY", "kimi-k2.6"],
    ["glm", "GLM", "ZAI_API_KEY", "glm-5.2"],
  ] as const;
  return definitions.map(([id, displayName, variable, defaultModel]) =>
    runtimeProviderMetadataSchema.parse({
      id,
      displayName,
      credentialEnvironmentVariable: variable,
      defaultModel,
      configured: configured[id] ?? false,
    }),
  );
}

function emptySettings(workspace: string): SettingsGetResult {
  return settingsGetResultSchema.parse({
    workspace,
    revision: 0,
    diagnostics: [],
  });
}

async function workspaceFixture(): Promise<{
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "koda-setup-command-"));
  temporaryDirectories.push(root);
  const workspaceDirectory = join(root, "workspace");
  await mkdir(workspaceDirectory);
  return { root, workspace: await realpath(workspaceDirectory) };
}
