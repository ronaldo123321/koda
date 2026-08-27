import { z } from "zod";

export const APPROVAL_GRANT_DEFAULT_TTL_SECONDS = 15 * 60;
export const APPROVAL_GRANT_MINIMUM_TTL_SECONDS = 60;
export const APPROVAL_GRANT_MAXIMUM_TTL_SECONDS = 60 * 60;
export const APPROVAL_GRANT_MAXIMUM_RECORDS = 64;

const utf8BoundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );

export const approvalGrantIdSchema = z
  .string()
  .regex(/^grant:[A-Za-z0-9_-]{1,120}$/u);

export const approvalGrantKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const approvalGrantKindSchema = z.literal("exact_command");

export const approvalGrantCandidateSchema = z
  .object({
    kind: approvalGrantKindSchema,
    key: approvalGrantKeySchema,
    summary: utf8BoundedString(1_024),
    defaultExpiresInSeconds: z.literal(APPROVAL_GRANT_DEFAULT_TTL_SECONDS),
    maximumExpiresInSeconds: z.literal(APPROVAL_GRANT_MAXIMUM_TTL_SECONDS),
  })
  .strict();

export const approvalGrantSelectionSchema = z
  .object({
    expiresInSeconds: z
      .number()
      .int()
      .safe()
      .min(APPROVAL_GRANT_MINIMUM_TTL_SECONDS)
      .max(APPROVAL_GRANT_MAXIMUM_TTL_SECONDS),
  })
  .strict();

export const approvalGrantRecordSchema = z
  .object({
    id: approvalGrantIdSchema,
    kind: approvalGrantKindSchema,
    toolName: z.literal("exec_command"),
    workspaceRoot: utf8BoundedString(4_096),
    key: approvalGrantKeySchema,
    summary: utf8BoundedString(1_024),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    uses: z.number().int().safe().nonnegative(),
  })
  .strict()
  .superRefine((record, context) => {
    const lifetimeMs =
      Date.parse(record.expiresAt) - Date.parse(record.createdAt);
    if (lifetimeMs <= 0) {
      context.addIssue({
        code: "custom",
        message: "Grant expiry must be later than its creation time.",
        path: ["expiresAt"],
      });
    } else if (lifetimeMs > APPROVAL_GRANT_MAXIMUM_TTL_SECONDS * 1_000) {
      context.addIssue({
        code: "custom",
        message: `Grant lifetime must not exceed ${APPROVAL_GRANT_MAXIMUM_TTL_SECONDS} seconds.`,
        path: ["expiresAt"],
      });
    }
  });

export type ApprovalGrantId = z.infer<typeof approvalGrantIdSchema>;
export type ApprovalGrantKind = z.infer<typeof approvalGrantKindSchema>;
export type ApprovalGrantCandidate = z.infer<
  typeof approvalGrantCandidateSchema
>;
export type ApprovalGrantSelection = z.infer<
  typeof approvalGrantSelectionSchema
>;
export type ApprovalGrantRecord = z.infer<typeof approvalGrantRecordSchema>;
