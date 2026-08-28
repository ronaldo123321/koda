import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const MAX_PLUGINS = 8;
export const MAX_PLUGIN_TOOLS = 64;
export const MAX_PLUGIN_SKILLS = 32;
export const MAX_PLUGIN_COMMAND_TEMPLATES = 32;

export const pluginIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,23}$/u,
    "Plugin ID must use lower-case letters, digits, underscores, or hyphens.",
  );

export const pluginCapabilitySchema = z.enum([
  "tools",
  "skills",
  "command_templates",
]);

const pluginCapabilitiesSchema = z
  .array(pluginCapabilitySchema)
  .max(3)
  .superRefine((capabilities, context) => {
    const unique = new Set(capabilities);
    if (unique.size !== capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "Plugin capabilities must be unique.",
      });
    }
    for (let index = 1; index < capabilities.length; index += 1) {
      if (capabilities[index - 1]! >= capabilities[index]!) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Plugin capabilities must use stable ordering.",
        });
      }
    }
  });

const boundedText = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    )
    .refine(
      (value) => value === value.trim() && !value.includes("\0"),
      "Text must be trimmed and cannot contain a null byte.",
    );

export const activePluginSnapshotSchema = z
  .object({
    pluginId: pluginIdSchema,
    status: z.literal("active"),
    required: z.boolean(),
    manifestSha256: artifactSha256Schema,
    name: boundedText(256),
    version: boundedText(128),
    capabilities: pluginCapabilitiesSchema,
    toolCount: z.number().int().safe().nonnegative().max(MAX_PLUGIN_TOOLS),
    skillCount: z.number().int().safe().nonnegative().max(MAX_PLUGIN_SKILLS),
    commandTemplateCount: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(MAX_PLUGIN_COMMAND_TEMPLATES),
    contributionsSha256: artifactSha256Schema,
  })
  .strict();

export const disabledPluginSnapshotSchema = z
  .object({
    pluginId: pluginIdSchema,
    status: z.literal("disabled"),
    required: z.literal(false),
    manifestSha256: artifactSha256Schema,
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
  })
  .strict();

export const pluginSnapshotSchema = z.discriminatedUnion("status", [
  activePluginSnapshotSchema,
  disabledPluginSnapshotSchema,
]);

export const pluginChangeSchema = z
  .object({
    pluginId: pluginIdSchema,
    change: z.enum(["added", "removed", "changed"]),
  })
  .strict();

export type PluginId = z.infer<typeof pluginIdSchema>;
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export type ActivePluginSnapshot = z.infer<typeof activePluginSnapshotSchema>;
export type DisabledPluginSnapshot = z.infer<
  typeof disabledPluginSnapshotSchema
>;
export type PluginSnapshot = z.infer<typeof pluginSnapshotSchema>;
export type PluginChange = z.infer<typeof pluginChangeSchema>;
