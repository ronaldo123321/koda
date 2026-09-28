import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ThreadLease } from "@koda/runtime-node";
import { z } from "zod";

const MAX_RECORD_BYTES = 2 * 1_024;
const idSchema = z.string().min(1).max(128);
const recordSchema = z
  .object({
    version: z.literal(1),
    ownerId: idSchema,
    workspaceId: idSchema,
    threadId: idSchema,
    turnId: idSchema,
    callId: idSchema,
    deviceId: z.string().regex(/^device-[a-f0-9]{32}$/u),
    expiresAt: z.string().datetime({ offset: true }),
    status: z.enum(["pending", "approved", "rejected"]),
  })
  .strict();

export type RemoteApprovalLeaseRecord = z.infer<typeof recordSchema>;
export type RemoteApprovalLeaseInput = Omit<
  RemoteApprovalLeaseRecord,
  "version" | "status"
>;

export class RemoteApprovalLeaseStore {
  private constructor(private readonly root: string) {}

  public static async open(
    kodaHome: string,
  ): Promise<RemoteApprovalLeaseStore> {
    if (process.platform === "win32") {
      throw new Error(
        "Remote approval lease recovery is unavailable on Windows.",
      );
    }
    const root = join(resolve(kodaHome), "remote", "approval-leases");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    ) {
      throw new Error("Remote approval lease directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteApprovalLeaseStore(root);
  }

  public async begin(input: RemoteApprovalLeaseInput): Promise<void> {
    const record = recordSchema.parse({
      version: 1,
      ...input,
      status: "pending",
    });
    await this.writeNew(this.pathFor(record), record);
  }

  public async get(
    threadId: string,
    turnId: string,
    callId: string,
  ): Promise<RemoteApprovalLeaseRecord | undefined> {
    const path = this.pathFor({ threadId, turnId, callId });
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        (process.getuid !== undefined && info.uid !== process.getuid()) ||
        (info.mode & 0o077) !== 0 ||
        info.size > MAX_RECORD_BYTES
      ) {
        throw new Error("Remote approval lease file is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
        throw new Error("Remote approval lease file is too large.");
      }
      const record = recordSchema.parse(JSON.parse(content));
      if (
        record.threadId !== threadId ||
        record.turnId !== turnId ||
        record.callId !== callId
      ) {
        throw new Error("Remote approval lease identity does not match.");
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  public async transfer(
    threadId: string,
    turnId: string,
    callId: string,
    fromDeviceId: string,
    toDeviceId: string,
  ): Promise<void> {
    await this.change(threadId, turnId, callId, (record) => {
      if (record.status !== "pending" || record.deviceId !== fromDeviceId) {
        throw new Error("Remote approval lease is no longer transferable.");
      }
      return { ...record, deviceId: toDeviceId };
    });
  }

  public async finish(
    threadId: string,
    turnId: string,
    callId: string,
    deviceId: string,
    status: "approved" | "rejected",
  ): Promise<void> {
    await this.change(threadId, turnId, callId, (record) => {
      if (record.status !== "pending" || record.deviceId !== deviceId) {
        throw new Error("Remote approval lease is no longer pending.");
      }
      return { ...record, status };
    });
  }

  private async change(
    threadId: string,
    turnId: string,
    callId: string,
    edit: (record: RemoteApprovalLeaseRecord) => RemoteApprovalLeaseRecord,
  ): Promise<void> {
    const path = this.pathFor({ threadId, turnId, callId });
    const lease = await ThreadLease.acquire(path);
    try {
      const record = await this.get(threadId, turnId, callId);
      if (record === undefined)
        throw new Error("Remote approval lease is missing.");
      const next = recordSchema.parse(edit(record));
      const temporary = join(this.root, `${randomUUID()}.tmp`);
      try {
        await this.writeNew(temporary, next);
        await rename(temporary, path);
        await syncDirectory(this.root);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      await lease.release();
    }
  }

  private pathFor(input: {
    threadId: string;
    turnId: string;
    callId: string;
  }): string {
    const keys = [input.threadId, input.turnId, input.callId].map((value) =>
      idSchema.parse(value),
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(keys))
      .digest("hex");
    return join(this.root, `${digest}.json`);
  }

  private async writeNew(
    path: string,
    record: RemoteApprovalLeaseRecord,
  ): Promise<void> {
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
      throw new Error("Remote approval lease file is too large.");
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
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
