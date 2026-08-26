import { z } from "zod";

import { jsonObjectSchema } from "./json.js";

export const modelProviderIdSchema = z.enum([
  "openai",
  "anthropic",
  "deepseek",
  "kimi",
  "glm",
]);

export const MAX_PROVIDER_STATE_BYTES = 262_144;

export const providerStateSchema = z
  .object({
    provider: modelProviderIdSchema,
    data: jsonObjectSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (providerStateBytes(state) > MAX_PROVIDER_STATE_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Provider continuation state cannot exceed ${MAX_PROVIDER_STATE_BYTES} bytes.`,
      });
    }
  });

export const providerMetadataSchema = z
  .object({
    id: modelProviderIdSchema,
    displayName: z.string().min(1),
    credentialEnvironmentVariable: z.string().min(1),
    defaultModel: z.string().min(1),
  })
  .strict();

export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;
export type ProviderState = z.infer<typeof providerStateSchema>;
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

export function providerStateBytes(state: {
  provider: ModelProviderId;
  data: unknown;
}): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}
