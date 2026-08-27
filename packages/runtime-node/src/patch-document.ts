import {
  WorkspaceError,
  type WorkspaceChange,
  type WorkspaceLineEdit,
} from "./read-only-workspace.js";

export const MAX_PATCH_DOCUMENT_BYTES = 262_144;
export const MAX_PATCH_DOCUMENT_CHANGES = 16;
export const MAX_PATCH_DOCUMENT_HUNKS = 32;
export const MAX_PATCH_DOCUMENT_LINE_BYTES = 65_536;
export const MAX_PATCH_DOCUMENT_PATH_BYTES = 4_096;

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const NO_FINAL_NEWLINE = "*** No Final Newline";
const ADD_FILE_PREFIX = "*** Add File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_FILE_PREFIX = "*** Move File: ";
const MOVE_TO_PREFIX = "*** To: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";

export function parsePatchDocument(patch: string): WorkspaceChange[] {
  assertPatchDocumentText(patch);
  const lines = splitPatchDocumentLines(patch);
  if (lines[0] !== BEGIN_PATCH) {
    invalid(1, `Patch document must begin with '${BEGIN_PATCH}'.`);
  }

  const changes: WorkspaceChange[] = [];
  let hunkCount = 0;
  let cursor = 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === END_PATCH) {
      if (changes.length === 0) {
        invalid(
          cursor + 1,
          "Patch document requires at least one file section.",
        );
      }
      if (cursor !== lines.length - 1) {
        invalid(
          cursor + 2,
          "Patch document contains data after its end marker.",
        );
      }
      return changes;
    }
    if (changes.length >= MAX_PATCH_DOCUMENT_CHANGES) {
      limit(
        cursor + 1,
        `Patch document cannot exceed ${MAX_PATCH_DOCUMENT_CHANGES} file sections.`,
      );
    }

    if (line?.startsWith(ADD_FILE_PREFIX)) {
      const path = parseHeaderPath(line, ADD_FILE_PREFIX, cursor + 1);
      cursor += 1;
      const contentLines: string[] = [];
      while (cursor < lines.length && lines[cursor]?.startsWith("+")) {
        const content = lines[cursor]?.slice(1) ?? "";
        assertContentLine(content, cursor + 1);
        contentLines.push(content);
        cursor += 1;
      }
      if (contentLines.length === 0) {
        invalid(
          cursor + 1,
          `Add section for '${path}' requires at least one '+' line.`,
        );
      }
      let finalNewline = true;
      if (lines[cursor] === NO_FINAL_NEWLINE) {
        finalNewline = false;
        cursor += 1;
      }
      assertSectionBoundary(lines, cursor);
      changes.push({
        operation: "create",
        path,
        content: `${contentLines.join("\n")}${finalNewline ? "\n" : ""}`,
      });
      continue;
    }

    if (line?.startsWith(UPDATE_FILE_PREFIX)) {
      const path = parseHeaderPath(line, UPDATE_FILE_PREFIX, cursor + 1);
      cursor += 1;
      const edits: WorkspaceLineEdit[] = [];
      while (lines[cursor] === "@@") {
        hunkCount += 1;
        if (hunkCount > MAX_PATCH_DOCUMENT_HUNKS) {
          limit(
            cursor + 1,
            `Patch document cannot exceed ${MAX_PATCH_DOCUMENT_HUNKS} update hunks.`,
          );
        }
        cursor += 1;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let changed = false;
        while (cursor < lines.length && !isMarker(lines[cursor])) {
          const hunkLine = lines[cursor] ?? "";
          const prefix = hunkLine[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            invalid(
              cursor + 1,
              "Update hunk lines must begin with one space, '+', or '-'.",
            );
          }
          const content = hunkLine.slice(1);
          assertContentLine(content, cursor + 1);
          if (prefix === " ") {
            oldLines.push(content);
            newLines.push(content);
          } else if (prefix === "-") {
            oldLines.push(content);
            changed = true;
          } else {
            newLines.push(content);
            changed = true;
          }
          cursor += 1;
        }
        if (!changed) {
          invalid(
            cursor + 1,
            `Update hunk for '${path}' does not change content.`,
          );
        }
        if (oldLines.length === 0) {
          invalid(
            cursor + 1,
            `Update hunk for '${path}' requires context or a removed line.`,
          );
        }
        edits.push({ oldLines, newLines });
      }
      if (edits.length === 0) {
        invalid(
          cursor + 1,
          `Update section for '${path}' requires at least one '@@' hunk.`,
        );
      }
      assertSectionBoundary(lines, cursor);
      changes.push({ operation: "update", path, edits });
      continue;
    }

    if (line?.startsWith(MOVE_FILE_PREFIX)) {
      const fromPath = parseHeaderPath(line, MOVE_FILE_PREFIX, cursor + 1);
      cursor += 1;
      const destination = lines[cursor];
      if (
        destination === undefined ||
        !destination.startsWith(MOVE_TO_PREFIX)
      ) {
        invalid(
          cursor + 1,
          `Move section for '${fromPath}' requires a '${MOVE_TO_PREFIX.trim()}' line.`,
        );
      }
      const toPath = parseHeaderPath(destination, MOVE_TO_PREFIX, cursor + 1);
      cursor += 1;
      assertSectionBoundary(lines, cursor);
      changes.push({ operation: "move", fromPath, toPath });
      continue;
    }

    if (line?.startsWith(DELETE_FILE_PREFIX)) {
      const path = parseHeaderPath(line, DELETE_FILE_PREFIX, cursor + 1);
      cursor += 1;
      assertSectionBoundary(lines, cursor);
      changes.push({ operation: "delete", path });
      continue;
    }

    invalid(
      cursor + 1,
      line === BEGIN_PATCH
        ? "Patch document contains a duplicate begin marker."
        : `Unknown patch document marker at line ${cursor + 1}.`,
    );
  }

  invalid(lines.length, `Patch document must end with '${END_PATCH}'.`);
}

