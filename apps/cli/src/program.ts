import { Command, Option } from "commander";

import { runArtifactGarbageCollectionCommand } from "./artifact-command.js";
import type { TextWriter } from "./console-event-sink.js";
import { runCommand, type RunCommandInput } from "./run-command.js";
import {
  runThreadListCommand,
  runThreadShowCommand,
} from "./thread-command.js";

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
    .version("0.1.0");

  program
    .command("run")
    .description("Run one coding-agent turn")
    .argument("<prompt...>", "task for Koda")
    .option("-C, --cwd <directory>", "workspace directory")
    .option("-m, --model <model>", "OpenAI model ID")
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

  return program;
}
