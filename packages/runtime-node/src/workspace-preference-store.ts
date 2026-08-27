import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  modelProviderIdSchema,
  runtimeSettingsModelSchema,
  type ModelProviderId,
  type RuntimePreference,
  type RuntimeSettingsDiagnostic,
  type RuntimeSettingsRecovery,
} from "@koda/protocol";
import { z } from "zod";

export type WorkspacePreferenceStoreErrorCode =
  | "INVALID_RUNTIME_SETTINGS"
  | "SETTINGS_BUSY"
  | "SETTINGS_CHANGED"
  | "SETTINGS_CORRUPT";

export class WorkspacePreferenceStoreError extends Error {
  public constructor(
    public readonly code: WorkspacePreferenceStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspacePreferenceStoreError";
  }
}

export interface WorkspacePreferenceReadResult {
  workspace: string;
  revision: number;
  preference?: RuntimePreference;
  diagnostics: RuntimeSettingsDiagnostic[];
  recovery?: RuntimeSettingsRecovery;
}

export interface WorkspacePreferenceUpdateInput {
  workspace: string;
  provider: ModelProviderId;
  model: string;
  expectedRevision: number;
}

export interface WorkspacePreferenceUpdateResult extends WorkspacePreferenceReadResult {
  preference: RuntimePreference;
}

export interface WorkspacePreferenceStoreOptions {
  now?: () => string;
  token?: () => string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface PreferenceFile extends RuntimePreference {
  version: 1;
  workspace: string;
  revision: number;
}

interface PreferenceLeaseRecord {
  pid: number;
  createdAt: string;
  token: string;
}

const PREFERENCE_FILE_VERSION = 1;
const MAXIMUM_PREFERENCE_FILE_BYTES = 16 * 1_024;
const MAXIMUM_DIAGNOSTIC_BYTES = 1_024;

const preferenceFileSchema = z
  .object({
    version: z.literal(PREFERENCE_FILE_VERSION),
    workspace: z.string().min(1),
    provider: modelProviderIdSchema,
    model: runtimeSettingsModelSchema,
    revision: z.number().int().safe().positive(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export class WorkspacePreferenceStore {
  private constructor(
    public readonly root: string,
    private readonly options: WorkspacePreferenceStoreOptions,
  ) {}

  public static async open(
    kodaHome: string,
    options: WorkspacePreferenceStoreOptions = {},
  ): Promise<WorkspacePreferenceStore> {
    const root = join(resolve(kodaHome), "settings", "workspaces");
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await chmod(root, 0o700);
    } catch (error) {
      if (!isNodeError(error, "ENOSYS") && !isNodeError(error, "EPERM")) {
        throw error;
      }
    }
    return new WorkspacePreferenceStore(root, options);
  }

  public async get(workspace: string): Promise<WorkspacePreferenceReadResult> {
    assertWorkspace(workspace);
    return this.read(workspace, this.pathForWorkspace(workspace));
  }

  public async update(
    input: WorkspacePreferenceUpdateInput,
  ): Promise<WorkspacePreferenceUpdateResult> {
    assertWorkspace(input.workspace);
    const provider = modelProviderIdSchema.parse(input.provider);
    const model = runtimeSettingsModelSchema.parse(input.model);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw new WorkspacePreferenceStoreError(
        "INVALID_RUNTIME_SETTINGS",
        "Runtime settings revision must be a non-negative safe integer.",
      );
    }
    const path = this.pathForWorkspace(input.workspace);
    const lease = await PreferenceLease.acquire(path, this.options);
    try {
      const current = await this.read(input.workspace, path);
      if (
        current.recovery !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw new WorkspacePreferenceStoreError(
          "SETTINGS_CORRUPT",
          "Runtime settings changed after a corrupt preference was recovered; reload them before applying the draft.",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new WorkspacePreferenceStoreError(
          "SETTINGS_CHANGED",
          "Runtime settings changed in another client; reload them before applying the draft.",
        );
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspacePreferenceStoreError(
          "INVALID_RUNTIME_SETTINGS",
          "Runtime settings revision is exhausted.",
        );
      }
      const updatedAt = this.now();
      const file = preferenceFileSchema.parse({
        version: PREFERENCE_FILE_VERSION,
        workspace: input.workspace,
        provider,
        model,
        revision: current.revision + 1,
        updatedAt,
      });
      await writePreferenceFile(path, file, this.options.token ?? randomUUID);
      return {
        workspace: file.workspace,
        revision: file.revision,
        preference: { provider, model, updatedAt },
        diagnostics: current.diagnostics,
        ...(current.recovery === undefined
          ? {}
          : { recovery: current.recovery }),
      };
    } finally {
      await lease.release();
    }
  }

  public pathForWorkspace(workspace: string): string {
    assertWorkspace(workspace);
    return join(this.root, `${workspaceDigest(workspace)}.json`);
  }

  private async read(
    workspace: string,
    path: string,
  ): Promise<WorkspacePreferenceReadResult> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { workspace, revision: 0, diagnostics: [] };
      }
      throw error;
    }
    try {
      if (!stats.isFile()) {
        throw new Error("Preference path is not a regular file.");
      }
      if (stats.size > MAXIMUM_PREFERENCE_FILE_BYTES) {
        throw new Error(
          `Preference file exceeds the ${MAXIMUM_PREFERENCE_FILE_BYTES}-byte limit.`,
        );
      }
      const content = await readFile(path, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAXIMUM_PREFERENCE_FILE_BYTES) {
        throw new Error(
          `Preference file exceeds the ${MAXIMUM_PREFERENCE_FILE_BYTES}-byte limit.`,
        );
      }
      const file = preferenceFileSchema.parse(JSON.parse(content));
      if (
        file.workspace !== workspace ||
        basename(path) !== `${workspaceDigest(file.workspace)}.json`
      ) {
        throw new Error(
          "Preference file does not match its canonical workspace.",
        );
      }
      return {
        workspace,
        revision: file.revision,
        preference: {
          provider: file.provider,
          model: file.model,
          updatedAt: file.updatedAt,
        },
        diagnostics: [],
      };
    } catch (error) {
      return this.quarantine(path, workspace, error);
    }
  }

