import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { NodeAppServerClient } from "@koda/app-server-client-node";
import {
  modelProviderIdSchema,
  threadIdSchema,
  type ModelProviderId,
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
  let client: NodeAppServerClient | undefined;
  let controller: TuiController | undefined;
  try {
    const workspace = await canonicalWorkspace(
      options.cwd ?? runtime.processDirectory,
      runtime.processDirectory,
    );
    const provider = selectedProvider(options, runtime.environment);
    const model = options.model ?? runtime.environment.KODA_MODEL;
    const resumeThreadId =
      options.resume === undefined
        ? undefined
        : threadIdSchema.parse(options.resume);
    const approvalMode = selectedApprovalMode(options, runtime.environment);
    client = await NodeAppServerClient.connect({
      cwd: runtime.processDirectory,
      environment: runtime.environment,
      clientName: "koda-chat",
      clientVersion: "0.1.0",
    });
    if (!client.initialization.providers.some((item) => item.id === provider)) {
      throw new Error(`Provider '${provider}' is not supported by app-server.`);
    }
    controller = new TuiController(client, {
      cwd: workspace,
      provider,
      approvalMode,
      ...(model === undefined ? {} : { model }),
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

function selectedProvider(
  options: RunTuiOptions,
  environment: NodeJS.ProcessEnv,
): ModelProviderId {
  return modelProviderIdSchema.parse(
    options.provider ?? environment.KODA_PROVIDER ?? "openai",
  );
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
