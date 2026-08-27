import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceMutationErrorCode = "WORKSPACE_MUTATION_BUSY";

export class WorkspaceMutationError extends Error {
  public constructor(
    public readonly code: WorkspaceMutationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMutationError";
  }
}

interface WorkspaceMutationLeaseRecord {
  pid: number;
  createdAt: string;
  token: string;
  workspaceRoot: string;
}

export interface WorkspaceMutationCoordinatorOptions {
  pid?: number;
  now?: () => string;
  nowMilliseconds?: () => number;
  token?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class WorkspaceMutationCoordinator {
  public readonly leasePath: string;

  private constructor(
    public readonly workspaceRoot: string,
    private readonly options: Required<WorkspaceMutationCoordinatorOptions>,
    leaseDirectory: string,
  ) {
    const workspaceKey = createHash("sha256")
      .update(workspaceRoot, "utf8")
      .digest("hex");
    this.leasePath = join(leaseDirectory, `${workspaceKey}.lock`);
  }

  public static async open(
    kodaHome: string,
    workspaceRoot: string,
    options: WorkspaceMutationCoordinatorOptions = {},
  ): Promise<WorkspaceMutationCoordinator> {
    const leaseDirectory = join(kodaHome, "workspace-mutation-leases");
    await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
    return new WorkspaceMutationCoordinator(
      workspaceRoot,
      {
        pid: options.pid ?? process.pid,
        now: options.now ?? (() => new Date().toISOString()),
        nowMilliseconds: options.nowMilliseconds ?? Date.now,
        token: options.token ?? randomUUID,
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
        waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
        pollIntervalMs: options.pollIntervalMs ?? 50,
      },
      leaseDirectory,
    );
  }

  public async runExclusive<T>(
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      await release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
    const startedAt = this.options.nowMilliseconds();
    const record: WorkspaceMutationLeaseRecord = {
      pid: this.options.pid,
      createdAt: this.options.now(),
      token: this.options.token(),
      workspaceRoot: this.workspaceRoot,
    };

    while (true) {
      signal.throwIfAborted();
      try {
        const handle = await open(this.leasePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          const existing = await readLease(this.leasePath);
          if (existing?.token === record.token) {
            await rm(this.leasePath, { force: true });
          }
        };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
      }

      const existing = await readLease(this.leasePath);
      if (
        existing !== undefined &&
        !this.options.isProcessAlive(existing.pid)
      ) {
        await rm(this.leasePath, { force: true });
        continue;
      }
      if (
        this.options.nowMilliseconds() - startedAt >=
        this.options.waitTimeoutMs
      ) {
        throw new WorkspaceMutationError(
          "WORKSPACE_MUTATION_BUSY",
          `Workspace mutation lease is owned by process ${existing?.pid ?? "unknown"}.`,
        );
      }
      await waitForPoll(this.options.pollIntervalMs, signal);
    }
  }
}

async function waitForPoll(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLease(
  path: string,
): Promise<WorkspaceMutationLeaseRecord | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  try {
    const value = JSON.parse(content) as Partial<WorkspaceMutationLeaseRecord>;
    return typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.createdAt === "string" &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.workspaceRoot === "string" &&
      value.workspaceRoot.length > 0
      ? {
          pid: value.pid,
          createdAt: value.createdAt,
          token: value.token,
          workspaceRoot: value.workspaceRoot,
        }
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
