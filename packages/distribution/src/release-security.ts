import { z } from "zod";

import { releaseRelativePathSchema, sha256Schema } from "./contracts.js";
import {
  EMBEDDED_NODE_RELEASE_SIGNER_FINGERPRINT,
  EMBEDDED_NODE_SIGNED_CHECKSUMS_SHA256,
  EMBEDDED_NODE_VERSION,
  NODE_RELEASE_KEYS_COMMIT,
  NODE_RELEASE_KEYS_REPOSITORY,
  NODE_RELEASE_KEYS_SHA256,
  embeddedNodeArtifact,
  embeddedNodeArtifactSchema,
} from "./embedded-node.js";
import { sourceCommitSchema } from "./release.js";
import {
  KODA_VERSION,
  MACOS_CODE_SIGNATURE_EVIDENCE_SCHEMA_VERSION,
  MACOS_NOTARIZATION_EVIDENCE_SCHEMA_VERSION,
  MACOS_PUBLIC_RELEASE_PROVENANCE_SCHEMA_VERSION,
  NODE_RELEASE_PROVENANCE_SCHEMA_VERSION,
} from "./version.js";

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const CODE_DIRECTORY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RUN_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAXIMUM_SIGNED_FILES = 64;

export const nodeReleaseProvenanceSchema = z
  .object({
    schema_version: z.literal(NODE_RELEASE_PROVENANCE_SCHEMA_VERSION),
    project: z.literal("nodejs"),
    version: z.literal(EMBEDDED_NODE_VERSION),
    inventory: z
      .object({
        name: z.literal("SHASUMS256.txt.asc"),
        sha256: z.literal(EMBEDDED_NODE_SIGNED_CHECKSUMS_SHA256),
      })
      .strict(),
    keyring: z
      .object({
        repository: z.literal(NODE_RELEASE_KEYS_REPOSITORY),
        commit: z.literal(NODE_RELEASE_KEYS_COMMIT),
        sha256: z.literal(NODE_RELEASE_KEYS_SHA256),
      })
      .strict(),
    signer_fingerprint: z.literal(EMBEDDED_NODE_RELEASE_SIGNER_FINGERPRINT),
    artifacts: z
      .object({
        arm64: embeddedNodeArtifactSchema,
        x64: embeddedNodeArtifactSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifacts.arm64.arch !== "arm64") {
      context.addIssue({
        code: "custom",
        path: ["artifacts", "arm64", "arch"],
        message: "The arm64 Node artifact has the wrong architecture.",
      });
    }
    if (value.artifacts.x64.arch !== "x64") {
      context.addIssue({
        code: "custom",
        path: ["artifacts", "x64", "arch"],
        message: "The x64 Node artifact has the wrong architecture.",
      });
    }
  });

export type NodeReleaseProvenance = z.infer<typeof nodeReleaseProvenanceSchema>;

export function createNodeReleaseProvenance(
  inventorySha256: string,
): NodeReleaseProvenance {
  return nodeReleaseProvenanceSchema.parse({
    schema_version: NODE_RELEASE_PROVENANCE_SCHEMA_VERSION,
    project: "nodejs",
    version: EMBEDDED_NODE_VERSION,
    inventory: {
      name: "SHASUMS256.txt.asc",
      sha256: inventorySha256,
    },
    keyring: {
      repository: NODE_RELEASE_KEYS_REPOSITORY,
      commit: NODE_RELEASE_KEYS_COMMIT,
      sha256: NODE_RELEASE_KEYS_SHA256,
    },
    signer_fingerprint: EMBEDDED_NODE_RELEASE_SIGNER_FINGERPRINT,
    artifacts: {
      arm64: embeddedNodeArtifact("arm64"),
      x64: embeddedNodeArtifact("x64"),
    },
  });
}

export function canonicalNodeReleaseProvenance(value: unknown): string {
  return JSON.stringify(nodeReleaseProvenanceSchema.parse(value));
}

const releaseArchiveEvidenceSchema = z
  .object({
    name: z.string().regex(/^koda-v[^/]+-darwin-(?:arm64|x64)\.zip$/),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  })
  .strict();

export const macOSCodeSignatureRecordSchema = z
  .object({
    path: releaseRelativePathSchema,
    role: z.enum(["embedded_node", "native_executor", "native_addon"]),
    identifier: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9.-]+$/),
    team_id: z.string().regex(TEAM_ID_PATTERN),
    cdhash_sha256: z.string().regex(CODE_DIRECTORY_HASH_PATTERN),
    hardened_runtime: z.literal(true),
    secure_timestamp: z.literal(true),
  })
  .strict();

