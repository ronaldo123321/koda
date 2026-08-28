import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const MAX_PROJECT_COMMAND_TEMPLATES = 32;
export const MAX_COMMAND_TEMPLATE_PARAMETERS = 16;
export const COMMAND_TEMPLATE_NAME_BUDGET_BYTES = 64;
export const COMMAND_TEMPLATE_DESCRIPTION_BUDGET_BYTES = 512;
export const COMMAND_TEMPLATE_PARAMETER_NAME_BUDGET_BYTES = 64;
export const COMMAND_TEMPLATE_PARAMETER_DESCRIPTION_BUDGET_BYTES = 512;
export const COMMAND_TEMPLATE_PARAMETER_MAXIMUM_BYTES = 4 * 1_024;
export const COMMAND_TEMPLATE_SELECTOR_BUDGET_BYTES = 1_024;

function utf8BoundedString(maximumBytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

export const commandTemplateIdSchema = z
  .string()
  .regex(
    /^command-template:[a-f0-9]{64}$/u,
    "Command template ID must be a sha256 identity.",
  );

export const commandTemplateNameSchema = utf8BoundedString(
  COMMAND_TEMPLATE_NAME_BUDGET_BYTES,
)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "Command template name must use lower-case letters, digits, and single hyphens.",
  )
  .refine(
    (value) => value === value.trim(),
    "Command template name must not contain surrounding whitespace.",
  );

export const commandTemplateDescriptionSchema = utf8BoundedString(
  COMMAND_TEMPLATE_DESCRIPTION_BUDGET_BYTES,
).refine(
  (value) => value === value.trim(),
  "Command template description must not contain surrounding whitespace.",
);

export const commandTemplateParameterNameSchema = utf8BoundedString(
  COMMAND_TEMPLATE_PARAMETER_NAME_BUDGET_BYTES,
)
  .regex(
    /^[a-z][a-z0-9_]*$/u,
    "Command template parameter names must use lower-case snake case.",
  )
  .refine(
    (value) => value === value.trim(),
    "Command template parameter names must not contain surrounding whitespace.",
  );

export const commandTemplateParameterDescriptionSchema = utf8BoundedString(
  COMMAND_TEMPLATE_PARAMETER_DESCRIPTION_BUDGET_BYTES,
).refine(
  (value) => value === value.trim(),
  "Command template parameter descriptions must not contain surrounding whitespace.",
);

export const commandTemplateSelectorSchema = utf8BoundedString(
  COMMAND_TEMPLATE_SELECTOR_BUDGET_BYTES,
).regex(
  /^(?:[A-Za-z0-9._@-]+\/)*[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  "Command template selector must be a portable scope path followed by a template name.",
);

export const commandTemplateParameterSchema = z
  .object({
    name: commandTemplateParameterNameSchema,
    description: commandTemplateParameterDescriptionSchema,
    type: z.literal("string"),
    required: z.boolean(),
    maxBytes: z
      .number()
      .int()
      .safe()
      .positive()
      .max(COMMAND_TEMPLATE_PARAMETER_MAXIMUM_BYTES),
  })
  .strict();

export const commandTemplateSnapshotSchema = z
  .object({
    templateId: commandTemplateIdSchema,
    name: commandTemplateNameSchema,
    description: commandTemplateDescriptionSchema,
    selector: commandTemplateSelectorSchema,
    path: z.string().min(1),
    scope: z.string().min(1),
    bytes: z.number().int().safe().positive(),
    sha256: artifactSha256Schema,
    parameters: z
      .array(commandTemplateParameterSchema)
      .max(MAX_COMMAND_TEMPLATE_PARAMETERS),
  })
  .strict();

export const commandTemplateActivationSchema = z
  .object({
    templateId: commandTemplateIdSchema,
    selector: commandTemplateSelectorSchema,
    templateSha256: artifactSha256Schema,
    argumentsSha256: artifactSha256Schema,
    renderedSha256: artifactSha256Schema,
    renderedBytes: z.number().int().safe().positive(),
  })
  .strict();

export const commandTemplateChangeSchema = z
  .object({
    templateId: commandTemplateIdSchema,
    name: commandTemplateNameSchema,
    selector: commandTemplateSelectorSchema,
    path: z.string().min(1),
    scope: z.string().min(1),
    change: z.enum(["added", "removed", "changed"]),
  })
  .strict();

export type CommandTemplateId = z.infer<typeof commandTemplateIdSchema>;
export type CommandTemplateParameter = z.infer<
  typeof commandTemplateParameterSchema
>;
export type CommandTemplateSnapshot = z.infer<
  typeof commandTemplateSnapshotSchema
>;
export type CommandTemplateActivation = z.infer<
  typeof commandTemplateActivationSchema
>;
export type CommandTemplateChange = z.infer<typeof commandTemplateChangeSchema>;
