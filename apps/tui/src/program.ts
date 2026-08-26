import { Command, Option } from "commander";

import { runTui, type RunTuiOptions, type TuiRuntime } from "./run.js";

export interface TuiProgramRuntime extends TuiRuntime {
  setExitCode(code: number): void;
}

export function createTuiProgram(runtime: TuiProgramRuntime): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => runtime.stdout.write(text),
    writeErr: (text) => runtime.stderr.write(text),
  });
  program
    .name("koda-chat")
    .description("Interactive Koda coding-agent chat")
    .version("0.1.0")
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
    .action(async (options: RunTuiOptions) => {
      runtime.setExitCode(await runTui(options, runtime));
    });
  return program;
}
