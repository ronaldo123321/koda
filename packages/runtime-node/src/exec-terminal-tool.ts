import type { ToolRegistry } from "@koda/agent-core";
import { secretAliasSelectionSchema, type JsonValue } from "@koda/protocol";
import { z } from "zod";

import {
  SecretLeaseManager,
  SecretPolicyError,
  type SecretCommandBinding,
} from "./secret-policy.js";
import { WorkspaceCommandRunner } from "./workspace-command-runner.js";

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARACTERS = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 32_768;
const MAX_CWD_CHARACTERS = 4_096;
const MAX_DISPLAY_NAME_CHARACTERS = 128;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const terminalArgument = z
  .string()
  .max(MAX_ARGUMENT_CHARACTERS)
  .refine((value) => !value.includes("\0"), "Cannot contain a null byte.");

const execTerminalInput = z
  .object({
    argv: z
      .array(terminalArgument)
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
    timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
    lifecycle: z.enum(["foreground", "background"]),
    display_name: z
      .string()
      .min(1)
      .max(MAX_DISPLAY_NAME_CHARACTERS)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= MAX_DISPLAY_NAME_CHARACTERS &&
          !/[\u0000-\u001F\u007F]/u.test(value),
        "Must fit in 128 UTF-8 bytes without control characters.",
      )
      .optional(),
    secrets: secretAliasSelectionSchema.optional(),
  })
  .strict();

export interface ExecTerminalToolOptions {
  secretLeaseManager?: SecretLeaseManager;
}

export function registerExecTerminalTool(
  registry: ToolRegistry,
  runner: WorkspaceCommandRunner,
  options: ExecTerminalToolOptions = {},
): void {
  if (!runner.supportsInteractiveProcesses) return;
  const configuredSecretAliases =
    options.secretLeaseManager?.aliasesFor("exec_terminal") ?? [];
  registry.register({
    spec: {
      name: "exec_terminal",
      description:
        "Start one durable interactive PTY process with structured arguments and return its job handle without waiting for exit. Koda does not parse shell syntax, and direct shell interpreters, pipelines, or redirection are unsupported. A secrets list may request only aliases exposed by trusted Koda configuration; secret-bearing execution always needs a fresh approval. Every start requires visible approval; use the process pane to attach, send input, resize, detach, or terminate it.",
      inputJsonSchema: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            description:
              "Executable followed by arguments as separate strings. Do not join them into a shell command.",
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
            description:
              "Required process lifetime limit in milliseconds, up to 24 hours.",
            minimum: MIN_TIMEOUT_MS,
            maximum: MAX_TIMEOUT_MS,
          },
          lifecycle: {
            type: "string",
            enum: ["foreground", "background"],
            description:
              "Whether the durable job is foreground-oriented or an explicitly continuing background task.",
          },
          display_name: {
            type: "string",
            description: "Optional safe label shown in the process pane.",
            maxLength: MAX_DISPLAY_NAME_CHARACTERS,
          },
          secrets: {
            type: "array",
            description:
              "Optional trusted secret aliases. Values and host environment names are never accepted here.",
            items: {
              type: "string",
              ...(configuredSecretAliases.length === 0
                ? {}
                : { enum: [...configuredSecretAliases] }),
            },
            maxItems: 16,
            uniqueItems: true,
          },
        },
        required: ["argv", "timeout_ms", "lifecycle"],
        additionalProperties: false,
      },
    },
    inputSchema: execTerminalInput,
    ...(options.secretLeaseManager === undefined
      ? {}
      : {
          catalogIdentity:
            options.secretLeaseManager.catalogIdentity("exec_terminal"),
        }),
    concurrency: "exclusive",
    effect: "execute",
    prepare: async (context, input) => {
      context.signal.throwIfAborted();
      const command = await runner.prepareTerminal({
        argv: input.argv,
        timeoutMs: input.timeout_ms,
        lifecycle: input.lifecycle,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.display_name === undefined
          ? {}
          : { displayName: input.display_name }),
      });
      const secretBinding: SecretCommandBinding = {
        toolName: "exec_terminal",
        workspaceRoot: runner.root,
        cwd: command.cwd,
        argv: command.argv,
        timeoutMs: command.timeoutMs,
        lifecycle: command.lifecycle,
        displayName: command.displayName,
        security: command.security,
      };
      const requestedSecrets = input.secrets ?? [];
      const secretLease =
        requestedSecrets.length === 0
          ? undefined
          : options.secretLeaseManager === undefined
            ? (() => {
                throw new SecretPolicyError("SECRET_ALIAS_NOT_CONFIGURED");
              })()
            : await options.secretLeaseManager.prepare(
                "exec_terminal",
                requestedSecrets,
                secretBinding,
              );
      return {
        freshApprovalRequired: secretLease !== undefined,
        approval: {
          title: command.title,
          summary: command.summary,
          details:
            secretLease === undefined
              ? command.preview
              : secretLease.approvalDetails(command.preview),
        },
        ...(secretLease === undefined
          ? {}
          : { dispose: () => secretLease.destroy() }),
        execute: async (): Promise<JsonValue> => {
          return {
            ...(await command.execute(
              context.signal,
              secretLease,
              secretBinding,
            )),
          };
        },
      };
    },
  });
}
