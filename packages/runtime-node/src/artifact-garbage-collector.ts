import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { collectArtifactReferences, type ArtifactId } from "@koda/protocol";

import { JsonlEventStore } from "./jsonl-event-store.js";
import { ThreadLease } from "./thread-lease.js";

const DEFAULT_MINIMUM_AGE_MS = 86_400_000;
const LOCAL_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_PREFIX = /^[a-f0-9]{2}$/u;

export type ArtifactGarbageCollectionErrorCode =
  | "ARTIFACT_GC_LOCKED"
  | "ARTIFACT_GC_ACTIVE_THREADS"
  | "ARTIFACT_GC_UNSAFE_SCAN"
  | "ARTIFACT_GC_INVALID_OPTIONS";

export class ArtifactGarbageCollectionError extends Error {
  public constructor(
    public readonly code: ArtifactGarbageCollectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactGarbageCollectionError";
  }
}

interface MaintenanceLeaseRecord {
  pid: number;
  createdAt: string;
  token: string;
}

export interface ArtifactMaintenanceLeaseOptions {
  pid?: number;
  now?: () => string;
  token?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ArtifactMaintenanceLeaseInspectionOptions {
  isProcessAlive?: (pid: number) => boolean;
}

export class ArtifactMaintenanceLease {
  private released = false;

  private constructor(
    public readonly path: string,
    private readonly record: MaintenanceLeaseRecord,
  ) {}

  public static async acquire(
    artifactRoot: string,
    options: ArtifactMaintenanceLeaseOptions = {},
  ): Promise<ArtifactMaintenanceLease> {
    const root = resolve(artifactRoot);
    const path = join(root, "gc.lock");
    const record: MaintenanceLeaseRecord = {
      pid: options.pid ?? process.pid,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      token: (options.token ?? randomUUID)(),
    };
    const processIsAlive = options.isProcessAlive ?? isProcessAlive;
    await mkdir(root, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ArtifactMaintenanceLease(path, record);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        const existing = await readMaintenanceLease(path);
        if (existing === undefined || processIsAlive(existing.pid)) {
          throw new ArtifactGarbageCollectionError(
            "ARTIFACT_GC_LOCKED",
            `Artifact maintenance is already owned by process ${existing?.pid ?? "unknown"}.`,
          );
        }
        await rm(path, { force: true });
      }
    }
    throw new ArtifactGarbageCollectionError(
      "ARTIFACT_GC_LOCKED",
      "Artifact maintenance lease could not be acquired after removing a stale owner.",
    );
  }

  public static async assertInactive(
    artifactRoot: string,
    options: ArtifactMaintenanceLeaseInspectionOptions = {},
  ): Promise<void> {
    const path = join(resolve(artifactRoot), "gc.lock");
    const content = await readOptionalFile(path);
    if (content === undefined) {
      return;
    }
    const record = parseMaintenanceLease(content);
    if (
      record === undefined ||
      (options.isProcessAlive ?? isProcessAlive)(record.pid)
    ) {
      throw new ArtifactGarbageCollectionError(
        "ARTIFACT_GC_LOCKED",
        `Artifact maintenance is already owned by process ${record?.pid ?? "unknown"}.`,
      );
    }
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    const existing = await readMaintenanceLease(this.path);
    if (existing?.token === this.record.token) {
      await rm(this.path, { force: true });
    }
  }
}

export interface ArtifactGarbageCollectionCandidate {
  id: ArtifactId;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface ArtifactGarbageCollectionDiagnostic {
  path: string;
  message: string;
}

export interface ArtifactGarbageCollectionReport {
  mode: "dry-run" | "delete";
  minimumAgeMs: number;
  logsScanned: number;
  artifactsScanned: number;
  reachableArtifacts: number;
  candidates: ArtifactGarbageCollectionCandidate[];
  deletedArtifacts: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
  diagnostics: ArtifactGarbageCollectionDiagnostic[];
}

export interface ArtifactGarbageCollectionOptions {
  delete?: boolean;
  minimumAgeMs?: number;
  now?: () => number;
  lease?: ArtifactMaintenanceLeaseOptions;
}

export class ArtifactGarbageCollector {
  private readonly kodaHome: string;
  private readonly artifactRoot: string;

