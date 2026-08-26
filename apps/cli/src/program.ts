import { Command, Option } from "commander";

import type { TextWriter } from "./console-event-sink.js";
import { runCommand, type RunCommandInput } from "./run-command.js";

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
    .addOption(
      new Option(
        "--approval-mode <mode>",
        "write and command approval behavior",
      ).choices(["on-request", "never"]),
    )
    .action(
      async (
        promptParts: string[],
        options: { approvalMode?: string; cwd?: string; model?: string },
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

  return program;
}
