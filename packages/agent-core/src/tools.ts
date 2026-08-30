import type {
  JsonObject,
  JsonValue,
  ProcessOwnership,
  ProcessTerminationAttempt,
  ProcessTerminationMechanism,
  ProcessTerminationOutcome,
  ProcessTerminationReason,
  ExecutionSecuritySnapshot,
  PlanUpdatedPayload,
  PlanAcceptanceRequest,
  PlanAcceptanceResolution,
  ThreadId,
  ToolCallId,
  TurnId,
  WorkspaceChangeSetCommittedPayload,
  WorkspaceChangeSetPreparedPayload,
  WorkspaceChangeSetRolledBackPayload,
  WorkspaceChangeSetUncertainPayload,
  ToolCatalogChange,
  ToolCatalogGenerationSnapshot,
} from "@koda/protocol";
import {
  jsonValueSchema,
  toolCatalogChangeSchema,
  toolCatalogGenerationSnapshotSchema,
} from "@koda/protocol";
import type { z } from "zod";

import type { ModelToolDefinition } from "./model.js";
import type { ToolApprovalPreview, ToolEffect } from "./policy.js";
import { digestModelTools, sha256CanonicalJson } from "./context-engine.js";

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
      payload: {
        pid: number;
        ownership: ProcessOwnership;
        security: ExecutionSecuritySnapshot;
      };
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
    }
  | {
      type: "plan.updated";
      payload: Omit<PlanUpdatedPayload, "callId">;
    }
  | {
      type: "plan.acceptance_requested";
      payload: Omit<PlanAcceptanceRequest, "callId">;
    }
  | {
      type: "plan.acceptance_resolved";
      payload: Omit<PlanAcceptanceResolution, "callId">;
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
  catalogIdentity?: JsonValue;
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
  catalogIdentity?: JsonValue;
  execute?: (context: ToolContext, input: unknown) => Promise<JsonValue>;
  prepare?: (
    context: ToolContext,
    input: unknown,
  ) => Promise<PreparedToolHandler>;
}

export interface PreparedToolHandler {
  approval: ToolApprovalPreview;
  freshApprovalRequired?: boolean;
  execute(): Promise<JsonValue>;
  dispose?(): void | Promise<void>;
}

export interface PreparedToolInvocation {
  effect: ToolEffect;
  approval?: ToolApprovalPreview;
  freshApprovalRequired: boolean;
  execute(): Promise<ToolExecutionResult>;
  dispose(): Promise<void>;
}

export type ToolPreparationResult =
  | { status: "ready"; invocation: PreparedToolInvocation }
  | { status: "error"; result: ToolExecutionResult };

export interface ToolInvocation {
  callId: ToolCallId;
  name: string;
  arguments: JsonObject;
}

export interface ToolCatalogReplacement {
  previous: ToolCatalogGenerationSnapshot;
  current: ToolCatalogGenerationSnapshot;
  changes: ToolCatalogChange[];
}

export class ToolRegistry {
  private tools = new Map<string, ErasedToolRegistration>();
  private toolOwners = new Map<string, string | undefined>();

  public register<Input>(registration: ToolRegistration<Input>): void {
    if (this.tools.has(registration.spec.name)) {
      throw new Error(`Tool already registered: ${registration.spec.name}`);
    }
    this.tools.set(registration.spec.name, eraseRegistration(registration));
    this.toolOwners.set(registration.spec.name, undefined);
  }

