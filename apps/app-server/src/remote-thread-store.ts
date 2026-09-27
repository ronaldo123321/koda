import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import type { RemoteThreadBinding } from "./remote-access.js";

const MAX_BINDING_BYTES = 1_024;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const threadIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const bindingSchema = z
  .object({
    version: z.literal(1),
    ownerId: idSchema,
    workspaceId: idSchema,
    threadId: threadIdSchema,
  })
  .strict();

export class RemoteThreadStore {
  private constructor(
    private readonly root: string,
    private readonly ownerId: string,
  ) {}

  public static async open(
    kodaHome: string,
    ownerId: string,
  ): Promise<RemoteThreadStore> {
    if (process.platform === "win32") {
      throw new Error("Remote Thread bindings are unavailable on Windows.");
    }
    idSchema.parse(ownerId);
    const root = join(resolve(kodaHome), "remote", "threads");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || !ownedByCurrentUser(info.uid)) {
      throw new Error("Remote Thread directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteThreadStore(root, ownerId);
  }

  public async bind(binding: RemoteThreadBinding): Promise<void> {
    const file = bindingSchema.parse({ version: 1, ...binding });
    if (file.ownerId !== this.ownerId) {
      throw new Error("Remote Thread owner does not match.");
    }
    const path = this.pathFor(file.threadId);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(file), "utf8");
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
      // The file was synchronized; directory sync is best effort.
    }
  }

  public async get(threadId: string): Promise<RemoteThreadBinding | undefined> {
    threadIdSchema.parse(threadId);
    let handle;
    try {
      handle = await open(
        this.pathFor(threadId),
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
        info.size > MAX_BINDING_BYTES
      ) {
        throw new Error("Remote Thread binding is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_BINDING_BYTES) {
        throw new Error("Remote Thread binding is too large.");
      }
      const file = bindingSchema.parse(JSON.parse(content));
      if (file.ownerId !== this.ownerId || file.threadId !== threadId) {
        throw new Error("Remote Thread binding does not match.");
      }
      return {
        ownerId: file.ownerId,
        workspaceId: file.workspaceId,
        threadId: file.threadId,
      };
    } finally {
      await handle.close();
    }
  }

  private pathFor(threadId: string): string {
    return join(this.root, `${threadId}.json`);
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
