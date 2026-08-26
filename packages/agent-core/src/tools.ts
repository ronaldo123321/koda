import type {
  JsonObject,
  JsonValue,
  ThreadId,
  ToolCallId,
  TurnId,
} from "@koda/protocol";
import { jsonValueSchema } from "@koda/protocol";
import type { z } from "zod";

import type { ModelToolDefinition } from "./model.js";

export interface ToolContext {
  threadId: ThreadId;
  turnId: TurnId;
  callId: ToolCallId;
  signal: AbortSignal;
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
  execute(context: ToolContext, input: Input): Promise<JsonValue>;
}

interface ErasedToolRegistration {
  spec: ModelToolDefinition;
  inputSchema: z.ZodType<unknown>;
  concurrency: "parallel" | "exclusive";
  execute(context: ToolContext, input: unknown): Promise<JsonValue>;
}

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

    const erased: ErasedToolRegistration = {
      spec: registration.spec,
      inputSchema: registration.inputSchema as z.ZodType<unknown>,
      concurrency: registration.concurrency,
      execute: async (context, input) =>
        registration.execute(context, input as Input),
    };
    this.tools.set(registration.spec.name, erased);
  }

  public definitions(): readonly ModelToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.spec)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async execute(
    invocation: ToolInvocation,
    context: Omit<ToolContext, "callId">,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(invocation.name);
    if (tool === undefined) {
      return {
        status: "error",
        error: {
          code: "UNKNOWN_TOOL",
          message: `No tool is registered with the name '${invocation.name}'.`,
        },
      };
    }

    const parsed = tool.inputSchema.safeParse(invocation.arguments);
    if (!parsed.success) {
      return {
        status: "error",
        error: {
          code: "INVALID_TOOL_ARGUMENTS",
          message: parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
            )
            .join("; "),
        },
      };
    }

    context.signal.throwIfAborted();
    try {
      const output = await tool.execute(
        { ...context, callId: invocation.callId },
        parsed.data,
      );
      context.signal.throwIfAborted();
      const parsedOutput = jsonValueSchema.safeParse(output);
      if (!parsedOutput.success) {
        return {
          status: "error",
          error: {
            code: "INVALID_TOOL_OUTPUT",
            message: "The tool returned a value that is not JSON serializable.",
          },
        };
      }
      return { status: "success", output: parsedOutput.data };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return {
        status: "error",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