  public constructor(kodaHome: string) {
    this.kodaHome = resolve(kodaHome);
    this.artifactRoot = join(this.kodaHome, "artifacts");
  }

  public async collect(
    options: ArtifactGarbageCollectionOptions = {},
  ): Promise<ArtifactGarbageCollectionReport> {
    const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_MINIMUM_AGE_MS;
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
      throw new ArtifactGarbageCollectionError(
        "ARTIFACT_GC_INVALID_OPTIONS",
        "Artifact minimum age must be a non-negative safe integer in milliseconds.",
      );
    }
    const now = (options.now ?? Date.now)();
    if (!Number.isFinite(now)) {
      throw new ArtifactGarbageCollectionError(
        "ARTIFACT_GC_INVALID_OPTIONS",
        "Artifact collection clock must return a finite timestamp.",
      );
    }

    const lease = await ArtifactMaintenanceLease.acquire(
      this.artifactRoot,
      options.lease,
    );
    try {
      const reachability = await this.scanReachability();
      const inventory = await this.scanArtifacts(
        reachability.artifactIds,
        minimumAgeMs,
        now,
      );
      let deletedArtifacts = 0;
      let reclaimedBytes = 0;
      if (options.delete === true) {
        for (const candidate of inventory.candidates) {
          await rm(candidate.path);
          deletedArtifacts += 1;
          reclaimedBytes += candidate.bytes;
        }
      }
      return {
        mode: options.delete === true ? "delete" : "dry-run",
        minimumAgeMs,
        logsScanned: reachability.logsScanned,
        artifactsScanned: inventory.artifactsScanned,
        reachableArtifacts: reachability.artifactIds.size,
        candidates: inventory.candidates,
        deletedArtifacts,
        reclaimableBytes: inventory.candidates.reduce(
          (total, candidate) => total + candidate.bytes,
          0,
        ),
        reclaimedBytes,
        diagnostics: inventory.diagnostics,
      };
    } finally {
      await lease.release();
    }
  }

