import { createHash } from "node:crypto";

import type { ToolRegistry } from "@koda/agent-core";
import {
  APPROVAL_GRANT_DEFAULT_TTL_SECONDS,
  APPROVAL_GRANT_MAXIMUM_TTL_SECONDS,
  secretAliasSelectionSchema,
  type JsonValue,
} from "@koda/protocol";
import { z } from "zod";

import { WorkspaceCommandRunner } from "./workspace-command-runner.js";
import {
  SecretLeaseManager,
  SecretPolicyError,
  type SecretCommandBinding,
} from "./secret-policy.js";

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
    secrets: secretAliasSelectionSchema.optional(),
  })
  .strict();

export interface ExecCommandToolOptions {
  secretLeaseManager?: SecretLeaseManager;
}

export function registerExecCommandTool(
  registry: ToolRegistry,
  runner: WorkspaceCommandRunner,
  options: ExecCommandToolOptions = {},
): void {
  const configuredSecretAliases =
    options.secretLeaseManager?.aliasesFor("exec_command") ?? [];
  registry.register({
    spec: {
      name: "exec_command",
      description:
        "Run one non-interactive foreground command with structured arguments. Koda does not parse shell syntax, and direct shell interpreters, pipelines, redirection, background sessions, and stdin are unsupported. A secrets list may request only aliases exposed by trusted Koda configuration; secret-bearing execution always needs a fresh approval. The command may still have arbitrary side effects and requires runtime approval.",
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
        required: ["argv"],
        additionalProperties: false,
      },
    },
    inputSchema: execCommandInput,
    ...(options.secretLeaseManager === undefined
      ? {}
      : {
          catalogIdentity:
            options.secretLeaseManager.catalogIdentity("exec_command"),
        }),
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
      const secretBinding: SecretCommandBinding = {
        toolName: "exec_command",
        workspaceRoot: runner.root,
        cwd: command.cwd,
        argv: command.argv,
        timeoutMs: command.timeoutMs,
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
                "exec_command",
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
          ...(secretLease === undefined
            ? {
                grantCandidate: {
                  kind: "exact_command" as const,
                  key: createHash("sha256")
                    .update(
                      JSON.stringify({
                        version: 2,
                        toolName: "exec_command",
                        workspaceRoot: runner.root,
                        cwd: command.cwd,
                        argv: command.argv,
                        timeoutMs: command.timeoutMs,
                        policyDigest:
                          command.security.kind === "policy"
                            ? command.security.policy_digest
                            : "legacy_unknown",
                        backend:
                          command.security.kind === "policy"
                            ? command.security.backend
                            : "legacy_unknown",
                        capabilitiesDigest:
                          command.security.kind === "policy"
                            ? command.security.capabilities_digest
                            : "legacy_unknown",
                      }),
                    )
                    .digest("hex"),
                  summary: boundedUtf8(command.preview, 1_024),
                  defaultExpiresInSeconds: APPROVAL_GRANT_DEFAULT_TTL_SECONDS,
                  maximumExpiresInSeconds: APPROVAL_GRANT_MAXIMUM_TTL_SECONDS,
                },
              }
            : {}),
        },
        ...(secretLease === undefined
          ? {}
          : { dispose: () => secretLease.destroy() }),
        execute: async (): Promise<JsonValue> => {
          if (secretLease !== undefined) {
            secretLease.rejectUnavailable(secretBinding);
          }
          return {
            ...(await command.execute(context.signal, context.report)),
          };
        },
      };
    },
  });
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }
  return `${bytes
    .subarray(0, maximumBytes - 3)
    .toString("utf8")
    .replace(/\uFFFD$/u, "")}...`;
}
