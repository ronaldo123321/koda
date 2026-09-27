import type { ToolContext, ToolRegistry } from "@koda/agent-core";
import { threadIdSchema, type JsonValue, type ThreadId } from "@koda/protocol";
import { z } from "zod";

const spawnInput = z
  .object({ task: z.string().trim().min(1).max(4_000) })
  .strict();
const waitInput = z
  .object({
    childThreadIds: z.array(threadIdSchema).min(1).max(8),
    timeoutMs: z.number().int().min(0).max(30_000).default(0),
  })
  .strict();
const sendInput = z
  .object({
    childThreadId: threadIdSchema,
    message: z.string().trim().min(1).max(4_096),
  })
  .strict();
const interruptInput = z.object({ childThreadId: threadIdSchema }).strict();

export interface ReadOnlyChildToolActions {
  spawn(context: ToolContext, task: string): Promise<JsonValue>;
  wait(
    context: ToolContext,
    childThreadIds: readonly ThreadId[],
    timeoutMs: number,
  ): Promise<JsonValue>;
  send(
    context: ToolContext,
    childThreadId: ThreadId,
    message: string,
  ): Promise<JsonValue>;
  interrupt(context: ToolContext, childThreadId: ThreadId): Promise<JsonValue>;
}

export function registerReadOnlyChildTools(
  registry: ToolRegistry,
  actions: ReadOnlyChildToolActions,
): void {
  registry.register({
    spec: {
      name: "spawn_readonly",
      description:
        "Start an independent read-only child thread and return immediately with its ID. At most two child runs can start per parent turn. Use wait_children, send_child_message, or interrupt_child to coordinate it.",
      inputJsonSchema: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 1, maxLength: 4_000 },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    inputSchema: spawnInput,
    concurrency: "exclusive",
    effect: "control",
    execute: (context, input) => actions.spawn(context, input.task),
  });
  registry.register({
    spec: {
      name: "wait_children",
      description:
        "Wait up to 30 seconds for one of your read-only child threads, or inspect their current status with timeoutMs 0. Returns bounded answers for completed children.",
      inputJsonSchema: {
        type: "object",
        properties: {
          childThreadIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 8,
          },
          timeoutMs: { type: "integer", minimum: 0, maximum: 30_000 },
        },
        required: ["childThreadIds"],
        additionalProperties: false,
      },
    },
    inputSchema: waitInput,
    concurrency: "exclusive",
    effect: "control",
    execute: (context, input) =>
      actions.wait(context, input.childThreadIds, input.timeoutMs),
  });
  registry.register({
    spec: {
      name: "send_child_message",
      description:
        "Queue a message for the next model step of one of your active read-only child threads. The child may reject it if its final step has begun.",
      inputJsonSchema: {
        type: "object",
        properties: {
          childThreadId: { type: "string" },
          message: { type: "string", minLength: 1, maxLength: 4_096 },
        },
        required: ["childThreadId", "message"],
        additionalProperties: false,
      },
    },
    inputSchema: sendInput,
    concurrency: "exclusive",
    effect: "control",
    execute: (context, input) =>
      actions.send(context, input.childThreadId, input.message),
  });
  registry.register({
    spec: {
      name: "interrupt_child",
      description: "Cancel one of your active read-only child threads.",
      inputJsonSchema: {
        type: "object",
        properties: { childThreadId: { type: "string" } },
        required: ["childThreadId"],
        additionalProperties: false,
      },
    },
    inputSchema: interruptInput,
    concurrency: "exclusive",
    effect: "control",
    execute: (context, input) =>
      actions.interrupt(context, input.childThreadId),
  });
}
