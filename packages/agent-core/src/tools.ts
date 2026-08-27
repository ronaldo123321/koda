import type {
  JsonObject,
  JsonValue,
  ProcessOwnership,
  ProcessTerminationAttempt,
  ProcessTerminationMechanism,
  ProcessTerminationOutcome,
  ProcessTerminationReason,
  ThreadId,
  ToolCallId,
  TurnId,
  WorkspaceChangeSetCommittedPayload,
  WorkspaceChangeSetPreparedPayload,
  WorkspaceChangeSetRolledBackPayload,
  WorkspaceChangeSetUncertainPayload,
} from "@koda/protocol";
import { jsonValueSchema } from "@koda/protocol";
import type { z } from "zod";

import type { ModelToolDefinition } from "./model.js";
import type { ToolApprovalPreview, ToolEffect } from "./policy.js";

export interface ToolContext {
  threadId: ThreadId;
  turnId: TurnId;
  callId: ToolCallId;
  signal: AbortSignal;
  report?: (event: ToolOperationalEvent) => Promise<void>;
}

export type ToolOperationalEvent =
  | {
      type: "process.started";
      payload: { pid: number; ownership: ProcessOwnership };
    }
  | {
      type: "process.exited";
      payload: {
        pid: number;
        exitCode: number | null;
        signal: string | null;
      };
    }
  | {
      type: "process.termination_requested";
      payload: {
        pid: number;
        reason: ProcessTerminationReason;
        attempt: ProcessTerminationAttempt;
        mechanism: ProcessTerminationMechanism;
      };
    }
  | {
      type: "process.termination_completed";
      payload: {
        pid: number;
        reason: ProcessTerminationReason;
        outcome: ProcessTerminationOutcome;
      };
    }
  | {
      type: "workspace.change_set_prepared";
      payload: WorkspaceChangeSetPreparedPayload;
    }
  | {
      type: "workspace.change_set_committed";
      payload: WorkspaceChangeSetCommittedPayload;
    }
  | {
      type: "workspace.change_set_rolled_back";
      payload: WorkspaceChangeSetRolledBackPayload;
    }
  | {
      type: "workspace.change_set_uncertain";
      payload: WorkspaceChangeSetUncertainPayload;
    };

export class ToolOperationalEventError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolOperationalEventError";
  }
}

export type ToolExecutionResult =
  | { status: "success"; output: JsonValue }
  | {
      status: "error";
      error: { code: string; message: string };
    };

export interface ToolRegistration<Input> {
  spec: ModelToolDefinition;
  inputSchema: z.ZodType<Input>;
  concurrency: "parallel" | "exclusive";
  effect: ToolEffect;
  execute?: (context: ToolContext, input: Input) => Promise<JsonValue>;
  prepare?: (
    context: ToolContext,
    input: Input,
  ) => Promise<PreparedToolHandler>;
}

interface ErasedToolRegistration {
  spec: ModelToolDefinition;
  inputSchema: z.ZodType<unknown>;
  concurrency: "parallel" | "exclusive";
  effect: ToolEffect;
  execute?: (context: ToolContext, input: unknown) => Promise<JsonValue>;
  prepare?: (
    context: ToolContext,
    input: unknown,
  ) => Promise<PreparedToolHandler>;
}

export interface PreparedToolHandler {
  approval: ToolApprovalPreview;
  execute(): Promise<JsonValue>;
}

export interface PreparedToolInvocation {
  effect: ToolEffect;
  approval?: ToolApprovalPreview;
  execute(): Promise<ToolExecutionResult>;
}

export type ToolPreparationResult =
  | { status: "ready"; invocation: PreparedToolInvocation }
  | { status: "error"; result: ToolExecutionResult };

export interface ToolInvocation {
  callId: ToolCallId;
  name: string;
  arguments: JsonObject;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ErasedToolRegistration>();

  public register<Input>(registration: ToolRegistration<Input>): void {
    if (this.tools.has(registration.spec.name)) {
      throw new Error(`Tool already registered: ${registration.spec.name}`);
    }

    if (
      (registration.execute === undefined) ===
      (registration.prepare === undefined)
    ) {
      throw new Error(
        `Tool '${registration.spec.name}' must define exactly one of execute or prepare.`,
      );
    }

    const execute = registration.execute;
    const prepare = registration.prepare;
    const erased: ErasedToolRegistration = {
      spec: registration.spec,
      inputSchema: registration.inputSchema as z.ZodType<unknown>,
      concurrency: registration.concurrency,
      effect: registration.effect,
      ...(execute === undefined
        ? {}
        : {
            execute: async (context: ToolContext, input: unknown) =>
              execute(context, input as Input),
          }),
      ...(prepare === undefined
        ? {}
        : {
            prepare: async (context: ToolContext, input: unknown) =>
              prepare(context, input as Input),
          }),
    };
    this.tools.set(registration.spec.name, erased);
  }

  public definitions(): readonly ModelToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.spec)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async prepare(
    invocation: ToolInvocation,
    context: Omit<ToolContext, "callId">,
  ): Promise<ToolPreparationResult> {
    const tool = this.tools.get(invocation.name);
    if (tool === undefined) {
      return {
        status: "error",
        result: {
          status: "error",
          error: {
            code: "UNKNOWN_TOOL",
            message: `No tool is registered with the name '${invocation.name}'.`,
          },
        },
      };
    }

    const parsed = tool.inputSchema.safeParse(invocation.arguments);
    if (!parsed.success) {
      return {
        status: "error",
        result: {
          status: "error",
          error: {
            code: "INVALID_TOOL_ARGUMENTS",
            message: parsed.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "input"}: ${issue.message}`,
              )
              .join("; "),
          },
        },
      };
    }

    context.signal.throwIfAborted();
    try {
      const toolContext = { ...context, callId: invocation.callId };
      const prepared: {
        approval?: ToolApprovalPreview;
        execute(): Promise<JsonValue>;
      } =
        tool.prepare === undefined
          ? {
              execute: async () => {
                if (tool.execute === undefined) {
                  throw new Error("Tool has no execution handler.");
                }
                return tool.execute(toolContext, parsed.data);
              },
            }
          : await tool.prepare(toolContext, parsed.data);
      let executed = false;
      return {
        status: "ready",
        invocation: {
          effect: tool.effect,
          ...(prepared.approval === undefined
            ? {}
            : { approval: prepared.approval }),
          execute: async () => {
            if (executed) {
              return {
                status: "error",
                error: {
                  code: "TOOL_ALREADY_EXECUTED",
                  message: "A prepared tool invocation can execute only once.",
                },
              };
            }
            executed = true;
            context.signal.throwIfAborted();
            try {
              const output = await prepared.execute();
              context.signal.throwIfAborted();
              const parsedOutput = jsonValueSchema.safeParse(output);
              return parsedOutput.success
                ? { status: "success", output: parsedOutput.data }
                : {
                    status: "error",
                    error: {
                      code: "INVALID_TOOL_OUTPUT",
                      message:
                        "The tool returned a value that is not JSON serializable.",
                    },
                  };
            } catch (error) {
              if (error instanceof ToolOperationalEventError) {
                throw error;
              }
              if (context.signal.aborted) {
                throw error;
              }
              return {
                status: "error",
                error: toToolError(error, "TOOL_EXECUTION_FAILED"),
              };
            }
          },
        },
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return {
        status: "error",
        result: {
          status: "error",
          error: toToolError(error, "TOOL_PREPARATION_FAILED"),
        },
      };
    }
  }
}

function toToolError(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string } {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
      ? error.code
      : fallbackCode;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
