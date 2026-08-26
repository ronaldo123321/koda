import type { ToolRegistry } from "@koda/agent-core";
import type { JsonValue } from "@koda/protocol";
import { z } from "zod";

import { WorkspaceCommandRunner } from "./workspace-command-runner.js";

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARACTERS = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 32_768;
const MAX_CWD_CHARACTERS = 4_096;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;

const commandArgument = z
  .string()
  .max(MAX_ARGUMENT_CHARACTERS)
  .refine((value) => !value.includes("\0"), "Cannot contain a null byte.");

const execCommandInput = z
  .object({
    argv: z
      .array(commandArgument)
      .min(1)
      .max(MAX_ARGUMENTS)
      .superRefine((argv, context) => {
        const totalBytes = argv.reduce(
          (total, argument) => total + Buffer.byteLength(argument, "utf8"),
          0,
        );
        if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
          context.addIssue({
            code: "custom",
            message: `Command arguments exceed the ${MAX_TOTAL_ARGUMENT_BYTES}-byte total limit.`,
          });
        }
        if ((argv[0] ?? "").trim().length === 0) {
          context.addIssue({
            code: "custom",
            message: "Command executable must not be empty.",
          });
        }
      }),
    cwd: z
      .string()
      .min(1)
      .max(MAX_CWD_CHARACTERS)
      .refine((value) => !value.includes("\0"), "Cannot contain a null byte.")
      .optional(),
    timeout_ms: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .optional(),
  })
  .strict();

export function registerExecCommandTool(
  registry: ToolRegistry,
  runner: WorkspaceCommandRunner,
): void {
  registry.register({
    spec: {
      name: "exec_command",
      description:
        "Run one non-interactive foreground command with structured arguments. Koda does not parse shell syntax, and direct shell interpreters, pipelines, redirection, background sessions, and stdin are unsupported. The command may still have arbitrary side effects and requires runtime approval.",
      inputJsonSchema: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            description:
              "Executable followed by its arguments as separate strings. Do not join them into a shell command.",
            items: { type: "string", maxLength: MAX_ARGUMENT_CHARACTERS },
            minItems: 1,
            maxItems: MAX_ARGUMENTS,
          },
          cwd: {
            type: "string",
            description:
              "Optional workspace-relative working directory. Defaults to '.'.",
            maxLength: MAX_CWD_CHARACTERS,
          },
          timeout_ms: {
            type: "integer",
            description: "Optional timeout in milliseconds. Defaults to 30000.",
            minimum: MIN_TIMEOUT_MS,
            maximum: MAX_TIMEOUT_MS,
          },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    },
    inputSchema: execCommandInput,
    concurrency: "exclusive",
    effect: "execute",
    prepare: async (context, input) => {
      context.signal.throwIfAborted();
      const command = await runner.prepare({
        argv: input.argv,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeout_ms === undefined
          ? {}
          : { timeoutMs: input.timeout_ms }),
      });
      return {
        approval: {
          title: command.title,
          summary: command.summary,
          details: command.preview,
        },
        execute: async (): Promise<JsonValue> => ({
          ...(await command.execute(context.signal, context.report)),
        }),
      };
    },
  });
}