  private async scanReachability(): Promise<{
    artifactIds: Set<ArtifactId>;
    logsScanned: number;
  }> {
    const threadRoot = join(this.kodaHome, "threads");
    const entries = await readDirectory(threadRoot);
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl.lock")) {
        continue;
      }
      const threadId = entry.name.slice(0, -".jsonl.lock".length);
      if (!entry.isFile() || !LOCAL_THREAD_ID.test(threadId)) {
        throw unsafeScan(`Unsafe thread lease path '${entry.name}'.`);
      }
      const eventLogPath = join(threadRoot, `${threadId}.jsonl`);
      let active: boolean;
      try {
        active = await ThreadLease.isActive(eventLogPath);
      } catch (error) {
        throw unsafeScan(
          `Thread lease '${entry.name}' could not be inspected.`,
          error,
        );
      }
      if (active) {
        throw new ArtifactGarbageCollectionError(
          "ARTIFACT_GC_ACTIVE_THREADS",
          `Artifact collection is blocked by active thread '${threadId}'.`,
        );
      }
    }

    const artifactIds = new Set<ArtifactId>();
    let logsScanned = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      const threadId = entry.name.slice(0, -".jsonl".length);
      if (!entry.isFile() || !LOCAL_THREAD_ID.test(threadId)) {
        throw unsafeScan(`Unsafe thread log path '${entry.name}'.`);
      }
      const eventLogPath = join(threadRoot, entry.name);
      try {
        const readResult = await new JsonlEventStore(eventLogPath).readAll();
        if (readResult.diagnostics.length > 0) {
          throw unsafeScan(
            `Thread log '${entry.name}' has an incomplete trailing event.`,
          );
        }
        for (const event of readResult.events) {
          if (event.threadId !== threadId) {
            throw unsafeScan(
              `Thread log '${entry.name}' contains events for '${event.threadId}'.`,
            );
          }
          if (event.type === "artifact.recorded") {
            artifactIds.add(event.payload.artifact.id);
          } else if (
            event.type === "item.recorded" &&
            event.payload.item.type === "tool_result" &&
            event.payload.item.output !== undefined
          ) {
            for (const reference of collectArtifactReferences(
              event.payload.item.output,
            )) {
              artifactIds.add(reference.id);
            }
          }
        }
      } catch (error) {
        if (error instanceof ArtifactGarbageCollectionError) {
          throw error;
        }
        throw unsafeScan(
          `Thread log '${entry.name}' could not be validated: ${errorMessage(error)}`,
          error,
        );
      }
      logsScanned += 1;
    }
    return { artifactIds, logsScanned };
  }

  private async scanArtifacts(
    reachable: ReadonlySet<ArtifactId>,
    minimumAgeMs: number,
    now: number,
  ): Promise<{
    artifactsScanned: number;
    candidates: ArtifactGarbageCollectionCandidate[];
    diagnostics: ArtifactGarbageCollectionDiagnostic[];
  }> {
    const digestRoot = join(this.artifactRoot, "sha256");
    const prefixEntries = await readDirectory(digestRoot);
    const candidates: ArtifactGarbageCollectionCandidate[] = [];
    const diagnostics: ArtifactGarbageCollectionDiagnostic[] = [];
    let artifactsScanned = 0;

    for (const prefixEntry of prefixEntries) {
      const prefixPath = join(digestRoot, prefixEntry.name);
      if (!prefixEntry.isDirectory() || !SHA256_PREFIX.test(prefixEntry.name)) {
        diagnostics.push({
          path: prefixPath,
          message: "Retained unexpected artifact-store entry.",
        });
        continue;
      }
      const hashEntries = await readDirectory(prefixPath);
      for (const hashEntry of hashEntries) {
        const path = join(prefixPath, hashEntry.name);
        if (
          !hashEntry.isFile() ||
          !SHA256.test(hashEntry.name) ||
          !hashEntry.name.startsWith(prefixEntry.name)
        ) {
          diagnostics.push({
            path,
            message: "Retained unexpected artifact-store entry.",
          });
          continue;
        }
        const fileStats = await lstat(path);
        if (!fileStats.isFile()) {
          diagnostics.push({
            path,
            message: "Retained non-regular artifact-store entry.",
          });
          continue;
        }
        artifactsScanned += 1;
        const id = `sha256:${hashEntry.name}` as ArtifactId;
        if (!reachable.has(id) && now - fileStats.mtimeMs >= minimumAgeMs) {
          candidates.push({
            id,
            path,
            bytes: fileStats.size,
            modifiedAt: fileStats.mtime.toISOString(),
          });
        }
      }
    }

    candidates.sort((left, right) => left.id.localeCompare(right.id));
    diagnostics.sort((left, right) => left.path.localeCompare(right.path));
    return { artifactsScanned, candidates, diagnostics };
  }
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function readMaintenanceLease(
  path: string,
): Promise<MaintenanceLeaseRecord | undefined> {
  const content = await readOptionalFile(path);
  return content === undefined ? undefined : parseMaintenanceLease(content);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function parseMaintenanceLease(
  content: string,
): MaintenanceLeaseRecord | undefined {
  try {
    const value = JSON.parse(content) as Partial<MaintenanceLeaseRecord>;
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

function unsafeScan(
  message: string,
  cause?: unknown,
): ArtifactGarbageCollectionError {
  return new ArtifactGarbageCollectionError(
    "ARTIFACT_GC_UNSAFE_SCAN",
    message,
    cause === undefined ? undefined : { cause },
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
