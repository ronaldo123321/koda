import { spawn } from "node:child_process";
import {
  lstat,
  readFile as readFileFromDisk,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "FILE_TOO_LARGE"
  | "BINARY_FILE"
  | "SEARCH_FAILED"
  | "SEARCH_TIMEOUT";

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

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".koda", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_OUTPUT_BYTES = 128_000;

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