  public definitions(): readonly ModelToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.spec)
      .sort((left, right) => comparePortable(left.name, right.name));
  }

  public catalogGeneration(): ToolCatalogGenerationSnapshot {
    return catalogGeneration(this.tools);
  }

  public replaceNamespace(
    namespace: string,
    populate: (
      register: <Input>(registration: ToolRegistration<Input>) => void,
    ) => void,
  ): ToolCatalogReplacement {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(namespace)) {
      throw new Error(`Invalid tool namespace: ${namespace}`);
    }
    const staged = new Map<string, ErasedToolRegistration>();
    populate(<Input>(registration: ToolRegistration<Input>) => {
      if (staged.has(registration.spec.name)) {
        throw new Error(
          `Tool already registered in namespace '${namespace}': ${registration.spec.name}`,
        );
      }
      const owner = this.toolOwners.get(registration.spec.name);
      if (this.tools.has(registration.spec.name) && owner !== namespace) {
        throw new Error(
          `Tool '${registration.spec.name}' conflicts with an existing Koda tool.`,
        );
      }
      staged.set(registration.spec.name, eraseRegistration(registration));
    });

    const previous = this.catalogGeneration();
    const previousNamespace = new Map(
      [...this.tools].filter(
        ([name]) => this.toolOwners.get(name) === namespace,
      ),
    );
    const candidate = new Map(
      [...this.tools].filter(
        ([name]) => this.toolOwners.get(name) !== namespace,
      ),
    );
    for (const [name, registration] of staged) {
      candidate.set(name, registration);
    }
    const current = catalogGeneration(candidate);
    const changes = diffRegistrations(previousNamespace, staged);

    this.tools = candidate;
    this.toolOwners = new Map(
      [...this.toolOwners].filter(([, owner]) => owner !== namespace),
    );
    for (const name of staged.keys()) {
      this.toolOwners.set(name, namespace);
    }
    return { previous, current, changes };
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
        freshApprovalRequired?: boolean;
        execute(): Promise<JsonValue>;
        dispose?(): void | Promise<void>;
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
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await prepared.dispose?.();
      };
      return {
        status: "ready",
        invocation: {
          effect: tool.effect,
          ...(prepared.approval === undefined
            ? {}
            : { approval: prepared.approval }),
          freshApprovalRequired: prepared.freshApprovalRequired ?? false,
          dispose,
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
            try {
              context.signal.throwIfAborted();
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
            } finally {
              await dispose();
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

function eraseRegistration<Input>(
  registration: ToolRegistration<Input>,
): ErasedToolRegistration {
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
  return {
    spec: registration.spec,
    inputSchema: registration.inputSchema as z.ZodType<unknown>,
    concurrency: registration.concurrency,
    effect: registration.effect,
    ...(registration.catalogIdentity === undefined
      ? {}
      : {
          catalogIdentity: jsonValueSchema.parse(registration.catalogIdentity),
        }),
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
}

function catalogGeneration(
  tools: ReadonlyMap<string, ErasedToolRegistration>,
): ToolCatalogGenerationSnapshot {
  const entries = [...tools]
    .sort(([left], [right]) => comparePortable(left, right))
    .map(([name, registration]) => ({
      name,
      sha256: registrationDigest(registration),
    }));
  const definitions = [...tools.values()]
    .map((tool) => tool.spec)
    .sort((left, right) => comparePortable(left.name, right.name));
  return toolCatalogGenerationSnapshotSchema.parse({
    generationId: `tool-catalog:${sha256CanonicalJson(entries)}`,
    toolCount: entries.length,
    toolsSha256: digestModelTools(definitions),
  });
}

function diffRegistrations(
  previous: ReadonlyMap<string, ErasedToolRegistration>,
  current: ReadonlyMap<string, ErasedToolRegistration>,
): ToolCatalogChange[] {
  const names = [...new Set([...previous.keys(), ...current.keys()])].sort(
    comparePortable,
  );
  const changes: ToolCatalogChange[] = [];
  for (const name of names) {
    const before = previous.get(name);
    const after = current.get(name);
    const beforeSha256 =
      before === undefined ? undefined : registrationDigest(before);
    const afterSha256 =
      after === undefined ? undefined : registrationDigest(after);
    if (beforeSha256 === afterSha256) {
      continue;
    }
    changes.push(
      toolCatalogChangeSchema.parse({
        name,
        change:
          before === undefined
            ? "added"
            : after === undefined
              ? "removed"
              : "changed",
        ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
        ...(afterSha256 === undefined ? {} : { afterSha256 }),
      }),
    );
  }
  return changes;
}

function registrationDigest(registration: ErasedToolRegistration): string {
  return sha256CanonicalJson({
    spec: registration.spec,
    concurrency: registration.concurrency,
    effect: registration.effect,
    catalogIdentity: registration.catalogIdentity,
  });
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
