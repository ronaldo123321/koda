import { createHash } from "node:crypto";
import { posix } from "node:path";

import { APP_SERVER_PROTOCOL_VERSION } from "@koda/protocol";
import { z } from "zod";

import {
  INTEGRITY_INVENTORY_SCHEMA_VERSION,
  KODA_VERSION,
  NATIVE_EXECUTOR_PROTOCOL_VERSION,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
} from "./version.js";

const MAXIMUM_RELATIVE_PATH_BYTES = 4_096;
const MAXIMUM_INVENTORY_FILES = 100_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NODE_VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const sha256Schema = z.string().regex(SHA256_PATTERN);

export const releaseRelativePathSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_RELATIVE_PATH_BYTES)
  .superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_RELATIVE_PATH_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Release-relative path exceeds the byte limit.",
      });
    }
    if (
      /[\u0000-\u001f\u007f]/.test(value) ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.endsWith("/") ||
      posix.normalize(value) !== value ||
      value
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected a normalized portable release-relative path.",
      });
    }
  });

export const integrityFileSchema = z
  .object({
    path: releaseRelativePathSchema,
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  })
  .strict();

export const integrityInventorySchema = z
  .object({
    schema_version: z.literal(INTEGRITY_INVENTORY_SCHEMA_VERSION),
    files: z.array(integrityFileSchema).min(1).max(MAXIMUM_INVENTORY_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    let previous: string | undefined;
    for (let index = 0; index < value.files.length; index += 1) {
      const current = value.files[index]!.path;
      if (previous !== undefined && current <= previous) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "Integrity inventory paths must be unique and sorted.",
        });
      }
      previous = current;
    }
  });

const componentSchema = z
  .object({
    path: releaseRelativePathSchema,
  })
  .strict();

export const runtimeManifestSchema = z
  .object({
    schema_version: z.literal(RUNTIME_MANIFEST_SCHEMA_VERSION),
    product: z.literal("koda"),
    version: z.string().min(1).max(64).regex(VERSION_PATTERN),
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
    node: z
      .object({
        version: z.string().min(1).max(64).regex(NODE_VERSION_PATTERN),
        path: releaseRelativePathSchema,
      })
      .strict(),
    entrypoints: z
      .object({
        dispatcher: releaseRelativePathSchema,
        cli: releaseRelativePathSchema,
        tui: releaseRelativePathSchema,
        app_server: releaseRelativePathSchema,
        doctor: releaseRelativePathSchema,
      })
      .strict(),
    native_executor: componentSchema,
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
    integrity_sha256: sha256Schema,
  })
  .strict();

export type IntegrityFile = z.infer<typeof integrityFileSchema>;
export type IntegrityInventory = z.infer<typeof integrityInventorySchema>;
export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;

export function canonicalIntegrityInventory(value: unknown): string {
  return JSON.stringify(integrityInventorySchema.parse(value));
}

export function integrityInventoryDigest(value: unknown): string {
  return sha256(canonicalIntegrityInventory(value));
}

export function canonicalRuntimeManifest(value: unknown): string {
  return JSON.stringify(runtimeManifestSchema.parse(value));
}

export function runtimeManifestDigest(value: unknown): string {
  return sha256(canonicalRuntimeManifest(value));
}

export function currentRuntimeManifest(input: {
  arch: "arm64" | "x64";
  nodeVersion: string;
  nodePath: string;
  dispatcherPath: string;
  cliPath: string;
  tuiPath: string;
  appServerPath: string;
  doctorPath: string;
  nativeExecutorPath: string;
  integrity: IntegrityInventory;
}): RuntimeManifest {
  return runtimeManifestSchema.parse({
    schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
    product: "koda",
    version: KODA_VERSION,
    platform: "darwin",
    arch: input.arch,
    node: { version: input.nodeVersion, path: input.nodePath },
    entrypoints: {
      dispatcher: input.dispatcherPath,
      cli: input.cliPath,
      tui: input.tuiPath,
      app_server: input.appServerPath,
      doctor: input.doctorPath,
    },
    native_executor: { path: input.nativeExecutorPath },
    protocols: {
      app_server: APP_SERVER_PROTOCOL_VERSION,
      native_executor: NATIVE_EXECUTOR_PROTOCOL_VERSION,
    },
    integrity_sha256: integrityInventoryDigest(input.integrity),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
