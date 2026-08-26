import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile as readFileFromDisk,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "FILE_TOO_LARGE"
  | "BINARY_FILE"
  | "SEARCH_FAILED"
  | "SEARCH_TIMEOUT"
  | "INVALID_PATCH"
  | "PATCH_TARGET_EXISTS"
  | "PATCH_TARGET_MISSING"
  | "PATCH_PARENT_MISSING"
  | "PATCH_MATCH_NOT_FOUND"
  | "PATCH_MATCH_AMBIGUOUS"
  | "SYMLINK_WRITE_FORBIDDEN"
  | "WRITE_PATH_FORBIDDEN"
  | "WORKSPACE_CHANGED";

export class WorkspaceError extends Error {
  public constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export interface ListFilesOptions {
  path: string;
  maxDepth: number;
  maxResults: number;
}

export interface ListFilesResult {
  root: string;
  path: string;
  files: string[];
  truncated: boolean;
}

export interface ReadFileOptions {
  path: string;
  startLine: number;
  lineCount: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface SearchTextOptions {
  query: string;
  path: string;
  maxResults: number;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SearchTextResult {
  path: string;
  query: string;
  matches: string[];
  truncated: boolean;
}

export type StructuredPatchOperation = "create" | "update";

export interface StructuredPatchOptions {
  path: string;
  operation: StructuredPatchOperation;
  oldText: string;
  newText: string;
}

export interface StructuredPatchResult {
  path: string;
  operation: StructuredPatchOperation;
  beforeHash: string | null;
  afterHash: string;
  bytesWritten: number;
}

export interface PreparedStructuredPatch {
  path: string;
  operation: StructuredPatchOperation;
  summary: string;
  preview: string;
  apply(signal: AbortSignal): Promise<StructuredPatchResult>;
}

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".koda", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_OUTPUT_BYTES = 128_000;
const MAX_PATCH_FIELD_BYTES = 65_536;

export class ReadOnlyWorkspace {
  private constructor(public readonly root: string) {}

  public static async open(root: string): Promise<ReadOnlyWorkspace> {
    const canonicalRoot = await realpath(resolve(root));
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new WorkspaceError(
        "NOT_A_DIRECTORY",
        `Workspace root is not a directory: ${root}`,
      );
    }
    return new ReadOnlyWorkspace(canonicalRoot);
  }

  public async listFiles(options: ListFilesOptions): Promise<ListFilesResult> {
    assertIntegerInRange(options.maxDepth, 0, 20, "maxDepth");
    assertIntegerInRange(options.maxResults, 1, 2_000, "maxResults");
    const target = await this.resolveExistingPath(options.path);
    const targetStats = await stat(target);
    if (!targetStats.isDirectory()) {
      throw new WorkspaceError(
        "NOT_A_DIRECTORY",
        `Path is not a directory: ${options.path}`,
      );
    }

    const files: string[] = [];
    let truncated = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (files.length >= options.maxResults) {
          truncated = true;
          return;
        }
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }

        const absoluteEntry = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isFile()) {
          files.push(this.toWorkspaceRelative(absoluteEntry));
          continue;
        }
        if (entry.isDirectory() && depth < options.maxDepth) {
          await walk(absoluteEntry, depth + 1);
          if (truncated) {
            return;
          }
        }
      }
    };

    await walk(target, 0);
    return {
      root: this.root,
      path: this.toWorkspaceRelative(target) || ".",
      files,
      truncated,
    };
  }

  public async readFile(options: ReadFileOptions): Promise<ReadFileResult> {
    assertIntegerInRange(
      options.startLine,
      1,
      Number.MAX_SAFE_INTEGER,
      "startLine",
    );
    assertIntegerInRange(options.lineCount, 1, 1_000, "lineCount");
    const target = await this.resolveExistingPath(options.path);
    const targetStats = await stat(target);
    if (!targetStats.isFile()) {
      throw new WorkspaceError(
        "NOT_A_FILE",
        `Path is not a regular file: ${options.path}`,
      );
    }
    if (targetStats.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        `File exceeds the ${MAX_FILE_BYTES}-byte read limit: ${options.path}`,
      );
    }

    const bytes = await readFileFromDisk(target);
    if (bytes.includes(0)) {
      throw new WorkspaceError(
        "BINARY_FILE",
        `File appears to be binary: ${options.path}`,
      );
    }
    const text = bytes.toString("utf8");
    const lines = text.length === 0 ? [] : text.split(/\r?\n/u);
    if (lines.at(-1) === "" && /\r?\n$/u.test(text)) {
      lines.pop();
    }

    const startIndex = Math.min(options.startLine - 1, lines.length);
    const selected = lines.slice(startIndex, startIndex + options.lineCount);
    const lineNumberWidth = String(
      Math.max(options.startLine, startIndex + selected.length),
    ).length;
    const content = selected
      .map(
        (line, index) =>
          `${String(startIndex + index + 1).padStart(lineNumberWidth)}: ${line}`,
      )
      .join("\n");
    const endLine =
      selected.length === 0 ? startIndex : startIndex + selected.length;

    return {
      path: this.toWorkspaceRelative(target),
      content,
      startLine: startIndex + 1,
      endLine,
      totalLines: lines.length,
      truncated: startIndex + selected.length < lines.length,
    };
  }

  public async searchText(
    options: SearchTextOptions,
  ): Promise<SearchTextResult> {
    if (options.query.length === 0 || options.query.includes("\0")) {
      throw new WorkspaceError(
        "INVALID_PATH",
        "Search query must be non-empty and cannot contain a null byte.",
      );
    }
    assertIntegerInRange(options.maxResults, 1, 2_000, "maxResults");
    options.signal.throwIfAborted();
    const target = await this.resolveExistingPath(options.path);
    const relativeTarget = this.toWorkspaceRelative(target) || ".";
    const result = await runRipgrep({
      root: this.root,
      target: relativeTarget,
      query: options.query,
      maxResults: options.maxResults,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_SEARCH_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      signal: options.signal,
    });
    return {
      path: relativeTarget,
      query: options.query,
      matches: result.matches,
      truncated: result.truncated,
    };
  }

  public async prepareStructuredPatch(
    options: StructuredPatchOptions,
  ): Promise<PreparedStructuredPatch> {
    assertPatchField(options.oldText, "old_text");
    assertPatchField(options.newText, "new_text");
    const target = this.resolveWriteTarget(options.path);
    const parent = dirname(target);
    const canonicalParent = await this.resolvePatchParent(parent, options.path);
    if (canonicalParent !== parent) {
      throw new WorkspaceError(
        "SYMLINK_WRITE_FORBIDDEN",
        `Patch paths cannot traverse symlinked directories: ${options.path}`,
      );
    }

    let beforeHash: string | undefined;
    let mode = 0o644;
    let candidate: string;

    if (options.operation === "create") {
      if (options.oldText.length !== 0) {
        throw new WorkspaceError(
          "INVALID_PATCH",
          "A create patch requires old_text to be empty.",
        );
      }
      if (await pathExists(target)) {
        throw new WorkspaceError(
          "PATCH_TARGET_EXISTS",
          `Cannot create an existing path: ${options.path}`,
        );
      }
      candidate = options.newText;
    } else {
      if (options.oldText.length === 0) {
        throw new WorkspaceError(
          "INVALID_PATCH",
          "An update patch requires non-empty old_text.",
        );
      }
      const snapshot = await this.readWritableSnapshot(target, options.path);
      beforeHash = snapshot.hash;
      mode = snapshot.mode;
      const matches = findOccurrences(snapshot.content, options.oldText);
      if (matches.length === 0) {
        throw new WorkspaceError(
          "PATCH_MATCH_NOT_FOUND",
          `old_text was not found in ${options.path}.`,
        );
      }
      if (matches.length > 1) {
        throw new WorkspaceError(
          "PATCH_MATCH_AMBIGUOUS",
          `old_text matched ${matches.length} locations in ${options.path}; provide more context.`,
        );
      }
      const matchIndex = matches[0];
      if (matchIndex === undefined) {
        throw new WorkspaceError(
          "PATCH_MATCH_NOT_FOUND",
          `old_text was not found in ${options.path}.`,
        );
      }
      candidate = `${snapshot.content.slice(0, matchIndex)}${options.newText}${snapshot.content.slice(matchIndex + options.oldText.length)}`;
      if (candidate === snapshot.content) {
        throw new WorkspaceError(
          "INVALID_PATCH",
          "The proposed update would not change the file.",
        );
      }
    }

    const candidateBytes = Buffer.from(candidate, "utf8");
    if (candidateBytes.byteLength > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        `Patched file would exceed the ${MAX_FILE_BYTES}-byte limit: ${options.path}`,
      );
    }
    const afterHash = hashBytes(candidateBytes);
    const workspacePath = this.toWorkspaceRelative(target);
    const summary =
      options.operation === "create"
        ? `Create ${workspacePath} (${candidateBytes.byteLength} bytes).`
        : `Update one exact match in ${workspacePath}.`;
    const preview = renderPatchPreview({
      path: workspacePath,
      operation: options.operation,
      oldText: options.oldText,
      newText: options.newText,
    });
    let applied = false;

    return {
      path: workspacePath,
      operation: options.operation,
      summary,
      preview,
      apply: async (signal) => {
        if (applied) {
          throw new WorkspaceError(
            "INVALID_PATCH",
            "A prepared patch can be applied only once.",
          );
        }
        applied = true;
        signal.throwIfAborted();
        await writeAtomicPatch({
          target,
          content: candidateBytes,
          mode,
          createOnly: options.operation === "create",
          signal,
          revalidate:
            options.operation === "create"
              ? async () =>
                  (await this.resolvePatchParent(parent, workspacePath)) ===
                    parent && !(await pathExists(target))
              : async () => {
                  const current = await this.readWritableSnapshot(
                    target,
                    workspacePath,
                  );
                  return current.hash === beforeHash;
                },
        });
        return {
          path: workspacePath,
          operation: options.operation,
          beforeHash: beforeHash ?? null,
          afterHash,
          bytesWritten: candidateBytes.byteLength,
        };
      },
    };
  }

  public async resolveExistingPath(relativePath: string): Promise<string> {
    if (relativePath.length === 0 || relativePath.includes("\0")) {
      throw new WorkspaceError(
        "INVALID_PATH",
        "Workspace path must be non-empty and cannot contain a null byte.",
      );
    }
    if (isAbsolute(relativePath)) {
      throw new WorkspaceError(
        "INVALID_PATH",
        `Absolute paths are not allowed: ${relativePath}`,
      );
    }

    const lexicalTarget = resolve(this.root, relativePath);
    this.assertInsideWorkspace(lexicalTarget, relativePath);
    const canonicalTarget = await realpath(lexicalTarget);
    this.assertInsideWorkspace(canonicalTarget, relativePath);

    const targetLstat = await lstat(lexicalTarget);
    if (targetLstat.isSymbolicLink()) {
      this.assertInsideWorkspace(canonicalTarget, relativePath);
    }
    return canonicalTarget;
  }

  private resolveWriteTarget(relativePath: string): string {
    if (relativePath.length === 0 || relativePath.includes("\0")) {
      throw new WorkspaceError(
        "INVALID_PATH",
        "Patch path must be non-empty and cannot contain a null byte.",
      );
    }
    if (isAbsolute(relativePath)) {
      throw new WorkspaceError(
        "INVALID_PATH",
        `Absolute patch paths are not allowed: ${relativePath}`,
      );
    }
    const target = resolve(this.root, relativePath);
    this.assertInsideWorkspace(target, relativePath);
    const workspacePath = this.toWorkspaceRelative(target);
    const forbidden = workspacePath
      .split("/")
      .find((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
    if (forbidden !== undefined) {
      throw new WorkspaceError(
        "WRITE_PATH_FORBIDDEN",
        `Patches cannot write inside '${forbidden}': ${relativePath}`,
      );
    }
    return target;
  }

  private async resolvePatchParent(
    parent: string,
    requestedPath: string,
  ): Promise<string> {
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new WorkspaceError(
          "PATCH_PARENT_MISSING",
          `Patch parent directory does not exist: ${requestedPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    this.assertInsideWorkspace(canonicalParent, requestedPath);
    const parentStats = await stat(canonicalParent);
    if (!parentStats.isDirectory()) {
      throw new WorkspaceError(
        "NOT_A_DIRECTORY",
        `Patch parent is not a directory: ${requestedPath}`,
      );
    }
    return canonicalParent;
  }

  private async readWritableSnapshot(
    target: string,
    requestedPath: string,
  ): Promise<{ content: string; hash: string; mode: number }> {
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new WorkspaceError(
          "PATCH_TARGET_MISSING",
          `Cannot update a missing file: ${requestedPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    this.assertInsideWorkspace(canonicalTarget, requestedPath);
    if (canonicalTarget !== target) {
      throw new WorkspaceError(
        "SYMLINK_WRITE_FORBIDDEN",
        `Patch paths cannot target or traverse symlinks: ${requestedPath}`,
      );
    }
    const targetStats = await lstat(target);
    if (targetStats.isSymbolicLink()) {
      throw new WorkspaceError(
        "SYMLINK_WRITE_FORBIDDEN",
        `Patch paths cannot target symlinks: ${requestedPath}`,
      );
    }
    if (!targetStats.isFile()) {
      throw new WorkspaceError(
        "NOT_A_FILE",
        `Patch target is not a regular file: ${requestedPath}`,
      );
    }
    if (targetStats.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        `File exceeds the ${MAX_FILE_BYTES}-byte patch limit: ${requestedPath}`,
      );
    }
    const bytes = await readFileFromDisk(target);
    return {
      content: decodeUtf8(bytes, requestedPath),
      hash: hashBytes(bytes),
      mode: targetStats.mode & 0o777,
    };
  }

  private assertInsideWorkspace(
    candidate: string,
    requestedPath: string,
  ): void {
    const relativeCandidate = relative(this.root, candidate);
    if (
      relativeCandidate === ".." ||
      relativeCandidate.startsWith(`..${sep}`) ||
      isAbsolute(relativeCandidate)
    ) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path escapes the workspace: ${requestedPath}`,
      );
    }
  }

  private toWorkspaceRelative(absolutePath: string): string {
    return relative(this.root, absolutePath).split(sep).join("/");
  }
}

interface AtomicPatchOptions {
  target: string;
  content: Buffer;
  mode: number;
  createOnly: boolean;
  signal: AbortSignal;
  revalidate(): Promise<boolean>;
}

async function writeAtomicPatch(options: AtomicPatchOptions): Promise<void> {
  const temporaryPath = join(
    dirname(options.target),
    `.${basename(options.target)}.koda-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    options.signal.throwIfAborted();
    if (!(await options.revalidate())) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        `The patch target changed after approval: ${basename(options.target)}`,
      );
    }
    handle = await open(temporaryPath, "wx", options.mode);
    if (!options.createOnly) {
      await handle.chmod(options.mode);
    }
    await handle.writeFile(options.content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    options.signal.throwIfAborted();
    if (!(await options.revalidate())) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        `The patch target changed after approval: ${basename(options.target)}`,
      );
    }
    options.signal.throwIfAborted();
    if (options.createOnly) {
      try {
        await link(temporaryPath, options.target);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new WorkspaceError(
            "WORKSPACE_CHANGED",
            `The patch target appeared after approval: ${basename(options.target)}`,
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      await rename(temporaryPath, options.target);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function renderPatchPreview(options: StructuredPatchOptions): string {
  const heading =
    options.operation === "create"
      ? `*** Create File: ${options.path}`
      : `*** Update File: ${options.path}`;
  const removed =
    options.operation === "create" ? [] : prefixLines(options.oldText, "-");
  const added = prefixLines(options.newText, "+");
  return [heading, "@@", ...removed, ...added].join("\n");
}

function prefixLines(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

function findOccurrences(content: string, needle: string): number[] {
  const indexes: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    if (indexes.length > 1) {
      break;
    }
    cursor = index + 1;
  }
  return indexes;
}

function assertPatchField(value: string, fieldName: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > MAX_PATCH_FIELD_BYTES) {
    throw new WorkspaceError(
      "INVALID_PATCH",
      `${fieldName} exceeds the ${MAX_PATCH_FIELD_BYTES}-byte limit.`,
    );
  }
  if (bytes.toString("utf8") !== value || value.includes("\0")) {
    throw new WorkspaceError(
      "INVALID_PATCH",
      `${fieldName} must be valid UTF-8 text without null bytes.`,
    );
  }
}

function decodeUtf8(bytes: Buffer, requestedPath: string): string {
  if (bytes.includes(0)) {
    throw new WorkspaceError(
      "BINARY_FILE",
      `File appears to be binary: ${requestedPath}`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspaceError(
      "BINARY_FILE",
      `File is not valid UTF-8 text: ${requestedPath}`,
      { cause: error },
    );
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

interface RipgrepOptions {
  root: string;
  target: string;
  query: string;
  maxResults: number;
  maxOutputBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

function runRipgrep(
  options: RipgrepOptions,
): Promise<{ matches: string[]; truncated: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "rg",
      [
        "--line-number",
        "--column",
        "--no-heading",
        "--color=never",
        "--fixed-strings",
        "--glob=!.git/**",
        "--glob=!node_modules/**",
        "--glob=!.koda/**",
        "--",
        options.query,
        options.target,
      ],
      { cwd: options.root, stdio: ["ignore", "pipe", "pipe"] },
    );

    const matches: string[] = [];
    let buffered = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const settle = (
      error?: Error,
      value?: { matches: string[]; truncated: boolean },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        rejectPromise(error);
      } else {
        resolvePromise(value ?? { matches, truncated });
      }
    };

    const consumeLine = (line: string) => {
      if (line.length === 0 || truncated) {
        return;
      }
      outputBytes += Buffer.byteLength(`${line}\n`);
      if (
        matches.length >= options.maxResults ||
        outputBytes > options.maxOutputBytes
      ) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      matches.push(line);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) {
        stderr += chunk;
      }
    });

    child.on("error", (error) => {
      settle(
        new WorkspaceError(
          "SEARCH_FAILED",
          error.message.includes("ENOENT")
            ? "ripgrep (rg) is required for search_text but was not found."
            : `Could not start ripgrep: ${error.message}`,
          { cause: error },
        ),
      );
    });

    child.on("close", (code) => {
      if (!truncated && buffered.length > 0) {
        consumeLine(buffered);
      }
      if (timedOut) {
        settle(
          new WorkspaceError(
            "SEARCH_TIMEOUT",
            `ripgrep exceeded the ${options.timeoutMs}ms timeout.`,
          ),
        );
      } else if (options.signal.aborted) {
        const reason = options.signal.reason;
        settle(
          reason instanceof Error
            ? reason
            : new Error("Search was cancelled.", { cause: reason }),
        );
      } else if (truncated || code === 0 || code === 1) {
        settle(undefined, { matches, truncated });
      } else {
        settle(
          new WorkspaceError(
            "SEARCH_FAILED",
            `ripgrep exited with code ${String(code)}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : "."}`,
          ),
        );
      }
    });

    const onAbort = () => child.kill("SIGTERM");
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    timer.unref();
  });
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}
