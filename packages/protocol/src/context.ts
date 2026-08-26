import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const repositoryInstructionSnapshotSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

export const turnContextSnapshotSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  workspaceRoot: z.string().min(1),
  approvalMode: z.enum(["on-request", "never"]),
  instructionsSha256: sha256Schema,
  repositoryInstructions: z.array(repositoryInstructionSnapshotSchema),
});

export type RepositoryInstructionSnapshot = z.infer<
  typeof repositoryInstructionSnapshotSchema
>;
export type TurnContextSnapshot = z.infer<typeof turnContextSnapshotSchema>;
