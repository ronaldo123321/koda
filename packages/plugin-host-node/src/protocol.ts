import {
  MAX_PLUGIN_COMMAND_TEMPLATES,
  MAX_PLUGIN_SKILLS,
  MAX_PLUGIN_TOOLS,
  commandTemplateNameSchema,
  artifactSha256Schema,
  jsonObjectSchema,
  jsonValueSchema,
  pluginIdSchema,
  skillNameSchema,
  type JsonObject,
  type JsonValue,
  type PluginCapability,
  type PluginId,
} from "@koda/protocol";
import { z } from "zod";

export const PLUGIN_PROTOCOL_VERSION = 1 as const;
export const MAX_PLUGIN_TOOL_SCHEMA_BYTES = 65_536;
export const MAX_PLUGIN_INITIALIZE_BYTES = 1_048_576;
export const MAX_PLUGIN_MESSAGE_BYTES = 68_157_440;

const boundedText = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    )
    .refine(
      (value) => value === value.trim() && !value.includes("\0"),
      "Text must be trimmed and cannot contain a null byte.",
    );

export const pluginToolContributionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    description: boundedText(512),
    inputSchema: jsonObjectSchema.refine(
      (schema) => schema.type === "object",
      "Plugin tool inputSchema must describe an object.",
    ),
  })
  .strict()
  .superRefine((tool, context) => {
    if (
      Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8") >
      MAX_PLUGIN_TOOL_SCHEMA_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["inputSchema"],
        message: `Plugin tool schema exceeds ${MAX_PLUGIN_TOOL_SCHEMA_BYTES} bytes.`,
      });
    }
  });

export const pluginSkillContributionSchema = z
  .object({
    name: skillNameSchema,
    content: z.string().min(1),
  })
  .strict();

export const pluginCommandTemplateContributionSchema = z
  .object({
    name: commandTemplateNameSchema,
    content: z.string().min(1),
  })
  .strict();

export const pluginInitializeResultSchema = z
  .object({
    protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
    plugin: z
      .object({
        name: boundedText(256),
        version: boundedText(128),
      })
      .strict(),
    contributions: z
      .object({
        tools: z
          .array(pluginToolContributionSchema)
          .max(MAX_PLUGIN_TOOLS)
          .optional(),
        skills: z
          .array(pluginSkillContributionSchema)
          .max(MAX_PLUGIN_SKILLS)
          .optional(),
        command_templates: z
          .array(pluginCommandTemplateContributionSchema)
          .max(MAX_PLUGIN_COMMAND_TEMPLATES)
          .optional(),
      })
      .strict(),
  })
  .strict();

export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int().safe().positive(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int().safe(),
        message: boundedText(2_048),
        data: jsonValueSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.result === undefined) === (response.error === undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "JSON-RPC response must contain exactly one of result or error.",
      });
    }
  });

export interface PluginInitializeParams extends JsonObject {
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  host: { name: "koda"; version: string };
  plugin: { id: PluginId };
  capabilities: PluginCapability[];
}

export interface PluginToolCallParams extends JsonObject {
  name: string;
  arguments: JsonObject;
  definitionSha256: string;
}

export type PluginToolContribution = z.infer<
  typeof pluginToolContributionSchema
>;
export type PluginSkillContribution = z.infer<
  typeof pluginSkillContributionSchema
>;
export type PluginCommandTemplateContribution = z.infer<
  typeof pluginCommandTemplateContributionSchema
>;
export type PluginInitializeResult = z.infer<
  typeof pluginInitializeResultSchema
>;

export function initializeParams(
  pluginId: PluginId,
  capabilities: PluginCapability[],
): PluginInitializeParams {
  return {
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    host: { name: "koda", version: "0.1.0" },
    plugin: { id: pluginIdSchema.parse(pluginId) },
    capabilities: [...capabilities],
  };
}

export function toolCallParams(
  name: string,
  arguments_: JsonObject,
  definitionSha256: string,
): PluginToolCallParams {
  return {
    name,
    arguments: arguments_,
    definitionSha256: artifactSha256Schema.parse(definitionSha256),
  };
}

export function parsePluginOutput(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}
