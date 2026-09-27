import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type { RemoteWorkspaceDefinition } from "./remote-access.js";

const MAX_WORKSPACES = 32;
const MAX_RECORD_BYTES = 8 * 1_024;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const recordSchema = z
  .object({
    version: z.literal(1),
    ownerId: idSchema,
    id: idSchema,
    root: z.string().min(1).max(4_096),
  })
  .strict();

export class RemoteWorkspaceStore {
  private constructor(
    private readonly root: string,
    private readonly ownerId: string,
  ) {}

  public static async open(
    kodaHome: string,
    ownerId: string,
  ): Promise<RemoteWorkspaceStore> {
    if (process.platform === "win32") {
      throw new Error(
        "Remote workspace registration is unavailable on Windows.",
      );
    }
    idSchema.parse(ownerId);
    const root = join(resolve(kodaHome), "remote", "workspaces");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || !ownedByCurrentUser(info.uid)) {
      throw new Error("Remote workspace directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteWorkspaceStore(root, ownerId);
  }

  public async register(
    id: string,
    requestedRoot: string,
  ): Promise<RemoteWorkspaceDefinition> {
    idSchema.parse(id);
    if (!isAbsolute(requestedRoot)) {
      throw new Error("Remote workspace path must be absolute.");
    }
    const root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("Remote workspace path must be a directory.");
    }
    const existing = await this.list();
    if (
      existing.length >= MAX_WORKSPACES ||
      existing.some((item) => item.root === root)
    ) {
      throw new Error("Remote workspace registration is invalid.");
    }
    const record = recordSchema.parse({
      version: 1,
      ownerId: this.ownerId,
      id,
      root,
    });
    const handle = await open(
      this.pathFor(id),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const directory = await open(this.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // File synchronization succeeded; directory sync is best effort.
    }
    return { id, root };
  }

  public async get(id: string): Promise<RemoteWorkspaceDefinition | undefined> {
    idSchema.parse(id);
    let handle;
    try {
      handle = await open(
        this.pathFor(id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        !ownedByCurrentUser(info.uid) ||
        (info.mode & 0o077) !== 0 ||
        info.size > MAX_RECORD_BYTES
      ) {
        throw new Error("Remote workspace record is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("Remote workspace record is too large.");
      }
      const record = recordSchema.parse(JSON.parse(content));
      if (record.ownerId !== this.ownerId || record.id !== id) {
        throw new Error("Remote workspace record does not match.");
      }
      if ((await realpath(record.root)) !== record.root) {
        throw new Error("Remote workspace path changed.");
      }
      return { id, root: record.root };
    } finally {
      await handle.close();
    }
  }

  public async list(): Promise<RemoteWorkspaceDefinition[]> {
    const entries = await readdir(this.root);
    if (entries.length > MAX_WORKSPACES) {
      throw new Error("Remote workspace directory is too large.");
    }
    const workspaces: RemoteWorkspaceDefinition[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) {
        throw new Error(
          "Remote workspace directory contains an unknown entry.",
        );
      }
      const workspace = await this.get(entry.slice(0, -5));
      if (workspace === undefined) {
        throw new Error("Remote workspace record disappeared.");
      }
      workspaces.push(workspace);
    }
    return workspaces;
  }

  private pathFor(id: string): string {
    return join(this.root, `${id}.json`);
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
