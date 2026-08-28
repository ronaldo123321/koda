import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { KodaApplication } from "@koda/app";

import type { TextWriter } from "./console-event-sink.js";

export interface WorkspaceMutationCommandRuntime {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export async function runWorkspaceMutationConflictListCommand(
  options: { workspace?: string },
  runtime: WorkspaceMutationCommandRuntime,
): Promise<number> {
  return runJsonCommand(runtime, async (application) =>
    application.listWorkspaceMutationConflicts(options.workspace ?? "."),
  );
}

export async function runWorkspaceMutationConflictInspectCommand(
  conflictId: string,
  options: { workspace?: string },
  runtime: WorkspaceMutationCommandRuntime,
): Promise<number> {
  return runJsonCommand(runtime, async (application) =>
    application.inspectWorkspaceMutationConflict({
      workspace: options.workspace ?? ".",
      conflictId,
    }),
  );
}

export async function runWorkspaceMutationBackupExportCommand(
  conflictId: string,
  operationIndexInput: string,
  options: { workspace?: string; stateToken?: string; output?: string },
  runtime: WorkspaceMutationCommandRuntime,
): Promise<number> {
  const operationIndex = Number(operationIndexInput);
  if (
    !Number.isInteger(operationIndex) ||
    operationIndex < 0 ||
    operationIndex > 15
  ) {
    runtime.stderr.write(
      "error: operation index must be an integer from 0 to 15\n",
    );
    return 2;
  }
  if (options.stateToken === undefined || options.output === undefined) {
    runtime.stderr.write("error: --state-token and --output are required\n");
    return 2;
  }
  try {
    const application = createApplication(runtime);
    const result = await application.exportWorkspaceMutationBackup({
      workspace: options.workspace ?? ".",
      conflictId,
      stateToken: options.stateToken,
      operationIndex,
    });
    const outputPath = resolve(runtime.processDirectory, options.output);
    const handle = await open(outputPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(result.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    runtime.stdout.write(
      `${JSON.stringify(
        {
          workspace: result.workspace,
          conflictId: result.conflictId,
          operationIndex: result.operationIndex,
          output: outputPath,
          bytes: result.bytes.byteLength,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    writeCommandError(runtime.stderr, error);
    return 1;
  }
}

export async function runWorkspaceMutationConflictResolveCommand(
  conflictId: string,
  options: {
    workspace?: string;
    stateToken?: string;
    action?: string;
  },
  runtime: WorkspaceMutationCommandRuntime,
): Promise<number> {
  if (options.stateToken === undefined || options.action === undefined) {
    runtime.stderr.write("error: --state-token and --action are required\n");
    return 2;
  }
  const resolution =
    options.action === "restore-original"
      ? "restore_original"
      : options.action === "accept-current"
        ? "accept_current"
        : undefined;
  if (resolution === undefined) {
    runtime.stderr.write(
      "error: --action must be 'restore-original' or 'accept-current'\n",
    );
    return 2;
  }
  try {
    const result = await createApplication(
      runtime,
    ).resolveWorkspaceMutationConflict({
      workspace: options.workspace ?? ".",
      conflictId,
      stateToken: options.stateToken,
      resolution,
    });
    runtime.stdout.write(
      `${JSON.stringify(
        {
          workspace: result.workspace,
          conflictId: result.receipt.conflictId,
          resolution: result.receipt.resolution,
          stateToken: result.receipt.stateToken,
          resolvedAt: result.receipt.resolvedAt,
          audit: result.audit,
          acknowledged: result.acknowledged,
        },
        null,
        2,
      )}\n`,
    );
    if (!result.acknowledged) {
      runtime.stderr.write(
        "warning: filesystem resolution completed, but writes remain blocked until the originating audit can be reconciled\n",
      );
      return 1;
    }
    return 0;
  } catch (error) {
    writeCommandError(runtime.stderr, error);
    return 1;
  }
}

async function runJsonCommand(
  runtime: WorkspaceMutationCommandRuntime,
  operation: (application: KodaApplication) => Promise<unknown>,
): Promise<number> {
  try {
    const result = await operation(createApplication(runtime));
    runtime.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    writeCommandError(runtime.stderr, error);
    return 1;
  }
}

function createApplication(
  runtime: WorkspaceMutationCommandRuntime,
): KodaApplication {
  return new KodaApplication({
    environment: runtime.environment,
    processDirectory: runtime.processDirectory,
  });
}

function writeCommandError(stderr: TextWriter, error: unknown): void {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "WORKSPACE_MUTATION_COMMAND_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`error: ${code}: ${message}\n`);
}
