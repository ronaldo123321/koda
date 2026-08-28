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

import type {
  WorkspaceChangeEvidence,
  WorkspaceChangeSetCommittedPayload,
  WorkspaceChangeSetPreparedPayload,
  WorkspaceChangeSetRolledBackPayload,
  WorkspaceChangeSetUncertainPayload,
} from "@koda/protocol";

import type {
  WorkspaceMutationJournalIdentity,
  WorkspaceMutationJournalChange,
  WorkspaceMutationJournalStore,
  WorkspaceMutationJournalTransaction,
} from "./workspace-mutation-journal.js";

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
  | "PATCH_DOCUMENT_INVALID"
  | "PATCH_DOCUMENT_LIMIT_EXCEEDED"
  | "PATCH_LINE_ENDINGS_UNSUPPORTED"
  | "SYMLINK_WRITE_FORBIDDEN"
  | "WRITE_PATH_FORBIDDEN"
  | "WORKSPACE_CHANGED"
  | "CHANGE_SET_LIMIT_EXCEEDED"
  | "CHANGE_PATH_CONFLICT"
  | "CHANGE_PREVIEW_TOO_LARGE"
  | "MOVE_CROSS_DEVICE"
  | "CHANGE_SET_APPLY_FAILED"
  | "CHANGE_SET_OUTCOME_UNCERTAIN";

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

export interface WorkspaceCreateChange {
  operation: "create";
  path: string;
  content: string;
}

export interface WorkspaceUpdateChange {
  operation: "update";
  path: string;
  edits: Array<WorkspaceExactEdit | WorkspaceLineEdit>;
}

export interface WorkspaceExactEdit {
  oldText: string;
  newText: string;
}

export interface WorkspaceLineEdit {
  oldLines: string[];
  newLines: string[];
}

export interface WorkspaceMoveChange {
  operation: "move";
  fromPath: string;
  toPath: string;
}

export interface WorkspaceDeleteChange {
  operation: "delete";
  path: string;
}

export type WorkspaceChange =
  | WorkspaceCreateChange
  | WorkspaceUpdateChange
  | WorkspaceMoveChange
  | WorkspaceDeleteChange;

export type WorkspaceChangeSetOperationalEvent =
  | {
      type: "workspace.change_set_prepared";
      payload: WorkspaceChangeSetPreparedPayload;
    }
  | {
      type: "workspace.change_set_committed";
      payload: WorkspaceChangeSetCommittedPayload;
    }
  | {
      type: "workspace.change_set_rolled_back";
      payload: WorkspaceChangeSetRolledBackPayload;
    }
  | {
      type: "workspace.change_set_uncertain";
      payload: WorkspaceChangeSetUncertainPayload;
    };

export interface WorkspaceChangeSetFaultHooks {
  afterStaging?(): Promise<void> | void;
  beforeCommit?(inputIndex: number): Promise<void> | void;
  afterCommit?(inputIndex: number): Promise<void> | void;
  beforeRollback?(inputIndex: number): Promise<void> | void;
}

export interface WorkspaceChangeSetOptions {
  changes: WorkspaceChange[];
  faultHooks?: WorkspaceChangeSetFaultHooks;
}

export interface WorkspaceChangeSetResult {
  status: "committed";
  planSha256: string;
  changes: WorkspaceChangeEvidence[];
}

export interface PreparedWorkspaceChangeSet {
  summary: string;
  preview: string;
  planSha256: string;
  changes: readonly WorkspaceChangeEvidence[];
  apply(
    signal: AbortSignal,
    report: (event: WorkspaceChangeSetOperationalEvent) => Promise<void>,
    journal?: WorkspaceChangeSetJournalContext,
  ): Promise<WorkspaceChangeSetResult>;
}

