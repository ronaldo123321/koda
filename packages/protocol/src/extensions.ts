import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";
import {
  MAX_PROJECT_COMMAND_TEMPLATES,
  commandTemplateIdSchema,
  commandTemplateSnapshotSchema,
} from "./command-templates.js";
import { threadIdSchema, turnIdSchema } from "./ids.js";
import {
  MAX_PLUGINS,
  pluginCapabilitySchema,
  pluginIdSchema,
  pluginSnapshotSchema,
} from "./plugins.js";
import {
  MAX_PROJECT_SKILLS,
  skillIdSchema,
  skillSnapshotSchema,
} from "./skills.js";
import { toolCatalogGenerationSnapshotSchema } from "./tool-catalogs.js";

export const EXTENSION_WORKSPACE_BUDGET_BYTES = 4_096;
export const EXTENSION_CATALOG_RESULT_BUDGET_BYTES = 256 * 1_024;
export const EXTENSION_READ_RESULT_BUDGET_BYTES = 80 * 1_024;
export const THREAD_EXTENSIONS_RESULT_BUDGET_BYTES = 256 * 1_024;

export const extensionWorkspaceSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      EXTENSION_WORKSPACE_BUDGET_BYTES,
    `Workspace must not exceed ${EXTENSION_WORKSPACE_BUDGET_BYTES} UTF-8 bytes.`,
  );

const configuredPluginCapabilitiesSchema = z
  .array(pluginCapabilitySchema)
  .min(1)
  .max(3)
  .superRefine((capabilities, context) => {
    for (let index = 1; index < capabilities.length; index += 1) {
      if (capabilities[index - 1]! >= capabilities[index]!) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Plugin capabilities must use stable unique ordering.",
        });
      }
    }
  });

export const configuredPluginSnapshotSchema = z
  .object({
    pluginId: pluginIdSchema,
    required: z.boolean(),
    capabilities: configuredPluginCapabilitiesSchema,
    manifestSha256: artifactSha256Schema,
  })
  .strict();

export const extensionCatalogParamsSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
  })
  .strict();

export const extensionCatalogResultSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
    catalogSha256: artifactSha256Schema,
    skills: z.array(skillSnapshotSchema).max(MAX_PROJECT_SKILLS),
    commandTemplates: z
      .array(commandTemplateSnapshotSchema)
      .max(MAX_PROJECT_COMMAND_TEMPLATES),
    configuredPlugins: z.array(configuredPluginSnapshotSchema).max(MAX_PLUGINS),
  })
  .strict()
  .superRefine((catalog, context) => {
    assertStableUnique(
      catalog.skills,
      (skill) =>
        `${String(scopeDepth(skill.scope)).padStart(6, "0")}\0${skill.scope}\0${skill.path}`,
      (skill) => skill.skillId,
      "Skills",
      ["skills"],
      context,
    );
    assertStableUnique(
      catalog.commandTemplates,
      (template) =>
        `${String(scopeDepth(template.scope)).padStart(6, "0")}\0${template.selector}`,
      (template) => template.templateId,
      "Command templates",
      ["commandTemplates"],
      context,
    );
    assertStableUnique(
      catalog.configuredPlugins,
      (plugin) => plugin.pluginId,
      (plugin) => plugin.pluginId,
      "Configured plugins",
      ["configuredPlugins"],
      context,
    );
  });

export const extensionSourceKindSchema = z.enum(["skill", "command_template"]);

export const extensionReadParamsSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
    kind: extensionSourceKindSchema,
    sourceId: z.union([skillIdSchema, commandTemplateIdSchema]),
  })
  .strict()
  .superRefine((params, context) => {
    const valid =
      (params.kind === "skill" &&
        skillIdSchema.safeParse(params.sourceId).success) ||
      (params.kind === "command_template" &&
        commandTemplateIdSchema.safeParse(params.sourceId).success);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "Source ID does not match the requested extension kind.",
      });
    }
  });

export const extensionReadResultSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
    kind: extensionSourceKindSchema,
    sourceId: z.union([skillIdSchema, commandTemplateIdSchema]),
    path: z.string().min(1),
    scope: z.string().min(1),
    sha256: artifactSha256Schema,
    totalBytes: z.number().int().safe().positive(),
    content: z.string(),
  })
  .strict()
  .superRefine((result, context) => {
    const valid =
      (result.kind === "skill" &&
        skillIdSchema.safeParse(result.sourceId).success) ||
      (result.kind === "command_template" &&
        commandTemplateIdSchema.safeParse(result.sourceId).success);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "Source ID does not match the extension kind.",
      });
    }
    if (
      new TextEncoder().encode(result.content).byteLength !== result.totalBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Extension source content must match totalBytes.",
      });
    }
  });

export const threadExtensionsParamsSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
    threadId: threadIdSchema,
    anchorSequence: z.number().int().safe().nonnegative().optional(),
  })
  .strict();

export const threadExtensionsResultSchema = z
  .object({
    workspace: extensionWorkspaceSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    anchorSequence: z.number().int().safe().nonnegative(),
    skills: z.array(skillSnapshotSchema).max(MAX_PROJECT_SKILLS),
    commandTemplates: z
      .array(commandTemplateSnapshotSchema)
      .max(MAX_PROJECT_COMMAND_TEMPLATES),
    toolCatalogGeneration: toolCatalogGenerationSnapshotSchema.optional(),
    plugins: z.array(pluginSnapshotSchema).max(MAX_PLUGINS),
  })
  .strict()
  .superRefine((snapshot, context) => {
    assertStableUnique(
      snapshot.skills,
      (skill) =>
        `${String(scopeDepth(skill.scope)).padStart(6, "0")}\0${skill.scope}\0${skill.path}`,
      (skill) => skill.skillId,
      "Skills",
      ["skills"],
      context,
    );
    assertStableUnique(
      snapshot.commandTemplates,
      (template) =>
        `${String(scopeDepth(template.scope)).padStart(6, "0")}\0${template.selector}`,
      (template) => template.templateId,
      "Command templates",
      ["commandTemplates"],
      context,
    );
    assertStableUnique(
      snapshot.plugins,
      (plugin) => plugin.pluginId,
      (plugin) => plugin.pluginId,
      "Plugins",
      ["plugins"],
      context,
    );
  });

function assertStableUnique<T>(
  values: readonly T[],
  ordering: (value: T) => string,
  identity: (value: T) => string,
  label: string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const identities = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = identity(value);
    if (identities.has(key)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `${label} must have unique identities.`,
      });
    }
    identities.add(key);
  }
  for (let index = 1; index < values.length; index += 1) {
    if (ordering(values[index - 1]!) >= ordering(values[index]!)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `${label} must use stable unique ordering.`,
      });
    }
  }
}

function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

export type ConfiguredPluginSnapshot = z.infer<
  typeof configuredPluginSnapshotSchema
>;
export type ExtensionCatalogParams = z.infer<
  typeof extensionCatalogParamsSchema
>;
export type ExtensionCatalogResult = z.infer<
  typeof extensionCatalogResultSchema
>;
export type ExtensionSourceKind = z.infer<typeof extensionSourceKindSchema>;
export type ExtensionReadParams = z.infer<typeof extensionReadParamsSchema>;
export type ExtensionReadResult = z.infer<typeof extensionReadResultSchema>;
export type ThreadExtensionsParams = z.infer<
  typeof threadExtensionsParamsSchema
>;
export type ThreadExtensionsResult = z.infer<
  typeof threadExtensionsResultSchema
>;