export const macOSCodeSignatureEvidenceSchema = z
  .object({
    schema_version: z.literal(MACOS_CODE_SIGNATURE_EVIDENCE_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.literal(KODA_VERSION),
    source_commit: sourceCommitSchema,
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    team_id: z.string().regex(TEAM_ID_PATTERN),
    archive: releaseArchiveEvidenceSchema,
    release_metadata_sha256: sha256Schema,
    node_provenance_sha256: sha256Schema,
    files: z.array(macOSCodeSignatureRecordSchema).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedArchive = `koda-v${value.version}-darwin-${value.arch}.zip`;
    if (value.archive.name !== expectedArchive) {
      context.addIssue({
        code: "custom",
        path: ["archive", "name"],
        message: "Signed archive name does not match its architecture.",
      });
    }
    const expectedFiles = [
      {
        path: `libexec/koda/app/node_modules/better-sqlite3/prebuilds/darwin-${value.arch}.node`,
        role: "native_addon",
        identifier: "dev.koda.cli.addon.better-sqlite3",
      },
      {
        path: "libexec/koda/native/koda-exec",
        role: "native_executor",
        identifier: "dev.koda.cli.native.koda-exec",
      },
      {
        path: "libexec/koda/node/bin/node",
        role: "embedded_node",
        identifier: "dev.koda.cli.node",
      },
    ];
    for (let index = 0; index < value.files.length; index += 1) {
      const file = value.files[index]!;
      const expected = expectedFiles[index]!;
      if (file.team_id !== value.team_id) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "team_id"],
          message: "Signed file team does not match the release team.",
        });
      }
      if (
        file.path !== expected.path ||
        file.role !== expected.role ||
        file.identifier !== expected.identifier
      ) {
        context.addIssue({
          code: "custom",
          path: ["files", index],
          message: "Signed file does not match its fixed release role.",
        });
      }
    }
  });

export type MacOSCodeSignatureEvidence = z.infer<
  typeof macOSCodeSignatureEvidenceSchema
>;

export function canonicalMacOSCodeSignatureEvidence(value: unknown): string {
  return JSON.stringify(macOSCodeSignatureEvidenceSchema.parse(value));
}

export const macOSNotarizationEvidenceSchema = z
  .object({
    schema_version: z.literal(MACOS_NOTARIZATION_EVIDENCE_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.literal(KODA_VERSION),
    source_commit: sourceCommitSchema,
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    archive: releaseArchiveEvidenceSchema,
    code_signature_evidence_sha256: sha256Schema,
    submission_id: z.string().regex(UUID_PATTERN),
    status: z.literal("Accepted"),
    response_sha256: sha256Schema,
    gatekeeper_assessed_files: z
      .array(releaseRelativePathSchema)
      .min(3)
      .max(MAXIMUM_SIGNED_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.archive.name !== `koda-v${value.version}-darwin-${value.arch}.zip`
    ) {
      context.addIssue({
        code: "custom",
        path: ["archive", "name"],
        message: "Notarized archive name does not match its architecture.",
      });
    }
    let previous: string | undefined;
    for (
      let index = 0;
      index < value.gatekeeper_assessed_files.length;
      index += 1
    ) {
      const path = value.gatekeeper_assessed_files[index]!;
      if (previous !== undefined && path <= previous) {
        context.addIssue({
          code: "custom",
          path: ["gatekeeper_assessed_files", index],
          message: "Gatekeeper file paths must be unique and sorted.",
        });
      }
      previous = path;
    }
  });

export type MacOSNotarizationEvidence = z.infer<
  typeof macOSNotarizationEvidenceSchema
>;

export function canonicalMacOSNotarizationEvidence(value: unknown): string {
  return JSON.stringify(macOSNotarizationEvidenceSchema.parse(value));
}

const publicArchitectureSchema = z
  .object({
    archive: releaseArchiveEvidenceSchema,
    release_metadata_sha256: sha256Schema,
    code_signature_evidence_sha256: sha256Schema,
    notarization_evidence_sha256: sha256Schema,
  })
  .strict();

export const macOSPublicReleaseProvenanceSchema = z
  .object({
    schema_version: z.literal(MACOS_PUBLIC_RELEASE_PROVENANCE_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.literal(KODA_VERSION),
    tag: z.literal(`v${KODA_VERSION}`),
    repository: z.string().regex(RELEASE_REPOSITORY_PATTERN),
    source_commit: sourceCommitSchema,
    workflow: z
      .object({
        run_id: z.string().regex(WORKFLOW_RUN_PATTERN),
        run_attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    node_provenance_sha256: sha256Schema,
    release_set_sha256: sha256Schema,
    formula_sha256: sha256Schema,
    architectures: z
      .object({
        arm64: publicArchitectureSchema,
        x64: publicArchitectureSchema,
      })
      .strict(),
  })
  .strict();

export type MacOSPublicReleaseProvenance = z.infer<
  typeof macOSPublicReleaseProvenanceSchema
>;

export function canonicalMacOSPublicReleaseProvenance(value: unknown): string {
  return JSON.stringify(macOSPublicReleaseProvenanceSchema.parse(value));
}
