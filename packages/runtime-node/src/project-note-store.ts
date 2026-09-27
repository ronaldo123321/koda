import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import Database from "better-sqlite3";

export interface ProjectNote {
  id: string;
  workspaceRoot: string;
  title: string;
  body: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectNoteMatch {
  id: string;
  title: string;
  snippet: string;
  score: number;
  updatedAt: string;
}

export class ProjectNoteError extends Error {
  public constructor(
    public readonly code:
      | "NOTE_INVALID"
      | "NOTE_NOT_FOUND"
      | "NOTE_CHANGED"
      | "NOTE_LIMIT_REACHED"
      | "NOTE_STORE_UNSAFE",
    message: string,
  ) {
    super(message);
    this.name = "ProjectNoteError";
  }
}

export interface ProjectNoteStoreOptions {
  now?: () => string;
  id?: () => string;
}

interface NoteRow {
  id: string;
  workspace_root: string;
  title: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const MAX_NOTES_PER_WORKSPACE = 64;
const MAX_TITLE_BYTES = 160;
const MAX_BODY_BYTES = 8_192;
const MAX_QUERY_BYTES = 256;

export class ProjectNoteStore {
  private constructor(
    private readonly database: Database.Database,
    private readonly options: ProjectNoteStoreOptions,
  ) {}

