import {
  sha256CanonicalJson,
  type ToolEffect,
  type ToolRegistry,
} from "@koda/agent-core";
import {
  activePluginSnapshotSchema,
  disabledPluginSnapshotSchema,
  jsonObjectSchema,
  jsonValueSchema,
  pluginChangeSchema,
  type JsonObject,
  type JsonValue,
  type PluginChange,
  type PluginSnapshot,
} from "@koda/protocol";
import {
  ArtifactError,
  ArtifactStore,
  ProjectCommandTemplateCatalog,
  ProjectSkillCatalog,
  createProjectCommandTemplateSourceFromText,
  createProjectSkillSourceFromText,
  mergeProjectCommandTemplateCatalogs,
  mergeProjectSkillCatalogs,
} from "@koda/runtime-node";

import { loadPluginConfiguration, type PluginConfiguration } from "./config.js";
import {
  connectPluginStdio,
  type PluginConnection,
  type PluginConnectionFactory,
} from "./connection.js";
import { PluginHostError, errorMessage, pluginErrorCode } from "./errors.js";
import type {
  PluginInitializeResult,
  PluginToolContribution,
} from "./protocol.js";

const MAX_TOTAL_PLUGIN_TOOLS = 128;
const MAX_APPROVAL_DETAILS = 4_000;

interface RegisteredPluginTool {
  alias: string;
  configuration: PluginConfiguration;
  connection: PluginConnection;
  originalName: string;
  description: string;
  inputSchema: JsonObject;
  effect: ToolEffect;
  definitionSha256: string;
}

interface ActivePlugin {
  configuration: PluginConfiguration;
  connection: PluginConnection;
}

export interface PluginSessionDiagnostic {
  level: "warning";
  code: string;
  message: string;
}

export interface OpenPluginTurnSessionOptions {
  environment: NodeJS.ProcessEnv;
  kodaHome: string;
  processDirectory: string;
  artifactStore: ArtifactStore;
  projectSkills: ProjectSkillCatalog;
  projectCommandTemplates: ProjectCommandTemplateCatalog;
  signal: AbortSignal;
  connectionFactory?: PluginConnectionFactory;
}

export class PluginTurnSession {
  private closed = false;
  private registered = false;

  private constructor(
    private readonly active: ActivePlugin[],
    private readonly tools: RegisteredPluginTool[],
    public readonly skills: ProjectSkillCatalog,
    public readonly commandTemplates: ProjectCommandTemplateCatalog,
    public readonly snapshots: readonly PluginSnapshot[],
    public readonly diagnostics: readonly PluginSessionDiagnostic[],
    private readonly artifactStore: ArtifactStore,
  ) {}

  public static async open(
    options: OpenPluginTurnSessionOptions,
  ): Promise<PluginTurnSession> {
    const configured = await loadPluginConfiguration(options);
    const connectionFactory = options.connectionFactory ?? connectPluginStdio;
    const active: ActivePlugin[] = [];
    const tools: RegisteredPluginTool[] = [];
    const snapshots: PluginSnapshot[] = [];
    const diagnostics: PluginSessionDiagnostic[] = [];
    let skills = options.projectSkills;
    let commandTemplates = options.projectCommandTemplates;

    for (const configuration of configured.plugins) {
      let connection: PluginConnection | undefined;
      try {
        options.signal.throwIfAborted();
        connection = await connectionFactory(
          configuration,
          options.environment,
          options.signal,
        );
        const initialized = await connection.initialize(options.signal);
        const candidate = validateContributions(
          configuration,
          connection,
          initialized,
        );
        if (tools.length + candidate.tools.length > MAX_TOTAL_PLUGIN_TOOLS) {
          throw contributionError(
            `Plugin tools exceed the ${MAX_TOTAL_PLUGIN_TOOLS}-tool combined limit.`,
          );
        }
        const candidateSkills = new ProjectSkillCatalog(
          candidate.skills.map((source) =>
            createProjectSkillSourceFromText({
              path: `@plugin/${configuration.id}/skills/${source.name}/SKILL.md`,
              scope: `@plugin/${configuration.id}`,
              name: source.name,
              content: source.content,
            }),
          ),
        );
        const candidateTemplates = new ProjectCommandTemplateCatalog(
          candidate.commandTemplates.map((source) =>
            createProjectCommandTemplateSourceFromText({
              path: `@plugin/${configuration.id}/commands/${source.name}.md`,
              scope: `@plugin/${configuration.id}`,
              name: source.name,
              content: source.content,
            }),
          ),
        );
        const mergedSkills = mergeProjectSkillCatalogs(skills, candidateSkills);
        const mergedTemplates = mergeProjectCommandTemplateCatalogs(
          commandTemplates,
          candidateTemplates,
        );
        const snapshot = activePluginSnapshotSchema.parse({
          pluginId: configuration.id,
          status: "active",
          required: configuration.required,
          manifestSha256: configuration.manifestSha256,
          name: initialized.plugin.name,
          version: initialized.plugin.version,
          capabilities: configuration.capabilities,
          toolCount: candidate.tools.length,
          skillCount: candidate.skills.length,
          commandTemplateCount: candidate.commandTemplates.length,
          contributionsSha256: sha256CanonicalJson({
            tools: candidate.tools.map((tool) => ({
              alias: tool.alias,
              description: tool.description,
              inputSchema: tool.inputSchema,
              effect: tool.effect,
              definitionSha256: tool.definitionSha256,
            })),
            skills: candidateSkills.snapshots(),
            commandTemplates: candidateTemplates.snapshots(),
          }),
        });

        skills = mergedSkills;
        commandTemplates = mergedTemplates;
        tools.push(...candidate.tools);
        snapshots.push(snapshot);
        active.push({ configuration, connection });
      } catch (error) {
        if (connection !== undefined) {
          await connection.close().catch(() => undefined);
        }
        if (options.signal.aborted) {
          await closeActive(active);
          options.signal.throwIfAborted();
        }
        if (configuration.required) {
          await closeActive(active);
          throw normalizePluginFailure(configuration.id, error);
        }
        const code = pluginErrorCode(error);
        snapshots.push(
          disabledPluginSnapshotSchema.parse({
            pluginId: configuration.id,
            status: "disabled",
            required: false,
            manifestSha256: configuration.manifestSha256,
            errorCode: code,
          }),
        );
        diagnostics.push({
          level: "warning",
          code,
          message: `Optional plugin '${configuration.id}' was disabled: ${boundedMessage(error)}`,
        });
      }
    }

    return new PluginTurnSession(
      active,
      tools,
      skills,
      commandTemplates,
      Object.freeze(snapshots.map((snapshot) => Object.freeze(snapshot))),
      Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
      options.artifactStore,
    );
  }

