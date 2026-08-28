import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const MAX_PROJECT_SKILLS = 32;
export const SKILL_NAME_BUDGET_BYTES = 64;
export const SKILL_DESCRIPTION_BUDGET_BYTES = 512;

function utf8BoundedString(maximumBytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

export const skillIdSchema = z
  .string()
  .regex(/^skill:[a-f0-9]{64}$/u, "Skill ID must be a sha256 identity.");

export const skillNameSchema = utf8BoundedString(SKILL_NAME_BUDGET_BYTES)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "Skill name must use lower-case letters, digits, and single hyphens.",
  )
  .refine(
    (value) => value === value.trim(),
    "Skill name must not contain surrounding whitespace.",
  );

export const skillDescriptionSchema = utf8BoundedString(
  SKILL_DESCRIPTION_BUDGET_BYTES,
).refine(
  (value) => value === value.trim(),
  "Skill description must not contain surrounding whitespace.",
);

export const skillSnapshotSchema = z
  .object({
    skillId: skillIdSchema,
    name: skillNameSchema,
    description: skillDescriptionSchema,
    path: z.string().min(1),
    scope: z.string().min(1),
    bytes: z.number().int().safe().positive(),
    sha256: artifactSha256Schema,
  })
  .strict();

export const skillChangeSchema = z
  .object({
    skillId: skillIdSchema,
    name: skillNameSchema,
    path: z.string().min(1),
    scope: z.string().min(1),
    change: z.enum(["added", "removed", "changed"]),
  })
  .strict();

export type SkillId = z.infer<typeof skillIdSchema>;
export type SkillName = z.infer<typeof skillNameSchema>;
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export type SkillChange = z.infer<typeof skillChangeSchema>;