  public static async open(
    kodaHome: string,
    options: ProjectNoteStoreOptions = {},
  ): Promise<ProjectNoteStore> {
    const directory = join(resolve(kodaHome), "memory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new ProjectNoteError(
        "NOTE_STORE_UNSAFE",
        "Project note directory must be a real directory.",
      );
    }
    await chmod(directory, 0o700);
    const path = join(directory, "project-notes.db");
    try {
      const fileStats = await lstat(path);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        throw new ProjectNoteError(
          "NOTE_STORE_UNSAFE",
          "Project note database must be a regular file.",
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const database = new Database(path, { timeout: 5_000 });
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_notes (
          id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_notes_workspace_updated
          ON project_notes(workspace_root, updated_at DESC, id ASC);
      `);
      await chmod(path, 0o600);
      return new ProjectNoteStore(database, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public close(): void {
    this.database.close();
  }

  public list(workspaceRoot: string): ProjectNote[] {
    assertWorkspace(workspaceRoot);
    const rows = this.database
      .prepare(
        "SELECT * FROM project_notes WHERE workspace_root = ? ORDER BY updated_at DESC, id ASC LIMIT 64",
      )
      .all(workspaceRoot) as NoteRow[];
    return rows.map(projectNote);
  }

  public get(workspaceRoot: string, id: string): ProjectNote | undefined {
    assertWorkspace(workspaceRoot);
    assertId(id);
    const row = this.database
      .prepare(
        "SELECT * FROM project_notes WHERE workspace_root = ? AND id = ?",
      )
      .get(workspaceRoot, id) as NoteRow | undefined;
    return row === undefined ? undefined : projectNote(row);
  }

  public create(input: {
    workspaceRoot: string;
    title: string;
    body: string;
  }): ProjectNote {
    assertWorkspace(input.workspaceRoot);
    const title = validTitle(input.title);
    const body = validBody(input.body);
    return this.database.transaction(() => {
      const count = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM project_notes WHERE workspace_root = ?",
        )
        .get(input.workspaceRoot) as { count: number };
      if (count.count >= MAX_NOTES_PER_WORKSPACE) {
        throw new ProjectNoteError(
          "NOTE_LIMIT_REACHED",
          `A workspace can contain at most ${MAX_NOTES_PER_WORKSPACE} project notes.`,
        );
      }
      const id = (this.options.id ?? randomUUID)();
      assertId(id);
      const now = this.now();
      this.database
        .prepare(
          "INSERT INTO project_notes (id, workspace_root, title, body, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .run(id, input.workspaceRoot, title, body, now, now);
      return {
        id,
        workspaceRoot: input.workspaceRoot,
        title,
        body,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
    })();
  }

  public update(input: {
    workspaceRoot: string;
    id: string;
    expectedRevision: number;
    title?: string;
    body?: string;
  }): ProjectNote {
    assertWorkspace(input.workspaceRoot);
    assertId(input.id);
    assertRevision(input.expectedRevision);
    if (input.title === undefined && input.body === undefined) {
      throw new ProjectNoteError(
        "NOTE_INVALID",
        "A project note edit must provide a title or body.",
      );
    }
    return this.database.transaction(() => {
      const current = this.get(input.workspaceRoot, input.id);
      if (current === undefined) {
        throw new ProjectNoteError(
          "NOTE_NOT_FOUND",
          "Project note was not found.",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ProjectNoteError(
          "NOTE_CHANGED",
          "Project note changed; reload it before editing.",
        );
      }
      const title =
        input.title === undefined ? current.title : validTitle(input.title);
      const body =
        input.body === undefined ? current.body : validBody(input.body);
      const updatedAt = this.now();
      this.database
        .prepare(
          "UPDATE project_notes SET title = ?, body = ?, revision = revision + 1, updated_at = ? WHERE workspace_root = ? AND id = ? AND revision = ?",
        )
        .run(
          title,
          body,
          updatedAt,
          input.workspaceRoot,
          input.id,
          input.expectedRevision,
        );
      return {
        ...current,
        title,
        body,
        revision: current.revision + 1,
        updatedAt,
      };
    })();
  }

  public delete(input: {
    workspaceRoot: string;
    id: string;
    expectedRevision: number;
  }): void {
    assertWorkspace(input.workspaceRoot);
    assertId(input.id);
    assertRevision(input.expectedRevision);
    this.database.transaction(() => {
      const current = this.get(input.workspaceRoot, input.id);
      if (current === undefined) {
        throw new ProjectNoteError(
          "NOTE_NOT_FOUND",
          "Project note was not found.",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ProjectNoteError(
          "NOTE_CHANGED",
          "Project note changed; reload it before deleting.",
        );
      }
      this.database
        .prepare(
          "DELETE FROM project_notes WHERE workspace_root = ? AND id = ? AND revision = ?",
        )
        .run(input.workspaceRoot, input.id, input.expectedRevision);
    })();
  }

  public search(
    workspaceRoot: string,
    query: string,
    limit = 5,
  ): ProjectNoteMatch[] {
    assertWorkspace(workspaceRoot);
    const phrase = normalize(query.trim());
    const terms = phrase.split(/\s+/u).filter(Boolean);
    if (
      phrase.length === 0 ||
      utf8Bytes(phrase) > MAX_QUERY_BYTES ||
      terms.length > 8 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10
    ) {
      throw new ProjectNoteError(
        "NOTE_INVALID",
        "Search requires 1-8 terms, at most 256 UTF-8 bytes, and a limit from 1 to 10.",
      );
    }
    return this.list(workspaceRoot)
      .map((note) => {
        const title = normalize(note.title);
        const body = normalize(note.body);
        const score =
          (title.includes(phrase) ? 8 : 0) +
          (body.includes(phrase) ? 4 : 0) +
          terms.reduce(
            (total, term) =>
              total +
              (title.includes(term) ? 3 : 0) +
              (body.includes(term) ? 1 : 0),
            0,
          );
        return {
          note,
          score,
          snippet: snippet(note.body, terms),
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.note.updatedAt.localeCompare(left.note.updatedAt) ||
          left.note.id.localeCompare(right.note.id),
      )
      .slice(0, limit)
      .map(({ note, score, snippet: excerpt }) => ({
        id: note.id,
        title: note.title,
        snippet: excerpt,
        score,
        updatedAt: note.updatedAt,
      }));
  }

  private now(): string {
    const value = (this.options.now ?? (() => new Date().toISOString()))();
    if (Number.isNaN(Date.parse(value))) {
      throw new ProjectNoteError(
        "NOTE_INVALID",
        "Clock returned an invalid time.",
      );
    }
    return value;
  }
}

function projectNote(row: NoteRow): ProjectNote {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    title: row.title,
    body: row.body,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertWorkspace(workspaceRoot: string): void {
  if (!isAbsolute(workspaceRoot)) {
    throw new ProjectNoteError(
      "NOTE_INVALID",
      "Project notes require a canonical absolute workspace path.",
    );
  }
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
    throw new ProjectNoteError("NOTE_INVALID", "Invalid project note ID.");
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ProjectNoteError(
      "NOTE_INVALID",
      "Invalid project note revision.",
    );
  }
}

function validTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || utf8Bytes(title) > MAX_TITLE_BYTES) {
    throw new ProjectNoteError(
      "NOTE_INVALID",
      `Project note title must use 1-${MAX_TITLE_BYTES} UTF-8 bytes.`,
    );
  }
  return title;
}

function validBody(value: string): string {
  if (value.trim().length === 0 || utf8Bytes(value) > MAX_BODY_BYTES) {
    throw new ProjectNoteError(
      "NOTE_INVALID",
      `Project note body must use 1-${MAX_BODY_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function snippet(body: string, terms: readonly string[]): string {
  const normalized = normalize(body);
  const first = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (first ?? 0) - 48);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 240)}${start + 240 < body.length ? "…" : ""}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
