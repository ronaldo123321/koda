import { z } from "zod";

import {
  releaseRelativePathSchema,
  runtimeManifestDigest,
  runtimeManifestSchema,
  sha256Schema,
  type RuntimeManifest,
} from "./contracts.js";
import {
  INTEGRITY_INVENTORY_SCHEMA_VERSION,
  KODA_VERSION,
  MACOS_RELEASE_METADATA_SCHEMA_VERSION,
  MACOS_RELEASE_SET_SCHEMA_VERSION,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
} from "./version.js";

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_ARCHIVE_PATTERN =
  /^koda-v[^/]+-darwin-(?:arm64|x64)\.(?:tar\.gz|zip)$/;
const MAXIMUM_NATIVE_FILES = 64;

export const sourceCommitSchema = z.string().regex(SOURCE_COMMIT_PATTERN);

export const macOSReleaseContractSchema = z
  .object({
    runtime_manifest_schema_version: z.literal(RUNTIME_MANIFEST_SCHEMA_VERSION),
    integrity_inventory_schema_version: z.literal(
      INTEGRITY_INVENTORY_SCHEMA_VERSION,
    ),
    node_version: z.string().min(1).max(64),
    entrypoints: z
      .object({
        dispatcher: releaseRelativePathSchema,
        cli: releaseRelativePathSchema,
        tui: releaseRelativePathSchema,
        app_server: releaseRelativePathSchema,
        doctor: releaseRelativePathSchema,
      })
      .strict(),
    native_executor_path: releaseRelativePathSchema,
    protocols: z
      .object({
        app_server: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        native_executor: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

const releaseArchiveSchema = z
  .object({
    name: z.string().min(1).max(255).regex(RELEASE_ARCHIVE_PATTERN),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  })
  .strict();

const releasePayloadSchema = z
  .object({
    runtime_manifest_sha256: sha256Schema,
    integrity_inventory_sha256: sha256Schema,
    native_files: z
      .array(releaseRelativePathSchema)
      .min(1)
      .max(MAXIMUM_NATIVE_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    let previous: string | undefined;
    for (let index = 0; index < value.native_files.length; index += 1) {
      const current = value.native_files[index]!;
      if (previous !== undefined && current <= previous) {
        context.addIssue({
          code: "custom",
          path: ["native_files", index],
          message: "Native file paths must be unique and sorted.",
        });
      }
      previous = current;
    }
  });

export const macOSReleaseMetadataSchema = z
  .object({
    schema_version: z.literal(MACOS_RELEASE_METADATA_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.literal(KODA_VERSION),
    source_commit: sourceCommitSchema,
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    contract: macOSReleaseContractSchema,
    payload: releasePayloadSchema,
    archive: releaseArchiveSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const archivePrefix = `koda-v${value.version}-darwin-${value.arch}`;
    if (
      value.archive.name !== `${archivePrefix}.tar.gz` &&
      value.archive.name !== `${archivePrefix}.zip`
    ) {
      context.addIssue({
        code: "custom",
        path: ["archive", "name"],
        message:
          "Release archive name does not match its version and architecture.",
      });
    }
  });

export type MacOSReleaseContract = z.infer<typeof macOSReleaseContractSchema>;
export type MacOSReleaseMetadata = z.infer<typeof macOSReleaseMetadataSchema>;

const releaseSetArchiveSchema = releaseArchiveSchema.extend({
  metadata_sha256: sha256Schema,
});

export const macOSReleaseSetSchema = z
  .object({
    schema_version: z.literal(MACOS_RELEASE_SET_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.literal(KODA_VERSION),
    source_commit: sourceCommitSchema,
    platform: z.literal("darwin"),
    contract: macOSReleaseContractSchema,
    architectures: z
      .object({
        arm64: releaseSetArchiveSchema,
        x64: releaseSetArchiveSchema,
      })
      .strict(),
  })
  .strict();

export type MacOSReleaseSet = z.infer<typeof macOSReleaseSetSchema>;

export function createMacOSReleaseMetadata(input: {
  sourceCommit: string;
  manifest: RuntimeManifest;
  archiveName: string;
  archiveBytes: number;
  archiveSha256: string;
  nativeFiles: readonly string[];
}): MacOSReleaseMetadata {
  const manifest = runtimeManifestSchema.parse(input.manifest);
  return macOSReleaseMetadataSchema.parse({
    schema_version: MACOS_RELEASE_METADATA_SCHEMA_VERSION,
    product: "koda",
    version: manifest.version,
    source_commit: input.sourceCommit,
    platform: manifest.platform,
    arch: manifest.arch,
    contract: {
      runtime_manifest_schema_version: manifest.schema_version,
      integrity_inventory_schema_version: INTEGRITY_INVENTORY_SCHEMA_VERSION,
      node_version: manifest.node.version,
      entrypoints: manifest.entrypoints,
      native_executor_path: manifest.native_executor.path,
      protocols: manifest.protocols,
    },
    payload: {
      runtime_manifest_sha256: runtimeManifestDigest(manifest),
      integrity_inventory_sha256: manifest.integrity_sha256,
      native_files: [...input.nativeFiles],
    },
    archive: {
      name: input.archiveName,
      bytes: input.archiveBytes,
      sha256: input.archiveSha256,
    },
  });
}

export function canonicalMacOSReleaseMetadata(value: unknown): string {
  return JSON.stringify(macOSReleaseMetadataSchema.parse(value));
}

export function compareMacOSReleaseMetadata(input: {
  arm64: unknown;
  x64: unknown;
  arm64MetadataSha256: string;
  x64MetadataSha256: string;
}): MacOSReleaseSet {
  const arm64 = macOSReleaseMetadataSchema.parse(input.arm64);
  const x64 = macOSReleaseMetadataSchema.parse(input.x64);
  if (
    arm64.arch !== "arm64" ||
    x64.arch !== "x64" ||
    arm64.source_commit !== x64.source_commit ||
    JSON.stringify(arm64.contract) !== JSON.stringify(x64.contract)
  ) {
    throw new Error(
      "macOS release metadata does not describe one same-commit runtime contract.",
    );
  }
  return macOSReleaseSetSchema.parse({
    schema_version: MACOS_RELEASE_SET_SCHEMA_VERSION,
    product: "koda",
    version: arm64.version,
    source_commit: arm64.source_commit,
    platform: "darwin",
    contract: arm64.contract,
    architectures: {
      arm64: {
        ...arm64.archive,
        metadata_sha256: input.arm64MetadataSha256,
      },
      x64: {
        ...x64.archive,
        metadata_sha256: input.x64MetadataSha256,
      },
    },
  });
}

export function canonicalMacOSReleaseSet(value: unknown): string {
  return JSON.stringify(macOSReleaseSetSchema.parse(value));
}
