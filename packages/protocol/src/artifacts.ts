import { z } from "zod";

import type { JsonValue } from "./json.js";

export const artifactSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const artifactIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const artifactReferenceSchema = z
  .object({
    type: z.literal("artifact"),
    id: artifactIdSchema,
    sha256: artifactSha256Schema,
    bytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
  })
  .superRefine((reference, context) => {
    if (reference.id !== `sha256:${reference.sha256}`) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Artifact ID must contain the artifact SHA-256 digest.",
      });
    }
  });

export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export function collectArtifactReferences(
  value: JsonValue,
): ArtifactReference[] {
  const references = new Map<ArtifactId, ArtifactReference>();

  const visit = (current: JsonValue): void => {
    if (Array.isArray(current)) {
      for (const entry of current) {
        visit(entry);
      }
      return;
    }
    if (current === null || typeof current !== "object") {
      return;
    }
    const parsed = artifactReferenceSchema.safeParse(current);
    if (parsed.success) {
      references.set(parsed.data.id, parsed.data);
      return;
    }
    for (const entry of Object.values(current)) {
      visit(entry);
    }
  };

  visit(value);
  return [...references.values()];
}