function splitPatchDocumentLines(patch: string): string[] {
  if (/\r(?!\n)/u.test(patch)) {
    invalid(1, "Patch document contains a lone carriage return.");
  }
  const hasCrLf = patch.includes("\r\n");
  if (hasCrLf && patch.replaceAll("\r\n", "").includes("\n")) {
    invalid(1, "Patch document must use consistent LF or CRLF line endings.");
  }
  const normalized = hasCrLf ? patch.replaceAll("\r\n", "\n") : patch;
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function assertPatchDocumentText(patch: string): void {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.byteLength > MAX_PATCH_DOCUMENT_BYTES) {
    limit(
      1,
      `Patch document exceeds the ${MAX_PATCH_DOCUMENT_BYTES}-byte limit.`,
    );
  }
  if (bytes.toString("utf8") !== patch) {
    invalid(1, "Patch document must be valid UTF-8 text.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(patch)) {
    invalid(1, "Patch document contains a forbidden control character.");
  }
}

function parseHeaderPath(
  line: string,
  prefix: string,
  lineNumber: number,
): string {
  const path = line.slice(prefix.length);
  if (path.length === 0 || path !== path.trim()) {
    invalid(
      lineNumber,
      "Patch paths must be non-empty without surrounding whitespace.",
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
    invalid(lineNumber, "Patch paths cannot contain control characters.");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_PATCH_DOCUMENT_PATH_BYTES) {
    limit(
      lineNumber,
      `Patch path exceeds the ${MAX_PATCH_DOCUMENT_PATH_BYTES}-byte limit.`,
    );
  }
  return path;
}

function assertContentLine(line: string, lineNumber: number): void {
  if (Buffer.byteLength(line, "utf8") > MAX_PATCH_DOCUMENT_LINE_BYTES) {
    limit(
      lineNumber,
      `Patch content line exceeds the ${MAX_PATCH_DOCUMENT_LINE_BYTES}-byte limit.`,
    );
  }
}

function assertSectionBoundary(lines: readonly string[], cursor: number): void {
  const line = lines[cursor];
  if (line === undefined) {
    invalid(lines.length, `Patch document must end with '${END_PATCH}'.`);
  }
  if (!isSectionHeader(line) && line !== END_PATCH) {
    invalid(
      cursor + 1,
      `Unexpected patch document content at line ${cursor + 1}.`,
    );
  }
}

function isSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(UPDATE_FILE_PREFIX) ||
    line.startsWith(MOVE_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX)
  );
}

function isMarker(line: string | undefined): boolean {
  return line === "@@" || line?.startsWith("*** ") === true;
}

function invalid(line: number, message: string): never {
  throw new WorkspaceError(
    "PATCH_DOCUMENT_INVALID",
    `Invalid patch document at line ${Math.max(1, line)}: ${message}`,
  );
}

function limit(line: number, message: string): never {
  throw new WorkspaceError(
    "PATCH_DOCUMENT_LIMIT_EXCEEDED",
    `Patch document limit at line ${Math.max(1, line)}: ${message}`,
  );
}
