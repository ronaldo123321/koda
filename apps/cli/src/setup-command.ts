import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { NodeAppServerClient } from "@koda/app-server-client-node";
import {
  KODA_VERSION,
  resolveInstallationEnvironment,
  resolveInstallationPath,
  resolveKodaInstallation,
} from "@koda/distribution";
import {
  modelProviderIdSchema,
  runtimeSettingsModelSchema,
  SETUP_RESULT_SCHEMA_VERSION,
  MAX_SETUP_MESSAGE_BYTES,
  setupCommandInputSchema,
  setupErrorResultSchema,
  setupResultSchema,
  type ModelProviderId,
  type RuntimeProviderMetadata,
  type SettingsGetParams,
  type SettingsGetResult,
  type SettingsUpdateParams,
  type SettingsUpdateResult,
  type SetupResult,
} from "@koda/protocol";
import { BUILT_IN_PROVIDER_METADATA } from "@koda/providers";

import type { TextWriter } from "./console-event-sink.js";

export interface SetupCommandOptions {
  cwd?: string;
  provider?: string;
  model?: string;
  json?: boolean;
}

export interface SetupClient {
  readonly initialization: {
    readonly providers: readonly RuntimeProviderMetadata[];
  };
  getRuntimeSettings(params: SettingsGetParams): Promise<SettingsGetResult>;
  updateRuntimeSettings(
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult>;
  shutdown(): Promise<void>;
}

export interface SetupCommandRuntime {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  stdout: TextWriter;
  stderr: TextWriter;
  connectAppServer?(): Promise<SetupClient>;
  prompt?(question: string): Promise<string>;
}

export async function runSetupCommand(
  options: SetupCommandOptions,
  runtime: SetupCommandRuntime,
): Promise<number> {
  let client: SetupClient | undefined;
  let promptSession: PromptSession | undefined;
  try {
    const input = setupCommandInputSchema.parse(options);
    const workspace = await canonicalWorkspace(
      input.cwd ?? ".",
      runtime.processDirectory,
    );
    const connectedClient =
      runtime.connectAppServer === undefined
        ? await connectDefaultAppServer(runtime)
        : await runtime.connectAppServer();
    client = connectedClient;
    const providers = connectedClient.initialization.providers;
    const settings = await connectedClient.getRuntimeSettings({ workspace });
    const interactive = input.json !== true && runtime.stdin?.isTTY === true;
    if (interactive && runtime.prompt === undefined) {
      promptSession = createPromptSession(runtime);
    }
    const ask = runtime.prompt ?? promptSession?.ask;
    const selection = await resolveSetupSelection(
      input,
      runtime.environment,
      settings.preference,
      providers,
      interactive ? ask : undefined,
      runtime.stdout,
    );
    const preferenceAlreadySaved =
      settings.preference?.provider === selection.provider &&
      settings.preference.model === selection.model;
    const update = preferenceAlreadySaved
      ? undefined
      : await connectedClient.updateRuntimeSettings({
          workspace,
          provider: selection.provider,
          model: selection.model,
          expectedRevision: settings.revision,
        });
    const metadata = providerMetadata(selection.provider, providers);
    const result = setupResultSchema.parse({
      schema_version: SETUP_RESULT_SCHEMA_VERSION,
      workspace,
      provider: selection.provider,
      model: selection.model,
      credential_environment_variable: metadata.credentialEnvironmentVariable,
      credential_available: metadata.configured,
      preference_saved: update !== undefined,
      settings_revision: update?.revision ?? settings.revision,
      check: { status: "not_run" },
    });
    runtime.stdout.write(
      input.json === true
        ? `${JSON.stringify(result)}\n`
        : renderSetupResult(result),
    );
    return 0;
  } catch (error) {
    const message = safeErrorMessage(error, runtime.environment);
    if (options.json === true) {
      const result = setupErrorResultSchema.parse({
        schema_version: SETUP_RESULT_SCHEMA_VERSION,
        error: { code: "KODA_SETUP_FAILED", message },
      });
      runtime.stderr.write(`${JSON.stringify(result)}\n`);
    } else {
      runtime.stderr.write(`error: ${message}\n`);
    }
    return 1;
  } finally {
    promptSession?.close();
    if (client !== undefined) {
      await client.shutdown().catch(() => undefined);
    }
  }
}

export async function resolveSetupSelection(
  options: { provider?: string | undefined; model?: string | undefined },
  environment: NodeJS.ProcessEnv,
  preference: SettingsGetResult["preference"],
  providers: readonly RuntimeProviderMetadata[],
  prompt: ((question: string) => Promise<string>) | undefined,
  output: TextWriter,
): Promise<{ provider: ModelProviderId; model: string }> {
  if (providers.length === 0) {
    throw new Error("The app-server did not report any model providers.");
  }
  const explicitProvider = options.provider?.trim();
  const providerDefault =
    explicitProvider ||
    environment.KODA_PROVIDER?.trim() ||
    preference?.provider ||
    "openai";
  let providerValue = providerDefault;
  if (prompt !== undefined && !explicitProvider) {
    output.write("Available providers:\n");
    providers.forEach((provider, index) => {
      const availability = provider.configured ? "configured" : "key missing";
      output.write(
        `  ${index + 1}. ${provider.displayName} (${provider.id}, ${availability})\n`,
      );
    });
    const answer = await prompt(`Provider [${providerDefault}]: `);
    providerValue = providerAnswer(answer, providerDefault, providers);
  }
  const parsedProvider = modelProviderIdSchema.safeParse(providerValue);
  if (!parsedProvider.success) {
    throw new Error(
      `Provider '${providerValue}' is invalid. Choose one of: ${providers
        .map((provider) => provider.id)
        .join(", ")}.`,
    );
  }
  const metadata = providerMetadata(parsedProvider.data, providers);
  const explicitModel = options.model?.trim();
  const modelDefault =
    explicitModel ||
    environment.KODA_MODEL?.trim() ||
    (preference?.provider === parsedProvider.data
      ? preference.model
      : undefined) ||
    metadata.defaultModel;
  let modelValue = modelDefault;
  if (prompt !== undefined && !explicitModel) {
    const answer = await prompt(`Model [${modelDefault}]: `);
    modelValue = answer.trim() || modelDefault;
  }
  return {
    provider: parsedProvider.data,
    model: runtimeSettingsModelSchema.parse(modelValue),
  };
}

export function renderSetupResult(result: SetupResult): string {
  const lines = [
    "Koda setup complete.",
    `Workspace: ${result.workspace}`,
    `Provider: ${result.provider}`,
    `Model: ${result.model}`,
    `Preference: ${result.preference_saved ? "saved" : "already current"} (revision ${result.settings_revision})`,
    `Credential: ${result.credential_available ? "available" : "missing"} (${result.credential_environment_variable})`,
  ];
  if (!result.credential_available) {
    lines.push(
      "",
      "Set the credential in your shell before starting Koda:",
      `  export ${result.credential_environment_variable}='<your-key>'`,
    );
  }
  lines.push(
    "",
    "Next:",
    `  koda chat -C ${shellQuote(result.workspace)}`,
    `  koda run -C ${shellQuote(result.workspace)} 'Describe the task'`,
    "",
  );
  return lines.join("\n");
}

async function connectDefaultAppServer(
  runtime: SetupCommandRuntime,
): Promise<NodeAppServerClient> {
  const installation = await resolveKodaInstallation({
    anchor: import.meta.url,
    verifyCriticalFiles: true,
  });
  const environment = resolveInstallationEnvironment(
    installation,
    runtime.environment,
  );
  if (installation.mode === "release") {
    return NodeAppServerClient.connect({
      command: resolveInstallationPath(
        installation,
        installation.manifest.node.path,
      ),
      args: [
        resolveInstallationPath(
          installation,
          installation.manifest.entrypoints.app_server,
        ),
      ],
      cwd: runtime.processDirectory,
      environment,
      clientName: "koda-setup",
      clientVersion: KODA_VERSION,
    });
  }
  return NodeAppServerClient.connect({
    cwd: runtime.processDirectory,
    environment,
    clientName: "koda-setup",
    clientVersion: KODA_VERSION,
  });
}

async function canonicalWorkspace(
  cwd: string,
  processDirectory: string,
): Promise<string> {
  const path = await realpath(resolve(processDirectory, cwd));
  if (!(await stat(path)).isDirectory()) {
    throw new Error(`Workspace '${path}' is not a directory.`);
  }
  return path;
}

function providerMetadata(
  provider: ModelProviderId,
  providers: readonly RuntimeProviderMetadata[],
): RuntimeProviderMetadata {
  const metadata = providers.find((candidate) => candidate.id === provider);
  if (metadata === undefined) {
    throw new Error(`Provider '${provider}' is not supported by app-server.`);
  }
  return metadata;
}

function providerAnswer(
  answer: string,
  defaultProvider: string,
  providers: readonly RuntimeProviderMetadata[],
): string {
  const value = answer.trim();
  if (value.length === 0) {
    return defaultProvider;
  }
  if (/^[0-9]+$/u.test(value)) {
    const selected = providers[Number(value) - 1];
    if (selected === undefined) {
      throw new Error(`Provider selection '${value}' is out of range.`);
    }
    return selected.id;
  }
  return value;
}

interface PromptSession {
  ask(question: string): Promise<string>;
  close(): void;
}

function createPromptSession(runtime: SetupCommandRuntime): PromptSession {
  if (runtime.stdin === undefined) {
    throw new Error("Interactive setup requires standard input.");
  }
  const readline = createInterface({ input: runtime.stdin, terminal: false });
  const iterator = readline[Symbol.asyncIterator]();
  return {
    ask: async (question) => {
      runtime.stdout.write(question);
      const answer = await iterator.next();
      if (answer.done) {
        throw new Error("Interactive setup ended before a selection was made.");
      }
      return answer.value;
    },
    close: () => readline.close(),
  };
}

function safeErrorMessage(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const provider of BUILT_IN_PROVIDER_METADATA) {
    const secret = environment[provider.credentialEnvironmentVariable]?.trim();
    if (secret !== undefined && secret.length > 0) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  message = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (message.length === 0) {
    return "Koda setup failed.";
  }
  const bytes = new TextEncoder().encode(message);
  if (bytes.byteLength <= MAX_SETUP_MESSAGE_BYTES) {
    return message;
  }
  return `${new TextDecoder().decode(
    bytes.slice(0, MAX_SETUP_MESSAGE_BYTES - 3),
  )}...`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
