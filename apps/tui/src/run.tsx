import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { NodeAppServerClient } from "@koda/app-server-client-node";
import type { AppServerClientApi } from "@koda/app-server-client-node";
import {
  KODA_VERSION,
  resolveInstallationEnvironment,
  resolveInstallationPath,
  resolveKodaInstallation,
} from "@koda/distribution";
import {
  modelProviderIdSchema,
  runtimeSettingsModelSchema,
  threadIdSchema,
  type ModelProviderId,
  type RuntimePreference,
  type RuntimeProviderMetadata,
} from "@koda/protocol";
import { render } from "ink";

import { TuiController } from "./controller.js";
import { KodaTui } from "./view.js";

export interface RunTuiOptions {
  cwd?: string;
  provider?: string;
  model?: string;
  resume?: string;
  approvalMode?: string;
}

export interface TuiRuntime {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  connectAppServer?(): Promise<AppServerClientApi>;
}

export async function runTui(
  options: RunTuiOptions,
  runtime: TuiRuntime,
): Promise<number> {
  if (runtime.stdin.isTTY !== true || runtime.stdout.isTTY !== true) {
    runtime.stderr.write(
      "[koda-chat] An interactive TTY is required. Use 'koda run' or koda-app-server for automation.\n",
    );
    return 2;
  }
  let client: AppServerClientApi | undefined;
  let controller: TuiController | undefined;
  try {
    const workspace = await canonicalWorkspace(
      options.cwd ?? runtime.processDirectory,
      runtime.processDirectory,
    );
    const resumeThreadId =
      options.resume === undefined
        ? undefined
        : threadIdSchema.parse(options.resume);
    const approvalMode = selectedApprovalMode(options, runtime.environment);
    client =
      runtime.connectAppServer === undefined
        ? await connectDefaultAppServer(runtime)
        : await runtime.connectAppServer();
    const settings = await loadRuntimeSettings(client, workspace);
    const selection = resolveTuiRuntimeSelection(
      options,
      runtime.environment,
      settings.preference,
      client.initialization.providers,
    );
    controller = new TuiController(client, {
      cwd: workspace,
      provider: selection.provider,
      model: selection.model,
      approvalMode,
      settingsRevision: settings.revision,
      ...(settings.preference === undefined
        ? {}
        : { settingsPreference: settings.preference }),
      ...(settings.notice === undefined
        ? {}
        : { initialNotice: settings.notice }),
      ...(resumeThreadId === undefined ? {} : { resumeThreadId }),
    });
    const instance = render(<KodaTui controller={controller} />, {
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      exitOnCtrlC: false,
      interactive: true,
      alternateScreen: false,
      patchConsole: true,
      maxFps: 30,
    });
    await instance.waitUntilExit();
    return controller.getSnapshot().connection === "error" ? 1 : 0;
  } catch (error) {
    runtime.stderr.write(`[koda-chat] ${errorMessage(error)}\n`);
    return 1;
  } finally {
    controller?.dispose();
    if (client !== undefined) {
      await client.shutdown().catch(() => undefined);
    }
  }
}

async function connectDefaultAppServer(
  runtime: TuiRuntime,
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
      clientName: "koda-chat",
      clientVersion: KODA_VERSION,
    });
  }
  return NodeAppServerClient.connect({
    cwd: runtime.processDirectory,
    environment,
    clientName: "koda-chat",
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

export function resolveTuiRuntimeSelection(
  options: RunTuiOptions,
  environment: NodeJS.ProcessEnv,
  preference: RuntimePreference | undefined,
  providers: readonly RuntimeProviderMetadata[],
): { provider: ModelProviderId; model: string } {
  const provider = modelProviderIdSchema.parse(
    options.provider?.trim() ||
      environment.KODA_PROVIDER?.trim() ||
      preference?.provider ||
      "openai",
  );
  const metadata = providers.find((candidate) => candidate.id === provider);
  if (metadata === undefined) {
    throw new Error(`Provider '${provider}' is not supported by app-server.`);
  }
  const model = runtimeSettingsModelSchema.parse(
    options.model?.trim() ||
      environment.KODA_MODEL?.trim() ||
      (preference?.provider === provider ? preference.model : undefined) ||
      metadata.defaultModel,
  );
  return { provider, model };
}

async function loadRuntimeSettings(
  client: AppServerClientApi,
  workspace: string,
): Promise<{
  revision: number;
  preference?: RuntimePreference;
  notice?: string;
}> {
  try {
    const result = await client.getRuntimeSettings({ workspace });
    const notice =
      result.recovery === undefined
        ? result.diagnostics[0]?.message
        : `Recovered invalid settings to ${result.recovery.preferenceBackup}.`;
    return {
      revision: result.revision,
      ...(result.preference === undefined
        ? {}
        : { preference: result.preference }),
      ...(notice === undefined ? {} : { notice }),
    };
  } catch (error) {
    return {
      revision: 0,
      notice: `Could not load workspace settings; using startup defaults: ${errorMessage(error)}`,
    };
  }
}

function selectedApprovalMode(
  options: RunTuiOptions,
  environment: NodeJS.ProcessEnv,
): "on-request" | "never" {
  const value =
    options.approvalMode ?? environment.KODA_APPROVAL_MODE ?? "on-request";
  if (value !== "on-request" && value !== "never") {
    throw new Error("Approval mode must be either 'on-request' or 'never'.");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
