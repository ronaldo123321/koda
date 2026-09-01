import { Command, Option } from "commander";

import { KODA_VERSION } from "@koda/distribution";

import { runArtifactGarbageCollectionCommand } from "./artifact-command.js";
import type { TextWriter } from "./console-event-sink.js";
import {
  runExtensionListCommand,
  runExtensionReadCommand,
} from "./extension-command.js";
import { runCommand, type RunCommandInput } from "./run-command.js";
import { runSetupCommand } from "./setup-command.js";
import {
  runThreadListCommand,
  runThreadShowCommand,
} from "./thread-command.js";
import {
  runWorkspaceMutationBackupExportCommand,
  runWorkspaceMutationConflictInspectCommand,
  runWorkspaceMutationConflictListCommand,
  runWorkspaceMutationConflictResolveCommand,
} from "./workspace-mutation-command.js";

export interface ProgramRuntime {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdin?: NodeJS.ReadableStream;
  stdout: TextWriter;
  stderr: TextWriter;
  setExitCode(code: number): void;
}

export function createProgram(runtime: ProgramRuntime): Command {
  const program = new Command();
  // Configure this before adding subcommands so Commander copies the override
  // into each child command instead of terminating the host process directly.
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      runtime.stdout.write(text);
    },
    writeErr: (text) => {
      runtime.stderr.write(text);
    },
  });
  program
    .name("koda")
    .description("A local-first coding agent")
    .version(KODA_VERSION);

  program
    .command("run")
    .description("Run one coding-agent turn")
    .argument("<prompt...>", "task for Koda")
    .option("-C, --cwd <directory>", "workspace directory")
    .option("-m, --model <model>", "model ID for the selected provider")
    .addOption(
      new Option("-p, --provider <provider>", "model provider").choices([
        "openai",
        "anthropic",
        "deepseek",
        "kimi",
        "glm",
      ]),
    )
    .option("--resume <thread-id>", "resume an existing Koda thread")
    .addOption(
      new Option(
        "--approval-mode <mode>",
        "write and command approval behavior",
      ).choices(["on-request", "never"]),
    )
    .action(
      async (
        promptParts: string[],
        options: {
          approvalMode?: string;
          cwd?: string;
          model?: string;
          provider?: string;
          resume?: string;
        },
      ) => {
        const controller = new AbortController();
        let interrupted = false;
        const onSigint = () => {
          if (interrupted) {
            return;
          }
          interrupted = true;
          controller.abort("Interrupted by user.");
        };
        process.once("SIGINT", onSigint);
        try {
          const input: RunCommandInput = {
            prompt: promptParts.join(" "),
            signal: controller.signal,
            ...(options.approvalMode === undefined
              ? {}
              : { approvalMode: options.approvalMode }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.provider === undefined
              ? {}
              : { provider: options.provider }),
            ...(options.resume === undefined ? {} : { resume: options.resume }),
          };
          const exitCode = await runCommand(input, {
            environment: runtime.environment,
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
            stdin: runtime.stdin ?? process.stdin,
          });
          runtime.setExitCode(exitCode);
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      },
    );

  program
    .command("setup")
    .description("Configure a workspace provider and model")
    .option("-C, --cwd <directory>", "workspace directory")
    .option("-m, --model <model>", "model ID for the selected provider")
    .addOption(
      new Option("-p, --provider <provider>", "model provider").choices([
        "openai",
        "anthropic",
        "deepseek",
        "kimi",
        "glm",
      ]),
    )
    .option("--json", "emit a stable machine-readable result")
    .action(
      async (options: {
        cwd?: string;
        json?: boolean;
        model?: string;
        provider?: string;
      }) => {
        runtime.setExitCode(
          await runSetupCommand(options, {
            environment: runtime.environment,
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
            ...(runtime.stdin === undefined ? {} : { stdin: runtime.stdin }),
          }),
        );
      },
    );

  const thread = program
    .command("thread")
    .description("Inspect local Koda thread metadata");
  thread
    .command("list")
    .description("List local Koda threads")
    .option("--limit <count>", "maximum threads to show", "50")
    .option("--workspace <directory>", "filter by canonical workspace")
    .action(async (options: { limit?: string; workspace?: string }) => {
      runtime.setExitCode(
        await runThreadListCommand(options, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const extension = program
    .command("extension")
    .description("Inspect current Koda extensions without starting a turn");
  extension
    .command("list")
    .description("List current project Skills, templates, and plugin manifests")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (options: { workspace?: string }) => {
      runtime.setExitCode(
        await runExtensionListCommand(options, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });
  extension
    .command("read")
    .description("Read one validated current extension source")
    .argument("<kind>", "skill or command-template")
    .argument("<source-id>", "stable extension source ID")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        kind: string,
        sourceId: string,
        options: { workspace?: string },
      ) => {
        if (kind !== "skill" && kind !== "command-template") {
          runtime.stderr.write(
            "error: extension kind must be 'skill' or 'command-template'\n",
          );
          runtime.setExitCode(2);
          return;
        }
        runtime.setExitCode(
          await runExtensionReadCommand(kind, sourceId, options, {
            environment: runtime.environment,
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
          }),
        );
      },
    );
  thread
    .command("show")
    .description("Show one local Koda thread")
    .argument("<thread-id>", "Koda thread ID")
    .action(async (threadId: string) => {
      runtime.setExitCode(
        await runThreadShowCommand(threadId, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const artifact = program
    .command("artifact")
    .description("Maintain local Koda artifacts");
  artifact
    .command("gc")
    .description("Find or delete unreferenced artifact blobs")
    .option("--delete", "delete eligible unreferenced artifacts")
    .option(
      "--min-age-hours <hours>",
      "minimum age of an unreferenced artifact",
      "24",
    )
    .action(async (options: { delete?: boolean; minAgeHours?: string }) => {
      runtime.setExitCode(
        await runArtifactGarbageCollectionCommand(options, {
          environment: runtime.environment,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const recovery = program
    .command("recovery")
    .description(
      "Inspect and explicitly resolve quarantined workspace changes",
    );
  recovery
    .command("list")
    .description("List quarantined workspace mutation conflicts")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (options: { workspace?: string }) => {
      runtime.setExitCode(
        await runWorkspaceMutationConflictListCommand(options, runtime),
      );
    });
  recovery
    .command("inspect")
    .description("Inspect one workspace mutation conflict")
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (conflictId: string, options: { workspace?: string }) => {
      runtime.setExitCode(
        await runWorkspaceMutationConflictInspectCommand(
          conflictId,
          options,
          runtime,
        ),
      );
    });
  recovery
    .command("export")
    .description(
      "Export one verified original backup without overwriting a file",
    )
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .argument("<operation-index>", "operation index containing a backup")
    .requiredOption("--state-token <sha256>", "token returned by inspection")
    .requiredOption(
      "--output <file>",
      "new output file; existing files are rejected",
    )
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        conflictId: string,
        operationIndex: string,
        options: {
          workspace?: string;
          stateToken?: string;
          output?: string;
        },
      ) => {
        runtime.setExitCode(
          await runWorkspaceMutationBackupExportCommand(
            conflictId,
            operationIndex,
            options,
            runtime,
          ),
        );
      },
    );
  recovery
    .command("resolve")
    .description("Resolve one inspected conflict using its exact state token")
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .requiredOption("--state-token <sha256>", "token returned by inspection")
    .addOption(
      new Option("--action <action>", "explicit resolution action")
        .choices(["restore-original", "accept-current"])
        .makeOptionMandatory(),
    )
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        conflictId: string,
        options: { workspace?: string; stateToken?: string; action?: string },
      ) => {
        runtime.setExitCode(
          await runWorkspaceMutationConflictResolveCommand(
            conflictId,
            options,
            runtime,
          ),
        );
      },
    );

  return program;
}
