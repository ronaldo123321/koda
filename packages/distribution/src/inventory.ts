import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  canonicalIntegrityInventory,
  canonicalRuntimeManifest,
  currentRuntimeManifest,
  integrityInventorySchema,
  type IntegrityFile,
  type IntegrityInventory,
  releaseRelativePathSchema,
  type RuntimeManifest,
} from "./contracts.js";

export const RUNTIME_MANIFEST_NAME = "runtime-manifest.json" as const;
export const INTEGRITY_INVENTORY_NAME = "integrity.json" as const;

const MAXIMUM_INVENTORY_FILES = 100_000;
const MAXIMUM_DIRECTORY_DEPTH = 64;

export interface RuntimeMetadataInput {
  arch: "arm64" | "x64";
  nodeVersion: string;
  nodePath: string;
  dispatcherPath: string;
  cliPath: string;
  tuiPath: string;
  appServerPath: string;
  doctorPath: string;
  nativeExecutorPath: string;
}

export async function listImmutablePayloadPaths(
  rootInput: string,
): Promise<readonly string[]> {
  const root = await realpath(rootInput);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Immutable payload root must be a real directory.");
  }
  const paths: string[] = [];
  await walk(root, root, 0, paths);
  paths.sort(comparePortablePaths);
  return paths;
}

export async function createIntegrityInventoryFromDirectory(
  rootInput: string,
): Promise<IntegrityInventory> {
  const root = await realpath(rootInput);
  const paths = await listImmutablePayloadPaths(root);
  const files: IntegrityFile[] = [];
  for (const path of paths) {
    files.push(await inventoryFile(root, path));
  }
  return integrityInventorySchema.parse({ schema_version: 1, files });
}

export async function writeRuntimeMetadata(
  rootInput: string,
  input: RuntimeMetadataInput,
): Promise<{
  readonly integrity: IntegrityInventory;
  readonly manifest: RuntimeManifest;
}> {
  const root = await realpath(rootInput);
  const integrity = await createIntegrityInventoryFromDirectory(root);
  const manifest = currentRuntimeManifest({ ...input, integrity });
  await Promise.all([
    writeFile(
      join(root, INTEGRITY_INVENTORY_NAME),
      `${canonicalIntegrityInventory(integrity)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    ),
    writeFile(
      join(root, RUNTIME_MANIFEST_NAME),
      `${canonicalRuntimeManifest(manifest)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    ),
  ]);
  return { integrity, manifest };
}

async function walk(
  root: string,
  directory: string,
  depth: number,
  paths: string[],
): Promise<void> {
  if (depth > MAXIMUM_DIRECTORY_DEPTH) {
    throw new Error("Immutable payload directory depth exceeds the limit.");
  }
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (
      depth === 0 &&
      (entry.name === RUNTIME_MANIFEST_NAME ||
        entry.name === INTEGRITY_INVENTORY_NAME)
    ) {
      continue;
    }
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    releaseRelativePathSchema.parse(path);
    if (entry.isSymbolicLink()) {
      throw new Error("Immutable payload must not contain symbolic links.");
    }
    if (entry.isDirectory()) {
      await walk(root, absolute, depth + 1, paths);
      continue;
    }
    if (!entry.isFile() || paths.length >= MAXIMUM_INVENTORY_FILES) {
      throw new Error(
        "Immutable payload file inventory is invalid or too large.",
      );
    }
    paths.push(path);
  }
}

async function inventoryFile(
  root: string,
  path: string,
): Promise<IntegrityFile> {
  const absolute = resolve(root, releaseRelativePathSchema.parse(path));
  const [metadata, canonical] = await Promise.all([
    lstat(absolute),
    realpath(absolute),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    canonical !== absolute
  ) {
    throw new Error("Immutable payload file is not a canonical regular file.");
  }
  return {
    path,
    bytes: metadata.size,
    sha256: await sha256File(absolute),
  };
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