  public registerTools(registry: ToolRegistry): void {
    if (this.registered) {
      throw contributionError(
        "Plugin tools are already registered for this Turn.",
      );
    }
    try {
      registry.replaceNamespace("plugin", (register) => {
        for (const tool of this.tools) {
          register({
            spec: {
              name: tool.alias,
              description: tool.description,
              inputJsonSchema: tool.inputSchema,
            },
            inputSchema: jsonObjectSchema,
            concurrency: "exclusive",
            effect: tool.effect,
            catalogIdentity: {
              source: "plugin",
              plugin_id: tool.configuration.id,
              original_name: tool.originalName,
              definition_sha256: tool.definitionSha256,
            },
            prepare: async (context, input) => ({
              approval: approvalPreview(tool, input),
              execute: async () => {
                if (this.closed) {
                  throw new PluginHostError(
                    "PLUGIN_CONNECTION_CLOSED",
                    `Plugin session for '${tool.configuration.id}' is closed.`,
                  );
                }
                const output = await tool.connection.callTool(
                  tool.originalName,
                  input,
                  tool.definitionSha256,
                  context.signal,
                );
                return materializePluginOutput(output, this.artifactStore);
              },
            }),
          });
        }
      });
      this.registered = true;
    } catch (error) {
      throw contributionError(
        `Plugin tool catalog conflicts with the Koda registry: ${errorMessage(error)}`,
        error,
      );
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors = await closeActive(this.active);
    if (errors.length > 0) {
      throw new PluginHostError(
        "PLUGIN_SESSION_CLEANUP_FAILED",
        `Could not close ${errors.length} plugin connection(s).`,
      );
    }
  }
}

export function diffPluginSnapshots(
  previous: readonly PluginSnapshot[],
  current: readonly PluginSnapshot[],
): PluginChange[] {
  const previousById = new Map(
    previous.map((snapshot) => [snapshot.pluginId, snapshot]),
  );
  const currentById = new Map(
    current.map((snapshot) => [snapshot.pluginId, snapshot]),
  );
  return [...new Set([...previousById.keys(), ...currentById.keys()])]
    .sort(comparePortable)
    .flatMap((pluginId) => {
      const before = previousById.get(pluginId);
      const after = currentById.get(pluginId);
      const change =
        before === undefined
          ? "added"
          : after === undefined
            ? "removed"
            : sha256CanonicalJson(before) === sha256CanonicalJson(after)
              ? undefined
              : "changed";
      return change === undefined
        ? []
        : [pluginChangeSchema.parse({ pluginId, change })];
    });
}

function validateContributions(
  configuration: PluginConfiguration,
  connection: PluginConnection,
  initialized: PluginInitializeResult,
): {
  tools: RegisteredPluginTool[];
  skills: NonNullable<PluginInitializeResult["contributions"]["skills"]>;
  commandTemplates: NonNullable<
    PluginInitializeResult["contributions"]["command_templates"]
  >;
} {
  const contributions = initialized.contributions;
  for (const [wireName, capability] of [
    ["tools", "tools"],
    ["skills", "skills"],
    ["command_templates", "command_templates"],
  ] as const) {
    const value = contributions[wireName];
    if (
      value !== undefined &&
      value.length > 0 &&
      !configuration.capabilities.includes(capability)
    ) {
      throw new PluginHostError(
        "PLUGIN_CAPABILITY_INVALID",
        `Plugin '${configuration.id}' returned unrequested '${capability}' contributions.`,
      );
    }
  }
  const definitions = contributions.tools ?? [];
  assertUniqueNames(
    configuration.id,
    "tool",
    definitions.map((definition) => definition.name),
  );
  assertUniqueNames(
    configuration.id,
    "Skill",
    (contributions.skills ?? []).map((source) => source.name),
  );
  assertUniqueNames(
    configuration.id,
    "command template",
    (contributions.command_templates ?? []).map((source) => source.name),
  );
  const discoveredToolNames = new Set(
    definitions.map((definition) => definition.name),
  );
  for (const configuredName of Object.keys(configuration.tools)) {
    if (!discoveredToolNames.has(configuredName)) {
      throw contributionError(
        `Plugin '${configuration.id}' configures unknown read tool '${configuredName}'.`,
      );
    }
  }
  return {
    tools: definitions.map((definition) =>
      normalizeTool(configuration, connection, definition),
    ),
    skills: contributions.skills ?? [],
    commandTemplates: contributions.command_templates ?? [],
  };
}

function normalizeTool(
  configuration: PluginConfiguration,
  connection: PluginConnection,
  definition: PluginToolContribution,
): RegisteredPluginTool {
  const snapshot = structuredClone(definition);
  const alias = `plugin__${configuration.id}__${snapshot.name}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(alias)) {
    throw contributionError(
      `Plugin tool '${configuration.id}/${snapshot.name}' cannot form a valid model alias.`,
    );
  }
  return {
    alias,
    configuration,
    connection,
    originalName: snapshot.name,
    description: snapshot.description,
    inputSchema: snapshot.inputSchema,
    effect: configuration.tools[snapshot.name]?.effect ?? "execute",
    definitionSha256: sha256CanonicalJson(snapshot),
  };
}

function approvalPreview(
  tool: RegisteredPluginTool,
  input: JsonObject,
): { title: string; summary: string; details: string } {
  const serialized = stableJsonStringify(input);
  return {
    title: `Call plugin tool ${tool.configuration.id}/${tool.originalName}`,
    summary: `Call external plugin tool '${tool.configuration.id}/${tool.originalName}'.`,
    details:
      serialized.length <= MAX_APPROVAL_DETAILS
        ? serialized
        : `${serialized.slice(0, MAX_APPROVAL_DETAILS - 3)}...`,
  };
}

async function materializePluginOutput(
  output: JsonValue,
  artifactStore: ArtifactStore,
): Promise<JsonValue> {
  const parsed = jsonValueSchema.parse(output);
  const serialized = stableJsonStringify(parsed);
  try {
    const materialized = await artifactStore.materializeText(serialized, {
      mediaType: "application/json",
    });
    if (!materialized.truncated) {
      return jsonValueSchema.parse(JSON.parse(materialized.text));
    }
    return jsonValueSchema.parse({
      content_excerpt: materialized.text,
      content_bytes: materialized.totalBytes,
      content_truncated: true,
      ...(materialized.artifact === undefined
        ? {}
        : { content_artifact: materialized.artifact }),
    });
  } catch (error) {
    if (
      error instanceof ArtifactError &&
      error.code === "ARTIFACT_OUTPUT_LIMIT_EXCEEDED"
    ) {
      throw new PluginHostError("PLUGIN_OUTPUT_LIMIT_EXCEEDED", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

async function closeActive(
  active: readonly ActivePlugin[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const plugin of [...active].reverse()) {
    try {
      await plugin.connection.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function normalizePluginFailure(
  pluginId: string,
  error: unknown,
): PluginHostError {
  return error instanceof PluginHostError
    ? error
    : contributionError(
        `Plugin '${pluginId}' contribution validation failed: ${boundedMessage(error)}`,
        error,
      );
}

function contributionError(message: string, cause?: unknown): PluginHostError {
  return new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function assertUniqueNames(
  pluginId: string,
  kind: string,
  names: readonly string[],
): void {
  if (new Set(names).size !== names.length) {
    throw contributionError(
      `Plugin '${pluginId}' returned duplicate ${kind} names.`,
    );
  }
}

function boundedMessage(error: unknown): string {
  const message = errorMessage(error)
    .replace(/[\r\n]+/gu, " ")
    .trim();
  return message.length <= 1_024 ? message : `${message.slice(0, 1_024)}…`;
}

function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => comparePortable(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
