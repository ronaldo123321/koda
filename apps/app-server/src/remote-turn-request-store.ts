import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import { ThreadLease, ThreadRecoveryError } from "@koda/runtime-node";

import { RemoteThreadStore } from "./remote-thread-store.js";

const MAX_RECORD_BYTES = 2 * 1_024;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const requestIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const deviceIdSchema = z.string().regex(/^device-[a-f0-9]{32}$/u);
const threadIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const recordSchema = z
  .object({
    version: z.literal(1),
    ownerId: idSchema,
    requestId: requestIdSchema,
    deviceId: deviceIdSchema,
    workspaceId: idSchema,
    bodySha256: sha256Schema,
    threadId: threadIdSchema,
    turnId: threadIdSchema,
    status: z.enum(["reserved", "started", "abandoned"]),
  })
  .strict();

export type RemoteTurnRequestRecord = z.infer<typeof recordSchema>;
export type RemoteTurnRequestClaim = Omit<
  RemoteTurnRequestRecord,
  "version" | "ownerId" | "status"
>;

export class RemoteTurnRequestConflictError extends Error {
  public constructor() {
    super("Remote Turn request ID was already used for another request.");
    this.name = "RemoteTurnRequestConflictError";
  }
}

export class RemoteTurnRequestBusyError extends Error {
  public constructor() {
    super("Remote Turn request is still being started.");
    this.name = "RemoteTurnRequestBusyError";
  }
}

export class RemoteTurnRequestStore {
  private constructor(
    private readonly root: string,
    private readonly ownerId: string,
  ) {}

  public static async open(
    kodaHome: string,
    ownerId: string,
  ): Promise<RemoteTurnRequestStore> {
    if (process.platform === "win32") {
      throw new Error(
        "Remote Turn request records are unavailable on Windows.",
      );
    }
    idSchema.parse(ownerId);
    const root = join(resolve(kodaHome), "remote", "turn-requests");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || !ownedByCurrentUser(info.uid)) {
      throw new Error("Remote Turn request directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteTurnRequestStore(root, ownerId);
  }

  public async claim(input: RemoteTurnRequestClaim): Promise<{
    record: RemoteTurnRequestRecord;
    created: boolean;
  }> {
    const record = recordSchema.parse({
      version: 1,
      ownerId: this.ownerId,
      ...input,
      status: "reserved",
    });
    try {
      await this.writeNew(
        this.pathFor(input.requestId),
        JSON.stringify(record),
      );
      return { record, created: true };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await this.get(input.requestId);
      if (
        existing === undefined ||
        existing.deviceId !== input.deviceId ||
        existing.workspaceId !== input.workspaceId ||
        existing.bodySha256 !== input.bodySha256
      ) {
        throw new RemoteTurnRequestConflictError();
      }
      return { record: existing, created: false };
    }
  }

  public async get(
    requestId: string,
  ): Promise<RemoteTurnRequestRecord | undefined> {
    requestIdSchema.parse(requestId);
    let handle;
    try {
      handle = await open(
        this.pathFor(requestId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
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
        throw new Error("Remote Turn request record is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
        throw new Error("Remote Turn request record is too large.");
      }
      const record = recordSchema.parse(JSON.parse(content));
      if (record.ownerId !== this.ownerId || record.requestId !== requestId) {
        throw new Error("Remote Turn request record does not match.");
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  public async markStarted(
    requestId: string,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const record = await this.get(requestId);
    if (
      record === undefined ||
      record.threadId !== threadId ||
      record.turnId !== turnId
    ) {
      throw new Error("Remote Turn request record does not match.");
    }
    if (record.status === "started") return;
    if (record.status !== "reserved") {
      throw new Error("Remote Turn request is no longer reserved.");
    }
    await this.replace(record, "started");
  }

  public async abandon(
    requestId: string,
    threads: RemoteThreadStore,
  ): Promise<RemoteTurnRequestRecord> {
    const lease = await this.acquireLease(requestId);
    try {
      const record = await this.get(requestId);
      if (record === undefined)
        throw new Error("Remote Turn request is unavailable.");
      if (record.status === "abandoned") return record;
      if (record.status !== "reserved") {
        throw new Error(
          "Only a reserved remote Turn request can be abandoned.",
        );
      }
      if ((await threads.get(record.threadId)) !== undefined) {
        throw new Error("Remote Turn request already has a Thread binding.");
      }
      try {
        await lstat(
          join(
            resolve(this.root, "../.."),
            "threads",
            `${record.threadId}.jsonl`,
          ),
        );
        throw new Error("Remote Turn request already has a Thread log.");
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      await this.replace(record, "abandoned");
      return { ...record, status: "abandoned" };
    } finally {
      await lease.release();
    }
  }

  public async acquireLease(requestId: string): Promise<ThreadLease> {
    requestIdSchema.parse(requestId);
    try {
      return await ThreadLease.acquire(this.pathFor(requestId));
    } catch (error) {
      if (
        error instanceof ThreadRecoveryError &&
        error.code === "THREAD_BUSY"
      ) {
        throw new RemoteTurnRequestBusyError();
      }
      throw error;
    }
  }

  private pathFor(requestId: string): string {
    return join(this.root, `${requestId}.json`);
  }

  private async replace(
    record: RemoteTurnRequestRecord,
    status: RemoteTurnRequestRecord["status"],
  ): Promise<void> {
    const temporary = join(
      this.root,
      `${record.requestId}.${randomUUID()}.tmp`,
    );
    await this.writeNew(temporary, JSON.stringify({ ...record, status }));
    await rename(temporary, this.pathFor(record.requestId));
    await syncDirectory(this.root);
  }

  private async writeNew(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
      throw new Error("Remote Turn request record is too large.");
    }
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.root);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The record was synchronized; directory sync is best effort.
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
