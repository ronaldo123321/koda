import {
  createProgram,
  normalizeProviderCheckError,
  runSetupCommand,
  type SetupClient,
  type TextWriter,
} from "@koda/cli";
import type { ModelProvider, ModelRequest } from "@koda/agent-core";
import {
  runtimeProviderMetadataSchema,
  setupResultSchema,
  settingsGetResultSchema,
  settingsUpdateResultSchema,
  type ModelProviderId,
  type RuntimeProviderMetadata,
  type SettingsGetResult,
} from "@koda/protocol";
import { ProviderError } from "@koda/providers";
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
        createProvider: () => {
          throw new Error("Provider check must remain opt-in.");
        },
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

  it("performs one explicit no-Tool check without persisting model output", async () => {
    const fixture = await workspaceFixture();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const sentinel = "sentinel-provider-check-key";
    let request: ModelRequest | undefined;
    const client = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({ deepseek: true }),
    });

    const exitCode = await runSetupCommand(
      {
        cwd: fixture.workspace,
        provider: "deepseek",
        model: "deepseek-check-model",
        json: true,
        check: true,
      },
      {
        environment: { DEEPSEEK_API_KEY: sentinel },
        processDirectory: fixture.root,
        stdout,
        stderr,
        connectAppServer: async () => client,
        createProvider: (input) => {
          expect(input).toEqual({
            provider: "deepseek",
            apiKey: sentinel,
            model: "deepseek-check-model",
          });
          return {
            stream: async function* (modelRequest) {
              request = modelRequest;
              yield { type: "assistant_delta", text: "ignored-output" };
              yield { type: "completed", finishReason: "stop" };
            },
          };
        },
      },
    );

    expect(exitCode, stderr.value).toBe(0);
    expect(request).toMatchObject({ step: 1, tools: [] });
    expect(request?.items).toHaveLength(1);
    expect(request?.items[0]).toMatchObject({
      type: "user_message",
      content: "Reply with OK.",
    });
    expect(setupResultSchema.parse(JSON.parse(stdout.value)).check).toEqual({
      status: "passed",
    });
    expect(`${stdout.value}${stderr.value}`).not.toContain(sentinel);
    expect(stdout.value).not.toContain("ignored-output");
  });

  it("reports a missing credential as a checked failure without creating a Provider", async () => {
    const fixture = await workspaceFixture();
    const stdout = new MemoryWriter();
    const client = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({}),
    });

    const exitCode = await runSetupCommand(
      {
        cwd: fixture.workspace,
        provider: "kimi",
        json: true,
        check: true,
      },
      {
        environment: {},
        processDirectory: fixture.root,
        stdout,
        stderr: new MemoryWriter(),
        connectAppServer: async () => client,
        createProvider: () => {
          throw new Error("Missing credentials must fail before construction.");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(setupResultSchema.parse(JSON.parse(stdout.value))).toMatchObject({
      provider: "kimi",
      credential_available: false,
      check: {
        status: "failed",
        reason: "credential_missing",
        message: "MOONSHOT_API_KEY is not set for provider 'kimi'.",
      },
    });
  });

  it("normalizes Provider check failures without copying raw errors", async () => {
    const activeSignal = new AbortController().signal;
    expect(
      normalizeProviderCheckError(
        new ProviderError(
          "PROVIDER_AUTHENTICATION_FAILED",
          "raw credential detail",
        ),
        activeSignal,
        "openai",
        "gpt-check",
      ),
    ).toMatchObject({
      status: "failed",
      reason: "authentication_failed",
    });
    expect(
      normalizeProviderCheckError(
        new ProviderError("PROVIDER_RATE_LIMITED", "raw rate body"),
        activeSignal,
        "anthropic",
        "claude-check",
      ),
    ).toMatchObject({ status: "failed", reason: "rate_limited" });
    expect(
      normalizeProviderCheckError(
        new ProviderError("PROVIDER_REQUEST_FAILED", "raw model body", {
          cause: { status: 404, code: "model_not_found" },
        }),
        activeSignal,
        "deepseek",
        "missing-model",
      ),
    ).toMatchObject({ status: "failed", reason: "model_unavailable" });
    expect(
      normalizeProviderCheckError(
        new ProviderError("PROVIDER_REQUEST_FAILED", "raw network body", {
          cause: { code: "ENOTFOUND" },
        }),
        activeSignal,
        "glm",
        "glm-check",
      ),
    ).toMatchObject({ status: "failed", reason: "network_failed" });

    const cancelled = new AbortController();
    cancelled.abort("cancelled by test");
    expect(
      normalizeProviderCheckError(
        new Error("raw cancellation detail"),
        cancelled.signal,
        "kimi",
        "kimi-check",
      ),
    ).toMatchObject({ status: "failed", reason: "cancelled" });
  });

  it("never projects an unknown Provider error or credential into check output", async () => {
    const fixture = await workspaceFixture();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const sentinel = "sentinel-unknown-provider-detail";
    const client = new FakeSetupClient({
      settings: emptySettings(fixture.workspace),
      providers: providers({ openai: true }),
    });
    const failingProvider: ModelProvider = {
      stream: async function* () {
        throw new Error(sentinel);
      },
    };

    const exitCode = await runSetupCommand(
      { cwd: fixture.workspace, json: true, check: true },
      {
        environment: { OPENAI_API_KEY: sentinel },
        processDirectory: fixture.root,
        stdout,
        stderr,
        connectAppServer: async () => client,
        createProvider: () => failingProvider,
      },
    );

    expect(exitCode).toBe(1);
    expect(
      setupResultSchema.parse(JSON.parse(stdout.value)).check,
    ).toMatchObject({ status: "failed", reason: "provider_failed" });
    expect(`${stdout.value}${stderr.value}`).not.toContain(sentinel);
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
    expect(stdout.value).toContain("--check");
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
