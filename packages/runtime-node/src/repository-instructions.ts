import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

export type RepositoryInstructionErrorCode =
  | "INSTRUCTION_INVALID_TYPE"
  | "INSTRUCTION_SYMLINK_FORBIDDEN"
  | "INSTRUCTION_TOO_LARGE"
  | "INSTRUCTION_TOO_MANY"
  | "INSTRUCTION_INVALID_ENCODING"
  | "INSTRUCTION_READ_FAILED";

export class RepositoryInstructionError extends Error {
  public constructor(
    public readonly code: RepositoryInstructionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryInstructionError";
  }
}

export interface RepositoryInstructionSource {
  path: string;
  scope: string;
  bytes: number;
  sha256: string;
  content: string;
}

export interface RepositoryInstructionSet {
  sources: RepositoryInstructionSource[];
  totalBytes: number;
}

export interface RepositoryInstructionSnapshotLike {
  path: string;
  scope: string;
  bytes: number;
  sha256: string;
}

export interface RepositoryInstructionChange {
  path: string;
  scope: string;
  change: "added" | "removed" | "changed";
}

interface InstructionCandidate {
  path: string;
  scope: string;
  filename: (typeof INSTRUCTION_FILENAMES)[number];
}

const INSTRUCTION_FILENAMES = ["AGENTS.md", "KODA.md"] as const;
const INSTRUCTION_FILENAME_SET = new Set<string>(INSTRUCTION_FILENAMES);
const IGNORED_DIRECTORIES = new Set([".git", ".koda", "node_modules"]);
const MAX_INSTRUCTION_FILE_BYTES = 65_536;
const MAX_TOTAL_INSTRUCTION_BYTES = 262_144;
const MAX_INSTRUCTION_SOURCES = 32;
const MAX_INSTRUCTION_DEPTH = 20;

export async function loadRepositoryInstructions(
  workspaceRoot: string,
): Promise<RepositoryInstructionSet> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_READ_FAILED",
      "Repository instruction workspace root is not a directory.",
    );
  }

  const candidates = await discoverInstructionCandidates(canonicalRoot);
  if (candidates.length > MAX_INSTRUCTION_SOURCES) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_TOO_MANY",
      `Repository contains more than ${MAX_INSTRUCTION_SOURCES} instruction files.`,
    );
  }

  const sources: RepositoryInstructionSource[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const source = await readInstructionSource(canonicalRoot, candidate);
    totalBytes += source.bytes;
    if (totalBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_TOO_LARGE",
        `Repository instruction files exceed the ${MAX_TOTAL_INSTRUCTION_BYTES}-byte combined limit.`,
      );
    }
    sources.push(source);
  }
  return { sources, totalBytes };
}

export function diffRepositoryInstructionSnapshots(
  previous: readonly RepositoryInstructionSnapshotLike[],
  current: readonly RepositoryInstructionSnapshotLike[],
): RepositoryInstructionChange[] {
  const previousByPath = new Map(
    previous.map((source) => [source.path, source]),
  );
  const currentByPath = new Map(current.map((source) => [source.path, source]));
  const paths = [
    ...new Set([...previousByPath.keys(), ...currentByPath.keys()]),
  ].sort();
  const changes: RepositoryInstructionChange[] = [];
  for (const path of paths) {
    const before = previousByPath.get(path);
    const after = currentByPath.get(path);
    if (before === undefined && after !== undefined) {
      changes.push({ path, scope: after.scope, change: "added" });
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, scope: before.scope, change: "removed" });
    } else if (
      before !== undefined &&
      after !== undefined &&
      (before.scope !== after.scope ||
        before.bytes !== after.bytes ||
        before.sha256 !== after.sha256)
    ) {
      changes.push({ path, scope: after.scope, change: "changed" });
    }
  }
  return changes;
}

async function discoverInstructionCandidates(
  root: string,
): Promise<InstructionCandidate[]> {
  const candidates: InstructionCandidate[] = [];

  async function visit(directory: string, scope: string, depth: number) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw instructionReadError(scope, error);
    }
    entries.sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
      const path = scope === "." ? entry.name : `${scope}/${entry.name}`;
      if (INSTRUCTION_FILENAME_SET.has(entry.name)) {
        candidates.push({
          path,
          scope,
          filename: entry.name as InstructionCandidate["filename"],
        });
        continue;
      }
      if (
        entry.isDirectory() &&
        !IGNORED_DIRECTORIES.has(entry.name) &&
        depth < MAX_INSTRUCTION_DEPTH
      ) {
        await visit(resolve(directory, entry.name), path, depth + 1);
      }
    }
  }

  await visit(root, ".", 0);
  return candidates.sort((left, right) => {
    const depth = scopeDepth(left.scope) - scopeDepth(right.scope);
    if (depth !== 0) {
      return depth;
    }
    const scope = comparePortable(left.scope, right.scope);
    if (scope !== 0) {
      return scope;
    }
    return (
      INSTRUCTION_FILENAMES.indexOf(left.filename) -
      INSTRUCTION_FILENAMES.indexOf(right.filename)
    );
  });
}

async function readInstructionSource(
  root: string,
  candidate: InstructionCandidate,
): Promise<RepositoryInstructionSource> {
  const absolutePath = resolve(root, candidate.path);
  let pathStats: Stats;
  try {
    pathStats = await lstat(absolutePath);
  } catch (error) {
    throw instructionReadError(candidate.path, error);
  }
  if (pathStats.isSymbolicLink()) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_SYMLINK_FORBIDDEN",
      `Repository instruction file cannot be a symlink: ${candidate.path}`,
    );
  }
  if (!pathStats.isFile()) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_INVALID_TYPE",
      `Repository instruction source is not a regular file: ${candidate.path}`,
    );
  }
  if (pathStats.size > MAX_INSTRUCTION_FILE_BYTES) {
    throw instructionTooLarge(candidate.path);
  }

  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_READ_FAILED",
        `Repository instruction file changed while opening: ${candidate.path}`,
      );
    }
    if (openedStats.size > MAX_INSTRUCTION_FILE_BYTES) {
      throw instructionTooLarge(candidate.path);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INSTRUCTION_FILE_BYTES) {
      throw instructionTooLarge(candidate.path);
    }
    if (bytes.includes(0)) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_INVALID_ENCODING",
        `Repository instruction file appears to be binary: ${candidate.path}`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_INVALID_ENCODING",
        `Repository instruction file is not valid UTF-8: ${candidate.path}`,
        { cause: error },
      );
    }
    return {
      path: candidate.path,
      scope: candidate.scope,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content,
    };
  } catch (error) {
    if (error instanceof RepositoryInstructionError) {
      throw error;
    }
    if (isNodeError(error, "ELOOP")) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_SYMLINK_FORBIDDEN",
        `Repository instruction file cannot be a symlink: ${candidate.path}`,
        { cause: error },
      );
    }
    throw instructionReadError(candidate.path, error);
  } finally {
    await handle?.close();
  }
}

function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function instructionTooLarge(path: string): RepositoryInstructionError {
  return new RepositoryInstructionError(
    "INSTRUCTION_TOO_LARGE",
    `Repository instruction file exceeds the ${MAX_INSTRUCTION_FILE_BYTES}-byte limit: ${path}`,
  );
}

function instructionReadError(
  path: string,
  error: unknown,
): RepositoryInstructionError {
  return new RepositoryInstructionError(
    "INSTRUCTION_READ_FAILED",
    `Repository instruction source could not be read: ${path}`,
    { cause: error },
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