  private async quarantine(
    path: string,
    workspace: string,
    error: unknown,
  ): Promise<WorkspacePreferenceReadResult> {
    const backup = `${path}.corrupt-${safeTimestamp(this.now())}-${(
      this.options.token ?? randomUUID
    )()}`;
    try {
      await rename(path, backup);
    } catch (renameError) {
      if (isNodeError(renameError, "ENOENT")) {
        return this.read(workspace, path);
      }
      throw new WorkspacePreferenceStoreError(
        "SETTINGS_CORRUPT",
        "Runtime settings are corrupt and could not be quarantined.",
        { cause: renameError },
      );
    }
    return {
      workspace,
      revision: 0,
      diagnostics: [
        {
          code: "SETTINGS_CORRUPT",
          message: boundDiagnostic(
            `Recovered an invalid workspace preference: ${errorMessage(error)}`,
          ),
        },
      ],
      recovery: { preferenceBackup: backup },
    };
  }

  private now(): string {
    const value = (this.options.now ?? (() => new Date().toISOString()))();
    if (Number.isNaN(Date.parse(value))) {
      throw new WorkspacePreferenceStoreError(
        "INVALID_RUNTIME_SETTINGS",
        "Runtime settings clock returned an invalid timestamp.",
      );
    }
    return value;
  }
}

class PreferenceLease {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly record: PreferenceLeaseRecord,
  ) {}

  public static async acquire(
    preferencePath: string,
    options: WorkspacePreferenceStoreOptions,
  ): Promise<PreferenceLease> {
    const path = `${preferencePath}.lock`;
    const record: PreferenceLeaseRecord = {
      pid: options.pid ?? process.pid,
      createdAt: (options.now ?? (() => new Date().toISOString()))(),
      token: (options.token ?? randomUUID)(),
    };
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new PreferenceLease(path, record);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        const existing = await readLease(path);
        if (existing === undefined || isAlive(existing.pid)) {
          throw new WorkspacePreferenceStoreError(
            "SETTINGS_BUSY",
            `Runtime settings are being updated by process ${existing?.pid ?? "unknown"}.`,
          );
        }
        await rm(path, { force: true });
      }
    }
    throw new WorkspacePreferenceStoreError(
      "SETTINGS_BUSY",
      "Runtime settings lease could not be acquired after stale-owner recovery.",
    );
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

async function readLease(
  path: string,
): Promise<PreferenceLeaseRecord | undefined> {
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
    const value = JSON.parse(content) as Partial<PreferenceLeaseRecord>;
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

async function writePreferenceFile(
  path: string,
  file: PreferenceFile,
  token: () => string,
): Promise<void> {
  const content = `${JSON.stringify(file)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAXIMUM_PREFERENCE_FILE_BYTES) {
    throw new WorkspacePreferenceStoreError(
      "INVALID_RUNTIME_SETTINGS",
      `Runtime settings exceed the ${MAXIMUM_PREFERENCE_FILE_BYTES}-byte file limit.`,
    );
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${token()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on platforms and filesystems that reject it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertWorkspace(workspace: string): void {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new WorkspacePreferenceStoreError(
      "INVALID_RUNTIME_SETTINGS",
      "Canonical workspace must be a non-empty string.",
    );
  }
}

function workspaceDigest(workspace: string): string {
  return createHash("sha256").update(workspace, "utf8").digest("hex");
}

function safeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/gu, "-");
}

function boundDiagnostic(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAXIMUM_DIAGNOSTIC_BYTES) {
    return message;
  }
  let result = message;
  while (
    result.length > 0 &&
    Buffer.byteLength(`${result}…`, "utf8") > MAXIMUM_DIAGNOSTIC_BYTES
  ) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
