import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { ThreadRecoveryError } from "./thread-recovery.js";

interface ThreadLeaseRecord {
  pid: number;
  createdAt: string;
  token: string;
}

export interface ThreadLeaseOptions {
  pid?: number;
  now?: () => string;
  token?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ThreadLeaseInspectionOptions {
  isProcessAlive?: (pid: number) => boolean;
}

export class ThreadLease {
  private released = false;

  private constructor(
    public readonly path: string,
    private readonly record: ThreadLeaseRecord,
  ) {}

  public static async acquire(
    eventLogPath: string,
    options: ThreadLeaseOptions = {},
  ): Promise<ThreadLease> {
    const path = `${eventLogPath}.lock`;
    const record: ThreadLeaseRecord = {
      pid: options.pid ?? process.pid,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      token: (options.token ?? randomUUID)(),
    };
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    await mkdir(dirname(path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ThreadLease(path, record);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        const existing = await readLease(path);
        if (existing === undefined || isAlive(existing.pid)) {
          throw new ThreadRecoveryError(
            "THREAD_BUSY",
            `Thread is already owned by process ${existing?.pid ?? "unknown"}.`,
          );
        }
        await rm(path, { force: true });
      }
    }
    throw new ThreadRecoveryError(
      "THREAD_BUSY",
      "Thread lease could not be acquired after removing a stale owner.",
    );
  }

  public static async isActive(
    eventLogPath: string,
    options: ThreadLeaseInspectionOptions = {},
  ): Promise<boolean> {
    const path = `${eventLogPath}.lock`;
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    const record = parseLease(content);
    if (record === undefined) {
      return true;
    }
    return (options.isProcessAlive ?? isProcessAlive)(record.pid);
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    const existing = await readLease(this.path);
    if (existing?.token === this.record.token) {
      await rm(this.path, { force: true });
    }
  }
}

async function readLease(path: string): Promise<ThreadLeaseRecord | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return parseLease(content);
}

function parseLease(content: string): ThreadLeaseRecord | undefined {
  try {
    const value = JSON.parse(content) as Partial<ThreadLeaseRecord>;
    return typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.createdAt === "string" &&
      typeof value.token === "string" &&
      value.token.length > 0
      ? { pid: value.pid, createdAt: value.createdAt, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
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