export interface WorkspaceChangeSetJournalContext {
  store: WorkspaceMutationJournalStore;
  identity: WorkspaceMutationJournalIdentity;
}

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".koda", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_OUTPUT_BYTES = 128_000;
const MAX_PATCH_FIELD_BYTES = 65_536;
const MAX_CHANGE_SET_CHANGES = 16;
const MAX_CHANGE_SET_EDITS = 32;
const MAX_CHANGE_SET_TEXT_BYTES = 262_144;
const MAX_CHANGE_SET_SNAPSHOT_BYTES = 8_000_000;
const MAX_CHANGE_SET_PREVIEW_BYTES = 524_288;
const MAX_CHANGE_SET_SUMMARY_BYTES = 16_384;
const MAX_CHANGE_PATH_BYTES = 4_096;
const MAX_DELETE_BYTES = 65_536;

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

  public async prepareChangeSet(
    options: WorkspaceChangeSetOptions,
  ): Promise<PreparedWorkspaceChangeSet> {
    if (
      options.changes.length < 1 ||
      options.changes.length > MAX_CHANGE_SET_CHANGES
    ) {
      throw new WorkspaceError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        `A change set requires between 1 and ${MAX_CHANGE_SET_CHANGES} operations.`,
      );
    }

    let editCount = 0;
    let textBytes = 0;
    let snapshotBytes = 0;
    const endpoints = new Set<string>();
    const preparedChanges: PreparedChange[] = [];

    const reserveEndpoint = (absolutePath: string, requestedPath: string) => {
      if (endpoints.has(absolutePath)) {
        throw new WorkspaceError(
          "CHANGE_PATH_CONFLICT",
          `A change-set path is touched more than once: ${requestedPath}`,
        );
      }
      endpoints.add(absolutePath);
    };

    for (const [index, change] of options.changes.entries()) {
      if (change.operation === "create") {
        assertChangePath(change.path);
        assertPatchField(change.content, "content");
        textBytes += Buffer.byteLength(change.content, "utf8");
        assertChangeSetTotal(textBytes, MAX_CHANGE_SET_TEXT_BYTES, "text");
        const target = this.resolveWriteTarget(change.path);
        reserveEndpoint(target, change.path);
        const parent = dirname(target);
        await this.assertStablePatchParent(parent, change.path);
        if (await pathExists(target)) {
          throw new WorkspaceError(
            "PATCH_TARGET_EXISTS",
            `Cannot create an existing path: ${change.path}`,
          );
        }
        const candidate = Buffer.from(change.content, "utf8");
        assertCandidateSize(candidate, change.path);
        const path = this.toWorkspaceRelative(target);
        preparedChanges.push({
          index,
          operation: "create",
          path,
          target,
          parent,
          candidate,
          mode: 0o644,
          evidence: {
            index,
            operation: "create",
            path,
            beforeSha256: null,
            afterSha256: hashBytes(candidate),
            bytes: candidate.byteLength,
          },
          preview: renderCreatePreview(path, change.content),
        });
        continue;
      }

      if (change.operation === "update") {
        assertChangePath(change.path);
        if (change.edits.length < 1) {
          throw new WorkspaceError(
            "INVALID_PATCH",
            `An update requires at least one exact edit: ${change.path}`,
          );
        }
        editCount += change.edits.length;
        if (editCount > MAX_CHANGE_SET_EDITS) {
          throw new WorkspaceError(
            "CHANGE_SET_LIMIT_EXCEEDED",
            `A change set cannot exceed ${MAX_CHANGE_SET_EDITS} exact edits.`,
          );
        }
        const target = this.resolveWriteTarget(change.path);
        reserveEndpoint(target, change.path);
        const parent = dirname(target);
        await this.assertStablePatchParent(parent, change.path);
        const snapshot = await this.readWritableSnapshot(target, change.path);
        snapshotBytes += snapshot.bytes.byteLength;
        assertChangeSetTotal(
          snapshotBytes,
          MAX_CHANGE_SET_SNAPSHOT_BYTES,
          "snapshots",
        );
        let candidate = snapshot.content;
        const resolvedEdits: WorkspaceExactEdit[] = [];
        for (const edit of change.edits) {
          const resolvedEdit =
            "oldText" in edit
              ? edit
              : resolveLineEdit(candidate, edit, change.path);
          assertPatchField(resolvedEdit.oldText, "old_text");
          assertPatchField(resolvedEdit.newText, "new_text");
          if (resolvedEdit.oldText.length === 0) {
            throw new WorkspaceError(
              "INVALID_PATCH",
              `An update edit requires non-empty old_text: ${change.path}`,
            );
          }
          textBytes +=
            Buffer.byteLength(resolvedEdit.oldText, "utf8") +
            Buffer.byteLength(resolvedEdit.newText, "utf8");
          assertChangeSetTotal(textBytes, MAX_CHANGE_SET_TEXT_BYTES, "text");
          candidate = applyExactEdit(candidate, resolvedEdit, change.path);
          resolvedEdits.push(resolvedEdit);
        }
        if (candidate === snapshot.content) {
          throw new WorkspaceError(
            "INVALID_PATCH",
            `The proposed update would not change the file: ${change.path}`,
          );
        }
        const candidateBytes = Buffer.from(candidate, "utf8");
        assertCandidateSize(candidateBytes, change.path);
        const path = this.toWorkspaceRelative(target);
        preparedChanges.push({
          index,
          operation: "update",
          path,
          target,
          parent,
          before: snapshot,
          candidate: candidateBytes,
          mode: snapshot.mode,
          evidence: {
            index,
            operation: "update",
            path,
            beforeSha256: snapshot.hash,
            afterSha256: hashBytes(candidateBytes),
            bytes: candidateBytes.byteLength,
          },
          preview: renderUpdatePreview(path, resolvedEdits),
        });
        continue;
      }

      if (change.operation === "move") {
        assertChangePath(change.fromPath);
        assertChangePath(change.toPath);
        const source = this.resolveWriteTarget(change.fromPath);
        const destination = this.resolveWriteTarget(change.toPath);
        reserveEndpoint(source, change.fromPath);
        reserveEndpoint(destination, change.toPath);
        const sourceParent = dirname(source);
        const destinationParent = dirname(destination);
        await this.assertStablePatchParent(sourceParent, change.fromPath);
        await this.assertStablePatchParent(destinationParent, change.toPath);
        const snapshot = await this.readWritableSnapshot(
          source,
          change.fromPath,
        );
        snapshotBytes += snapshot.bytes.byteLength;
        assertChangeSetTotal(
          snapshotBytes,
          MAX_CHANGE_SET_SNAPSHOT_BYTES,
          "snapshots",
        );
        if (await pathExists(destination)) {
          throw new WorkspaceError(
            "PATCH_TARGET_EXISTS",
            `Cannot move onto an existing path: ${change.toPath}`,
          );
        }
        const destinationParentStats = await stat(destinationParent);
        if (snapshot.device !== destinationParentStats.dev) {
          throw new WorkspaceError(
            "MOVE_CROSS_DEVICE",
            `Move source and destination must be on the same filesystem: ${change.fromPath} -> ${change.toPath}`,
          );
        }
        const path = this.toWorkspaceRelative(source);
        const destinationPath = this.toWorkspaceRelative(destination);
        preparedChanges.push({
          index,
          operation: "move",
          path,
          target: source,
          parent: sourceParent,
          destination,
          destinationPath,
          destinationParent,
          before: snapshot,
          evidence: {
            index,
            operation: "move",
            path,
            destination: destinationPath,
            beforeSha256: snapshot.hash,
            afterSha256: snapshot.hash,
            bytes: snapshot.bytes.byteLength,
          },
          preview: renderMovePreview(
            path,
            destinationPath,
            snapshot.bytes.byteLength,
            snapshot.hash,
          ),
        });
        continue;
      }

      assertChangePath(change.path);
      const target = this.resolveWriteTarget(change.path);
      reserveEndpoint(target, change.path);
      const parent = dirname(target);
      await this.assertStablePatchParent(parent, change.path);
      const snapshot = await this.readWritableSnapshot(target, change.path);
      snapshotBytes += snapshot.bytes.byteLength;
      assertChangeSetTotal(
        snapshotBytes,
        MAX_CHANGE_SET_SNAPSHOT_BYTES,
        "snapshots",
      );
      if (snapshot.bytes.byteLength > MAX_DELETE_BYTES) {
        throw new WorkspaceError(
          "CHANGE_SET_LIMIT_EXCEEDED",
          `Delete preview exceeds the ${MAX_DELETE_BYTES}-byte limit: ${change.path}`,
        );
      }
      const path = this.toWorkspaceRelative(target);
      preparedChanges.push({
        index,
        operation: "delete",
        path,
        target,
        parent,
        before: snapshot,
        evidence: {
          index,
          operation: "delete",
          path,
          beforeSha256: snapshot.hash,
          afterSha256: null,
          bytes: snapshot.bytes.byteLength,
        },
        preview: renderDeletePreview(path, snapshot.content),
      });
    }

    if (editCount > MAX_CHANGE_SET_EDITS) {
      throw new WorkspaceError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        `A change set cannot exceed ${MAX_CHANGE_SET_EDITS} exact edits.`,
      );
    }
    if (textBytes > MAX_CHANGE_SET_TEXT_BYTES) {
      throw new WorkspaceError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        `Change-set text exceeds the ${MAX_CHANGE_SET_TEXT_BYTES}-byte limit.`,
      );
    }
    if (snapshotBytes > MAX_CHANGE_SET_SNAPSHOT_BYTES) {
      throw new WorkspaceError(
        "CHANGE_SET_LIMIT_EXCEEDED",
        `Change-set snapshots exceed the ${MAX_CHANGE_SET_SNAPSHOT_BYTES}-byte limit.`,
      );
    }

    const preview = preparedChanges
      .sort((left, right) => left.index - right.index)
      .map((change) => change.preview)
      .join("\n\n");
    if (Buffer.byteLength(preview, "utf8") > MAX_CHANGE_SET_PREVIEW_BYTES) {
      throw new WorkspaceError(
        "CHANGE_PREVIEW_TOO_LARGE",
        `Change-set approval exceeds the ${MAX_CHANGE_SET_PREVIEW_BYTES}-byte limit.`,
      );
    }
    const evidence = preparedChanges.map((change) => change.evidence);
    const planSha256 = digestChangePlan(preparedChanges);
    const summary = renderChangeSetSummary(preparedChanges);
    if (Buffer.byteLength(summary, "utf8") > MAX_CHANGE_SET_SUMMARY_BYTES) {
      throw new WorkspaceError(
        "CHANGE_PREVIEW_TOO_LARGE",
        `Change-set summary exceeds the ${MAX_CHANGE_SET_SUMMARY_BYTES}-byte limit.`,
      );
    }
    let applied = false;

    return {
      summary,
      preview,
      planSha256,
      changes: evidence,
      apply: async (signal, report, journal) => {
        if (applied) {
          throw new WorkspaceError(
            "INVALID_PATCH",
            "A prepared change set can be applied only once.",
          );
        }
        applied = true;
        return this.applyPreparedChangeSet({
          preparedChanges,
          planSha256,
          signal,
          report,
          ...(journal === undefined ? {} : { journal }),
          ...(options.faultHooks === undefined
            ? {}
            : { faultHooks: options.faultHooks }),
        });
      },
    };
  }

  private async applyPreparedChangeSet(
    options: ApplyPreparedChangeSetOptions,
  ): Promise<WorkspaceChangeSetResult> {
    options.signal.throwIfAborted();
    for (const change of options.preparedChanges) {
      await this.revalidatePreparedChange(change, "before");
    }

    const staged = new Map<number, string>();
    let journal: WorkspaceMutationJournalTransaction | undefined;
    let journalDisposition:
      "discard" | "committed" | "rolled_back" | "conflicted" | undefined;
    let journalConflictPaths: string[] = [];
    try {
      for (const change of options.preparedChanges) {
        if (change.operation === "create" || change.operation === "update") {
          options.signal.throwIfAborted();
          staged.set(
            change.index,
            await stageChangeCandidate(
              change.target,
              change.candidate,
              change.mode,
              options.signal,
            ),
          );
        }
      }
      await options.faultHooks?.afterStaging?.();
      options.signal.throwIfAborted();
      if (options.journal !== undefined) {
        journal = await options.journal.store.begin({
          identity: options.journal.identity,
          planSha256: options.planSha256,
          changes: options.preparedChanges.map((change) =>
            toJournalChange(
              change,
              staged.has(change.index)
                ? this.toWorkspaceRelative(staged.get(change.index)!)
                : undefined,
            ),
          ),
        });
      }
      try {
        await options.report({
          type: "workspace.change_set_prepared",
          payload: {
            planSha256: options.planSha256,
            changes: options.preparedChanges.map((change) => change.evidence),
          },
        });
      } catch (error) {
        journalDisposition = "discard";
        throw error;
      }

      const commitOrder = [...options.preparedChanges].sort((left, right) =>
        left.path === right.path
          ? left.index - right.index
          : left.path.localeCompare(right.path),
      );
      const committed: PreparedChange[] = [];
      try {
        for (const change of commitOrder) {
          options.signal.throwIfAborted();
          await options.faultHooks?.beforeCommit?.(change.index);
          await this.revalidatePreparedChange(change, "before");
          try {
            await commitPreparedChange(change, staged.get(change.index));
            committed.push(change);
          } catch (error) {
            if (error instanceof PartiallyAppliedChangeError) {
              committed.push(change);
            }
            throw error;
          }
          await options.faultHooks?.afterCommit?.(change.index);
        }
        await options.report({
          type: "workspace.change_set_committed",
          payload: {
            planSha256: options.planSha256,
            changeCount: committed.length,
          },
        });
        journalDisposition = "committed";
        return {
          status: "committed",
          planSha256: options.planSha256,
          changes: options.preparedChanges.map((change) => change.evidence),
        };
      } catch (error) {
        const restoredPaths: string[] = [];
        const uncertainPaths: string[] = [];
        for (const change of [...committed].reverse()) {
          try {
            await options.faultHooks?.beforeRollback?.(change.index);
            await this.revalidatePreparedChange(change, "after");
            await rollbackPreparedChange(change);
            restoredPaths.push(change.path);
          } catch {
            uncertainPaths.push(change.path);
          }
        }
        const errorCode = options.signal.aborted
          ? "CANCELLED"
          : boundedErrorCode(error);
        if (uncertainPaths.length > 0) {
          await options.report({
            type: "workspace.change_set_uncertain",
            payload: {
              planSha256: options.planSha256,
              appliedCount: committed.length,
              uncertainPaths,
              errorCode,
            },
          });
          journalDisposition = "conflicted";
          journalConflictPaths = uncertainPaths;
          throw new WorkspaceError(
            "CHANGE_SET_OUTCOME_UNCERTAIN",
            `Change-set rollback could not verify: ${uncertainPaths.join(", ")}. Inspect these paths before another write.`,
            { cause: error },
          );
        }
        await options.report({
          type: "workspace.change_set_rolled_back",
          payload: {
            planSha256: options.planSha256,
            appliedCount: committed.length,
            restoredPaths,
            errorCode,
          },
        });
        journalDisposition = "rolled_back";
        if (options.signal.aborted) {
          throw error;
        }
        throw new WorkspaceError(
          "CHANGE_SET_APPLY_FAILED",
          `Change set failed and ${restoredPaths.length} applied operation(s) were rolled back: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    } finally {
      let stagedCleanupSucceeded = true;
      for (const path of staged.values()) {
        try {
          await rm(path, { force: true });
        } catch {
          stagedCleanupSucceeded = false;
        }
      }
      if (journal !== undefined) {
        if (journalDisposition === "conflicted") {
          await journal
            .retainConflict(journalConflictPaths)
            .catch(() => undefined);
        } else if (stagedCleanupSucceeded) {
          if (journalDisposition === "committed") {
            await journal.complete("committed").catch(() => undefined);
          } else if (journalDisposition === "rolled_back") {
            await journal.complete("rolled_back").catch(() => undefined);
          } else if (journalDisposition === "discard") {
            await journal.discardBeforeMutation().catch(() => undefined);
          }
        }
      }
    }
  }

  private async revalidatePreparedChange(
    change: PreparedChange,
    expected: "before" | "after",
  ): Promise<void> {
    const matches = await this.preparedChangeMatches(change, expected).catch(
      () => false,
    );
    if (!matches) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        `Change-set path no longer matches its ${expected} state: ${change.path}`,
      );
    }
  }

  private async preparedChangeMatches(
    change: PreparedChange,
    expected: "before" | "after",
  ): Promise<boolean> {
    if (
      (await this.resolvePatchParent(change.parent, change.path)) !==
      change.parent
    ) {
      return false;
    }
    if (change.operation === "create") {
      if (expected === "before") {
        return !(await pathExists(change.target));
      }
      return this.pathMatchesSnapshot(
        change.target,
        change.path,
        change.evidence.afterSha256,
        change.mode,
      );
    }
    if (change.operation === "update") {
      return this.pathMatchesSnapshot(
        change.target,
        change.path,
        expected === "before"
          ? change.evidence.beforeSha256
          : change.evidence.afterSha256,
        change.mode,
      );
    }
    if (change.operation === "delete") {
      if (expected === "after") {
        return !(await pathExists(change.target));
      }
      return this.pathMatchesSnapshot(
        change.target,
        change.path,
        change.evidence.beforeSha256,
        change.before.mode,
      );
    }
    if (
      (await this.resolvePatchParent(
        change.destinationParent,
        change.destinationPath,
      )) !== change.destinationParent
    ) {
      return false;
    }
    if (expected === "before") {
      return (
        (await this.pathMatchesSnapshot(
          change.target,
          change.path,
          change.evidence.beforeSha256,
          change.before.mode,
        )) && !(await pathExists(change.destination))
      );
    }
    return (
      !(await pathExists(change.target)) &&
      (await this.pathMatchesSnapshot(
        change.destination,
        change.destinationPath,
        change.evidence.afterSha256,
        change.before.mode,
      ))
    );
  }

  private async pathMatchesSnapshot(
    target: string,
    requestedPath: string,
    expectedHash: string | null,
    expectedMode: number,
  ): Promise<boolean> {
    if (expectedHash === null) {
      return !(await pathExists(target));
    }
    const snapshot = await this.readWritableSnapshot(target, requestedPath);
    return snapshot.hash === expectedHash && snapshot.mode === expectedMode;
  }

  private async assertStablePatchParent(
    parent: string,
    requestedPath: string,
  ): Promise<void> {
    if ((await this.resolvePatchParent(parent, requestedPath)) !== parent) {
      throw new WorkspaceError(
        "SYMLINK_WRITE_FORBIDDEN",
        `Change paths cannot traverse symlinked directories: ${requestedPath}`,
      );
    }
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
  ): Promise<WritableSnapshot> {
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
      bytes,
      hash: hashBytes(bytes),
      mode: targetStats.mode & 0o777,
      device: targetStats.dev,
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

interface WritableSnapshot {
  content: string;
  bytes: Buffer;
  hash: string;
  mode: number;
  device: number;
}

interface PreparedChangeBase {
  index: number;
  path: string;
  target: string;
  parent: string;
  evidence: WorkspaceChangeEvidence;
  preview: string;
}

interface PreparedCreateChange extends PreparedChangeBase {
  operation: "create";
  candidate: Buffer;
  mode: number;
}

interface PreparedUpdateChange extends PreparedChangeBase {
  operation: "update";
  before: WritableSnapshot;
  candidate: Buffer;
  mode: number;
}

interface PreparedMoveChange extends PreparedChangeBase {
  operation: "move";
  before: WritableSnapshot;
  destination: string;
  destinationPath: string;
  destinationParent: string;
}

interface PreparedDeleteChange extends PreparedChangeBase {
  operation: "delete";
  before: WritableSnapshot;
}

type PreparedChange =
  | PreparedCreateChange
  | PreparedUpdateChange
  | PreparedMoveChange
  | PreparedDeleteChange;

interface ApplyPreparedChangeSetOptions {
  preparedChanges: PreparedChange[];
  planSha256: string;
  signal: AbortSignal;
  report(event: WorkspaceChangeSetOperationalEvent): Promise<void>;
  journal?: WorkspaceChangeSetJournalContext;
  faultHooks?: WorkspaceChangeSetFaultHooks;
}

function toJournalChange(
  change: PreparedChange,
  stagedPath: string | undefined,
): WorkspaceMutationJournalChange {
  const evidence = {
    index: change.evidence.index,
    operation: change.evidence.operation,
    path: change.evidence.path,
    ...(change.evidence.destination === undefined
      ? {}
      : { destination: change.evidence.destination }),
    beforeSha256: change.evidence.beforeSha256,
    afterSha256: change.evidence.afterSha256,
    bytes: change.evidence.bytes,
  };
  if (change.operation === "create") {
    return {
      ...evidence,
      beforeMode: null,
      afterMode: change.mode,
      ...(stagedPath === undefined ? {} : { stagedPath }),
    };
  }
  if (change.operation === "update") {
    return {
      ...evidence,
      beforeMode: change.before.mode,
      afterMode: change.mode,
      beforeBytes: change.before.bytes,
      ...(stagedPath === undefined ? {} : { stagedPath }),
    };
  }
  if (change.operation === "move") {
    return {
      ...evidence,
      beforeMode: change.before.mode,
      afterMode: change.before.mode,
      beforeBytes: change.before.bytes,
    };
  }
  return {
    ...evidence,
    beforeMode: change.before.mode,
    afterMode: null,
    beforeBytes: change.before.bytes,
  };
}

function assertChangePath(path: string): void {
  if (Buffer.byteLength(path, "utf8") > MAX_CHANGE_PATH_BYTES) {
    throw new WorkspaceError(
      "CHANGE_SET_LIMIT_EXCEEDED",
      `Change path exceeds the ${MAX_CHANGE_PATH_BYTES}-byte limit.`,
    );
  }
}

function assertCandidateSize(candidate: Buffer, path: string): void {
  if (candidate.byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      "FILE_TOO_LARGE",
      `Changed file would exceed the ${MAX_FILE_BYTES}-byte limit: ${path}`,
    );
  }
}

function assertChangeSetTotal(
  current: number,
  maximum: number,
  label: string,
): void {
  if (current > maximum) {
    throw new WorkspaceError(
      "CHANGE_SET_LIMIT_EXCEEDED",
      `Change-set ${label} exceed the ${maximum}-byte limit.`,
    );
  }
}

function applyExactEdit(
  content: string,
  edit: { oldText: string; newText: string },
  path: string,
): string {
  const matches = findOccurrences(content, edit.oldText);
  if (matches.length === 0) {
    throw new WorkspaceError(
      "PATCH_MATCH_NOT_FOUND",
      `old_text was not found in ${path}.`,
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceError(
      "PATCH_MATCH_AMBIGUOUS",
      `old_text matched ${matches.length} locations in ${path}; provide more context.`,
    );
  }
  const matchIndex = matches[0];
  if (matchIndex === undefined) {
    throw new WorkspaceError(
      "PATCH_MATCH_NOT_FOUND",
      `old_text was not found in ${path}.`,
    );
  }
  return `${content.slice(0, matchIndex)}${edit.newText}${content.slice(matchIndex + edit.oldText.length)}`;
}

function resolveLineEdit(
  content: string,
  edit: WorkspaceLineEdit,
  path: string,
): WorkspaceExactEdit {
  if (edit.oldLines.length === 0) {
    throw new WorkspaceError(
      "INVALID_PATCH",
      `A line update requires at least one context or removed line: ${path}`,
    );
  }
  for (const line of [...edit.oldLines, ...edit.newLines]) {
    if (line.includes("\n") || line.includes("\r") || line.includes("\0")) {
      throw new WorkspaceError(
        "INVALID_PATCH",
        `Line updates cannot contain embedded line terminators or null bytes: ${path}`,
      );
    }
  }

  const lineEnding = detectConsistentLineEnding(content, path);
  const lines = splitLogicalLines(content, lineEnding);
  const matches: number[] = [];
  for (
    let start = 0;
    start <= lines.length - edit.oldLines.length;
    start += 1
  ) {
    const matchesAtStart = edit.oldLines.every(
      (oldLine, offset) => lines[start + offset]?.text === oldLine,
    );
    if (matchesAtStart) {
      matches.push(start);
      if (matches.length > 1) {
        break;
      }
    }
  }
  if (matches.length === 0) {
    throw new WorkspaceError(
      "PATCH_MATCH_NOT_FOUND",
      `Patch hunk lines were not found in ${path}.`,
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceError(
      "PATCH_MATCH_AMBIGUOUS",
      `Patch hunk lines matched more than one location in ${path}; provide more context.`,
    );
  }

  const startLine = matches[0];
  if (startLine === undefined) {
    throw new WorkspaceError(
      "PATCH_MATCH_NOT_FOUND",
      `Patch hunk lines were not found in ${path}.`,
    );
  }
  const first = lines[startLine];
  const last = lines[startLine + edit.oldLines.length - 1];
  if (first === undefined || last === undefined) {
    throw new WorkspaceError(
      "PATCH_MATCH_NOT_FOUND",
      `Patch hunk lines were not found in ${path}.`,
    );
  }
  const oldText = content.slice(first.start, last.end);
  const newText =
    edit.newLines.length === 0
      ? ""
      : `${edit.newLines.join(lineEnding)}${last.hasTerminator ? lineEnding : ""}`;
  return { oldText, newText };
}

function detectConsistentLineEnding(
  content: string,
  path: string,
): "\n" | "\r\n" {
  let hasLf = false;
  let hasCrLf = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\r") {
      if (content[index + 1] !== "\n") {
        throw new WorkspaceError(
          "PATCH_LINE_ENDINGS_UNSUPPORTED",
          `Patch target contains a lone carriage return: ${path}`,
        );
      }
      hasCrLf = true;
      index += 1;
      continue;
    }
    if (character === "\n") {
      hasLf = true;
    }
  }
  if (hasLf && hasCrLf) {
    throw new WorkspaceError(
      "PATCH_LINE_ENDINGS_UNSUPPORTED",
      `Patch target mixes LF and CRLF line endings: ${path}`,
    );
  }
  return hasCrLf ? "\r\n" : "\n";
}

function splitLogicalLines(
  content: string,
  lineEnding: "\n" | "\r\n",
): LogicalLine[] {
  if (content.length === 0) {
    return [];
  }
  const lines: LogicalLine[] = [];
  let start = 0;
  while (start < content.length) {
    const terminator = content.indexOf(lineEnding, start);
    if (terminator < 0) {
      lines.push({
        text: content.slice(start),
        start,
        end: content.length,
        hasTerminator: false,
      });
      break;
    }
    const end = terminator + lineEnding.length;
    lines.push({
      text: content.slice(start, terminator),
      start,
      end,
      hasTerminator: true,
    });
    start = end;
  }
  return lines;
}

interface LogicalLine {
  text: string;
  start: number;
  end: number;
  hasTerminator: boolean;
}

function renderCreatePreview(path: string, content: string): string {
  return [`*** Create File: ${path}`, "@@", ...prefixLines(content, "+")].join(
    "\n",
  );
}

function renderUpdatePreview(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  return [
    `*** Update File: ${path}`,
    ...edits.flatMap((edit, index) => [
      `@@ Edit ${index + 1}`,
      ...prefixLines(edit.oldText, "-"),
      ...prefixLines(edit.newText, "+"),
    ]),
  ].join("\n");
}

function renderMovePreview(
  path: string,
  destination: string,
  bytes: number,
  sha256: string,
): string {
  return [
    `*** Move File: ${path}`,
    `*** To: ${destination}`,
    `bytes: ${bytes}`,
    `sha256: ${sha256}`,
  ].join("\n");
}

function renderDeletePreview(path: string, content: string): string {
  return [`*** Delete File: ${path}`, "@@", ...prefixLines(content, "-")].join(
    "\n",
  );
}

function renderChangeSetSummary(changes: readonly PreparedChange[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.operation, (counts.get(change.operation) ?? 0) + 1);
  }
  const operations = ["create", "update", "move", "delete"]
    .flatMap((operation) => {
      const count = counts.get(operation);
      return count === undefined ? [] : [`${count} ${operation}`];
    })
    .join(", ");
  return `Apply ${changes.length} coordinated change(s): ${operations}. Paths: ${changes
    .map((change) =>
      change.operation === "move"
        ? `${change.path} -> ${change.destinationPath}`
        : change.path,
    )
    .join(", ")}`;
}

function digestChangePlan(changes: readonly PreparedChange[]): string {
  const canonical = [...changes]
    .sort((left, right) => left.index - right.index)
    .map((change) => ({
      index: change.index,
      operation: change.operation,
      path: change.path,
      destination: change.operation === "move" ? change.destinationPath : null,
      beforeSha256: change.evidence.beforeSha256,
      afterSha256: change.evidence.afterSha256,
      mode:
        change.operation === "create"
          ? change.mode
          : change.operation === "update"
            ? change.mode
            : change.before.mode,
      bytes: change.evidence.bytes,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function stageChangeCandidate(
  target: string,
  content: Buffer,
  mode: number,
  signal: AbortSignal,
): Promise<string> {
  const path = join(
    dirname(target),
    `.${basename(target)}.koda-change-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    handle = await open(path, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal.throwIfAborted();
    return path;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function commitPreparedChange(
  change: PreparedChange,
  stagedPath: string | undefined,
): Promise<void> {
  if (change.operation === "create") {
    if (stagedPath === undefined) {
      throw new WorkspaceError(
        "CHANGE_SET_APPLY_FAILED",
        `Create candidate was not staged: ${change.path}`,
      );
    }
    try {
      await link(stagedPath, change.target);
      return;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new WorkspaceError(
          "WORKSPACE_CHANGED",
          `Create target appeared during commit: ${change.path}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (change.operation === "update") {
    if (stagedPath === undefined) {
      throw new WorkspaceError(
        "CHANGE_SET_APPLY_FAILED",
        `Update candidate was not staged: ${change.path}`,
      );
    }
    await rename(stagedPath, change.target);
    return;
  }
  if (change.operation === "move") {
    try {
      await link(change.target, change.destination);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new WorkspaceError(
          "WORKSPACE_CHANGED",
          `Move destination appeared during commit: ${change.destinationPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await rm(change.target);
    } catch (error) {
      throw new PartiallyAppliedChangeError(
        `Move created '${change.destinationPath}' but could not remove '${change.path}'.`,
        { cause: error },
      );
    }
    return;
  }
  await rm(change.target);
}

async function rollbackPreparedChange(change: PreparedChange): Promise<void> {
  const cleanupSignal = new AbortController().signal;
  if (change.operation === "create") {
    await rm(change.target);
    return;
  }
  if (change.operation === "update") {
    await writeAtomicPatch({
      target: change.target,
      content: change.before.bytes,
      mode: change.before.mode,
      createOnly: false,
      signal: cleanupSignal,
      revalidate: () =>
        rawTargetMatches(
          change.target,
          change.evidence.afterSha256,
          change.mode,
        ),
    });
    return;
  }
  if (change.operation === "move") {
    try {
      await link(change.destination, change.target);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new WorkspaceError(
          "WORKSPACE_CHANGED",
          `Move source reappeared during rollback: ${change.path}`,
          { cause: error },
        );
      }
      throw error;
    }
    await rm(change.destination);
    return;
  }
  await writeAtomicPatch({
    target: change.target,
    content: change.before.bytes,
    mode: change.before.mode,
    createOnly: true,
    signal: cleanupSignal,
    revalidate: async () => !(await pathExists(change.target)),
  });
}

async function rawTargetMatches(
  target: string,
  expectedHash: string | null,
  expectedMode: number,
): Promise<boolean> {
  if (expectedHash === null) {
    return !(await pathExists(target));
  }
  try {
    if ((await realpath(target)) !== target) {
      return false;
    }
    const targetStats = await lstat(target);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      return false;
    }
    const bytes = await readFileFromDisk(target);
    return (
      hashBytes(bytes) === expectedHash &&
      (targetStats.mode & 0o777) === expectedMode
    );
  } catch {
    return false;
  }
}

function boundedErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code.slice(0, 128) || "UNKNOWN";
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name.slice(0, 128);
  }
  return "CHANGE_SET_APPLY_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PartiallyAppliedChangeError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PartiallyAppliedChangeError";
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
