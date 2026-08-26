import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

export type RepositoryInstructionErrorCode =
  | "INSTRUCTION_INVALID_TYPE"
  | "INSTRUCTION_SYMLINK_FORBIDDEN"
  | "INSTRUCTION_TOO_LARGE"
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
  path: "AGENTS.md" | "KODA.md";
  bytes: number;
  sha256: string;
  content: string;
}

export interface RepositoryInstructionSet {
  sources: RepositoryInstructionSource[];
  totalBytes: number;
}

const INSTRUCTION_FILENAMES = ["AGENTS.md", "KODA.md"] as const;
const MAX_INSTRUCTION_FILE_BYTES = 65_536;
const MAX_TOTAL_INSTRUCTION_BYTES = 131_072;

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

  const sources: RepositoryInstructionSource[] = [];
  let totalBytes = 0;
  for (const filename of INSTRUCTION_FILENAMES) {
    const source = await readInstructionSource(canonicalRoot, filename);
    if (source === undefined) {
      continue;
    }
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

async function readInstructionSource(
  root: string,
  filename: RepositoryInstructionSource["path"],
): Promise<RepositoryInstructionSource | undefined> {
  const path = resolve(root, filename);
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw instructionReadError(filename, error);
  }
  if (pathStats.isSymbolicLink()) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_SYMLINK_FORBIDDEN",
      `Repository instruction file cannot be a symlink: ${filename}`,
    );
  }
  if (!pathStats.isFile()) {
    throw new RepositoryInstructionError(
      "INSTRUCTION_INVALID_TYPE",
      `Repository instruction source is not a regular file: ${filename}`,
    );
  }
  if (pathStats.size > MAX_INSTRUCTION_FILE_BYTES) {
    throw instructionTooLarge(filename);
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_READ_FAILED",
        `Repository instruction file changed while opening: ${filename}`,
      );
    }
    if (openedStats.size > MAX_INSTRUCTION_FILE_BYTES) {
      throw instructionTooLarge(filename);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INSTRUCTION_FILE_BYTES) {
      throw instructionTooLarge(filename);
    }
    if (bytes.includes(0)) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_INVALID_ENCODING",
        `Repository instruction file appears to be binary: ${filename}`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new RepositoryInstructionError(
        "INSTRUCTION_INVALID_ENCODING",
        `Repository instruction file is not valid UTF-8: ${filename}`,
        { cause: error },
      );
    }
    return {
      path: filename,
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
        `Repository instruction file cannot be a symlink: ${filename}`,
        { cause: error },
      );
    }
    throw instructionReadError(filename, error);
  } finally {
    await handle?.close();
  }
}

function instructionTooLarge(filename: string): RepositoryInstructionError {
  return new RepositoryInstructionError(
    "INSTRUCTION_TOO_LARGE",
    `Repository instruction file exceeds the ${MAX_INSTRUCTION_FILE_BYTES}-byte limit: ${filename}`,
  );
}

function instructionReadError(
  filename: string,
  error: unknown,
): RepositoryInstructionError {
  return new RepositoryInstructionError(
    "INSTRUCTION_READ_FAILED",
    `Repository instruction file could not be read: ${filename}`,
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
