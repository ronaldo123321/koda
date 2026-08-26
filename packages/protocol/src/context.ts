import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const repositoryInstructionSnapshotSchema = z.object({
  path: z.string().min(1),
  scope: z.string().min(1).default("."),
  bytes: z.number().int().nonnegative(),
  sha256: artifactSha256Schema,
});

export const turnContextSnapshotSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  workspaceRoot: z.string().min(1),
  approvalMode: z.enum(["on-request", "never"]),
  instructionsSha256: artifactSha256Schema,
  repositoryInstructions: z.array(repositoryInstructionSnapshotSchema),
});

export type RepositoryInstructionSnapshot = z.infer<
  typeof repositoryInstructionSnapshotSchema
>;
export type TurnContextSnapshot = z.infer<typeof turnContextSnapshotSchema>;
