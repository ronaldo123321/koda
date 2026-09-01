import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import { sourceCommitSchema } from "./release.js";
import {
  MACOS_PREVIEW_ACTIVATION_SCHEMA_VERSION,
  MACOS_PREVIEW_STATE_SCHEMA_VERSION,
} from "./version.js";

const PREVIEW_IDENTITY_COMMIT_LENGTH = 12;
const PREVIEW_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PREVIEW_IDENTITY_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\+[0-9a-f]{12}$/;
const MAXIMUM_PREVIEW_DOCUMENT_BYTES = 1_048_576;

export const KODA_PREVIEW_ERROR_CODES = [
  "KODA_PREVIEW_PATH_INVALID",
  "KODA_PREVIEW_STATE_INVALID",
  "KODA_PREVIEW_RECOVERY_CONFLICT",
  "KODA_PREVIEW_OPERATION_LOCKED",
] as const;

export type KodaPreviewErrorCode = (typeof KODA_PREVIEW_ERROR_CODES)[number];

const PREVIEW_ERROR_MESSAGES: Readonly<Record<KodaPreviewErrorCode, string>> = {
  KODA_PREVIEW_PATH_INVALID:
    "The Koda preview path is invalid or escapes its managed root.",
  KODA_PREVIEW_STATE_INVALID: "The Koda preview installation state is invalid.",
  KODA_PREVIEW_RECOVERY_CONFLICT:
    "The interrupted Koda preview activation cannot be recovered safely.",
  KODA_PREVIEW_OPERATION_LOCKED:
    "Another Koda preview installation operation is active.",
};

export class KodaPreviewError extends Error {
  public constructor(
    public readonly code: KodaPreviewErrorCode,
    options?: ErrorOptions,
  ) {
    super(PREVIEW_ERROR_MESSAGES[code], options);
    this.name = "KodaPreviewError";
  }
}

const previewVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PREVIEW_VERSION_PATTERN);
const previewIdentitySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(PREVIEW_IDENTITY_PATTERN);
const previewRelativeVersionPathSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^versions\/[0-9A-Za-z.+-]+$/);

export const macOSPreviewTargetSchema = z
  .object({
    identity: previewIdentitySchema,
    version: previewVersionSchema,
    source_commit: sourceCommitSchema,
    arch: z.enum(["arm64", "x64"]),
    relative_path: previewRelativeVersionPathSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedIdentity = previewIdentity(
      value.version,
      value.source_commit,
    );
    if (value.identity !== expectedIdentity) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "Preview identity does not match version and source commit.",
      });
    }
    if (value.relative_path !== `versions/${value.identity}`) {
      context.addIssue({
        code: "custom",
        path: ["relative_path"],
        message: "Preview path does not match its identity.",
      });
    }
  });

export const macOSPreviewStateSchema = z
  .object({
    schema_version: z.literal(MACOS_PREVIEW_STATE_SCHEMA_VERSION),
    active: macOSPreviewTargetSchema.nullable(),
    previous: macOSPreviewTargetSchema.nullable(),
    installed: z.array(macOSPreviewTargetSchema).max(1_000),
    updated_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    let previousIdentity: string | undefined;
    for (let index = 0; index < value.installed.length; index += 1) {
      const identity = value.installed[index]!.identity;
      if (previousIdentity !== undefined && identity <= previousIdentity) {
        context.addIssue({
          code: "custom",
          path: ["installed", index, "identity"],
          message: "Installed preview identities must be unique and sorted.",
        });
      }
      previousIdentity = identity;
    }
    const installed = new Set(value.installed.map((target) => target.identity));
    for (const [field, target] of [
      ["active", value.active],
      ["previous", value.previous],
    ] as const) {
      if (target !== null && !installed.has(target.identity)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Active preview targets must be present in the index.",
        });
      }
    }
    if (
      value.active !== null &&
      value.previous !== null &&
      value.active.identity === value.previous.identity
    ) {
      context.addIssue({
        code: "custom",
        path: ["previous"],
        message: "Active and previous previews must differ.",
      });
    }
    if (value.active === null && value.previous !== null) {
      context.addIssue({
        code: "custom",
        path: ["previous"],
        message: "A previous preview requires an active preview.",
      });
    }
  });

export const macOSPreviewActivationJournalSchema = z
  .object({
    schema_version: z.literal(MACOS_PREVIEW_ACTIVATION_SCHEMA_VERSION),
    operation_id: z.string().uuid(),
    operation: z.enum(["install", "rollback"]),
    before: macOSPreviewTargetSchema.nullable(),
    before_previous: macOSPreviewTargetSchema.nullable(),
    after: macOSPreviewTargetSchema,
    created_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.before?.identity === value.after.identity) {
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "Activation must change the active preview identity.",
      });
    }
    if (
      value.operation === "rollback" &&
      value.before_previous?.identity !== value.after.identity
    ) {
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "Rollback must activate the exact previous preview.",
      });
    }
  });

const macOSPreviewLockOwnerSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: z.string().uuid(),
    operation: z.enum(["install", "rollback", "uninstall"]),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    created_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type MacOSPreviewTarget = z.infer<typeof macOSPreviewTargetSchema>;
export type MacOSPreviewState = z.infer<typeof macOSPreviewStateSchema>;
export type MacOSPreviewActivationJournal = z.infer<
  typeof macOSPreviewActivationJournalSchema
>;

export interface MacOSPreviewPaths {
  readonly root: string;
  readonly versions: string;
  readonly transactions: string;
  readonly currentLink: string;
  readonly previousLink: string;
  readonly state: string;
  readonly activationJournal: string;
  readonly operationLock: string;
  readonly binDirectory: string;
  readonly kodaLauncher: string;
  readonly chatLauncher: string;
}

export interface MacOSPreviewOperationLockOptions {
  readonly pid?: number;
  readonly now?: () => number;
  readonly operationId?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class MacOSPreviewOperationLock {
  private released = false;

  private constructor(
    public readonly path: string,
    private readonly owner: z.infer<typeof macOSPreviewLockOwnerSchema>,
  ) {}

  public static async acquire(
    paths: MacOSPreviewPaths,
    operation: "install" | "rollback" | "uninstall",
    options: MacOSPreviewOperationLockOptions = {},
  ): Promise<MacOSPreviewOperationLock> {
    const operationId = options.operationId ?? randomUUID;
    const owner = macOSPreviewLockOwnerSchema.parse({
      schema_version: 1,
      operation_id: operationId(),
      operation,
      pid: options.pid ?? process.pid,
      created_at_ms: (options.now ?? Date.now)(),
    });
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    await mkdir(paths.root, { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(paths.operationLock, { mode: 0o700 });
        try {
          await writeNewFile(
            join(paths.operationLock, "owner.json"),
            `${JSON.stringify(owner)}\n`,
            0o600,
          );
          await syncDirectory(paths.operationLock);
          await syncDirectory(paths.root);
          return new MacOSPreviewOperationLock(paths.operationLock, owner);
        } catch (error) {
          await rm(paths.operationLock, { recursive: true, force: true }).catch(
            () => undefined,
          );
          throw error;
        }
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        const existing = await readMacOSPreviewLockOwner(paths.operationLock);
        if (existing === null || isAlive(existing.pid)) {
          throw new KodaPreviewError("KODA_PREVIEW_OPERATION_LOCKED", {
            cause: error,
          });
        }
        const stalePath = managedChild(
          paths.root,
          `.operation.lock.stale-${operationId()}`,
        );
        try {
          await rename(paths.operationLock, stalePath);
        } catch (renameError) {
          if (isNodeError(renameError, "ENOENT")) {
            continue;
          }
          throw new KodaPreviewError("KODA_PREVIEW_OPERATION_LOCKED", {
            cause: renameError,
          });
        }
        await rm(stalePath, { recursive: true, force: true });
        await syncDirectory(paths.root);
      }
    }
    throw new KodaPreviewError("KODA_PREVIEW_OPERATION_LOCKED");
  }

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    const existing = await readMacOSPreviewLockOwner(this.path);
    if (existing?.operation_id !== this.owner.operation_id) {
      return;
    }
    await rm(this.path, { recursive: true, force: true });
    await syncDirectory(dirname(this.path));
  }
}

export type MacOSPreviewRecoveryDecision =
  | { readonly action: "rollback"; readonly target: MacOSPreviewTarget | null }
  | {
      readonly action: "complete";
      readonly active: MacOSPreviewTarget;
      readonly previous: MacOSPreviewTarget | null;
    }
  | { readonly action: "conflict" };

export type MacOSPreviewRecoveryResult =
  | { readonly action: "none" }
  | { readonly action: "rolled_back"; readonly state: MacOSPreviewState }
  | { readonly action: "completed"; readonly state: MacOSPreviewState };

export function previewIdentity(version: string, sourceCommit: string): string {
  const parsedVersion = previewVersionSchema.parse(version);
  const parsedCommit = sourceCommitSchema.parse(sourceCommit);
  return `${parsedVersion}+${parsedCommit.slice(0, PREVIEW_IDENTITY_COMMIT_LENGTH)}`;
}

export function createMacOSPreviewTarget(input: {
  version: string;
  sourceCommit: string;
  arch: "arm64" | "x64";
}): MacOSPreviewTarget {
  const identity = previewIdentity(input.version, input.sourceCommit);
  return macOSPreviewTargetSchema.parse({
    identity,
    version: input.version,
    source_commit: input.sourceCommit,
    arch: input.arch,
    relative_path: `versions/${identity}`,
  });
}

export function canonicalMacOSPreviewState(value: unknown): string {
  return JSON.stringify(macOSPreviewStateSchema.parse(value));
}

export function canonicalMacOSPreviewActivationJournal(value: unknown): string {
  return JSON.stringify(macOSPreviewActivationJournalSchema.parse(value));
}

export function createMacOSPreviewState(input: {
  active: MacOSPreviewTarget | null;
  previous: MacOSPreviewTarget | null;
  installed: readonly MacOSPreviewTarget[];
  updatedAtMs: number;
}): MacOSPreviewState {
  const installed = new Map<string, MacOSPreviewTarget>();
  for (const target of input.installed) {
    const parsed = macOSPreviewTargetSchema.parse(target);
    const existing = installed.get(parsed.identity);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(parsed)
    ) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    installed.set(parsed.identity, parsed);
  }
  return macOSPreviewStateSchema.parse({
    schema_version: MACOS_PREVIEW_STATE_SCHEMA_VERSION,
    active: input.active,
    previous: input.previous,
    installed: [...installed.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
    updated_at_ms: input.updatedAtMs,
  });
}

export function resolveMacOSPreviewPaths(input: {
  homeDirectory: string;
  previewRoot?: string;
  binDirectory?: string;
}): MacOSPreviewPaths {
  const homeDirectory = absoluteManagedRoot(input.homeDirectory);
  const root = absoluteManagedRoot(
    input.previewRoot ?? join(homeDirectory, ".local", "share", "koda-preview"),
  );
  const binDirectory = absoluteManagedRoot(
    input.binDirectory ?? join(homeDirectory, ".local", "bin"),
  );
  if (root === binDirectory || isManagedPath(root, binDirectory)) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
  return {
    root,
    versions: managedChild(root, "versions"),
    transactions: managedChild(root, "transactions"),
    currentLink: managedChild(root, "current"),
    previousLink: managedChild(root, "previous"),
    state: managedChild(root, "state.json"),
    activationJournal: managedChild(
      root,
      join("transactions", "activation.json"),
    ),
    operationLock: managedChild(root, "operation.lock"),
    binDirectory,
    kodaLauncher: managedChild(binDirectory, "koda"),
    chatLauncher: managedChild(binDirectory, "koda-chat"),
  };
}

export async function readMacOSPreviewState(
  paths: MacOSPreviewPaths,
): Promise<MacOSPreviewState | null> {
  return readPreviewDocument(paths.state, macOSPreviewStateSchema);
}

export async function writeMacOSPreviewState(
  paths: MacOSPreviewPaths,
  value: MacOSPreviewState,
  token: () => string = randomUUID,
): Promise<void> {
  const state = macOSPreviewStateSchema.parse(value);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeAtomicFile(
    paths.state,
    `${canonicalMacOSPreviewState(state)}\n`,
    token,
  );
}

export async function readMacOSPreviewActivationJournal(
  paths: MacOSPreviewPaths,
): Promise<MacOSPreviewActivationJournal | null> {
  return readPreviewDocument(
    paths.activationJournal,
    macOSPreviewActivationJournalSchema,
  );
}

export async function writeMacOSPreviewActivationJournal(
  paths: MacOSPreviewPaths,
  value: MacOSPreviewActivationJournal,
  token: () => string = randomUUID,
): Promise<void> {
  const journal = macOSPreviewActivationJournalSchema.parse(value);
  await mkdir(paths.transactions, { recursive: true, mode: 0o700 });
  await writeAtomicFile(
    paths.activationJournal,
    `${canonicalMacOSPreviewActivationJournal(journal)}\n`,
    token,
  );
}

export async function removeMacOSPreviewActivationJournal(
  paths: MacOSPreviewPaths,
): Promise<void> {
  await rm(paths.activationJournal, { force: true });
  await syncDirectory(paths.transactions);
}

export async function readMacOSPreviewLink(
  paths: MacOSPreviewPaths,
  kind: "current" | "previous",
): Promise<string | null> {
  const path = kind === "current" ? paths.currentLink : paths.previousLink;
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink()) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    return parseMacOSPreviewLinkTarget(await readlink(path));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    if (error instanceof KodaPreviewError) {
      throw error;
    }
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID", {
      cause: error,
    });
  }
}

export async function replaceMacOSPreviewLink(
  paths: MacOSPreviewPaths,
  kind: "current" | "previous",
  target: MacOSPreviewTarget | null,
  token: () => string = randomUUID,
): Promise<void> {
  const path = kind === "current" ? paths.currentLink : paths.previousLink;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  if (target === null) {
    await rm(path, { force: true });
    await syncDirectory(paths.root);
    return;
  }
  const parsed = macOSPreviewTargetSchema.parse(target);
  const temporaryPath = managedChild(
    paths.root,
    `.${basename(path)}.${token()}.tmp`,
  );
  try {
    await symlink(parsed.relative_path, temporaryPath);
    await rename(temporaryPath, path);
    await syncDirectory(paths.root);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function recoverMacOSPreviewActivation(
  paths: MacOSPreviewPaths,
  options: {
    readonly now?: () => number;
    readonly token?: () => string;
  } = {},
): Promise<MacOSPreviewRecoveryResult> {
  const journal = await readMacOSPreviewActivationJournal(paths);
  if (journal === null) {
    return { action: "none" };
  }
  const decision = classifyMacOSPreviewRecovery({
    journal,
    currentTarget: await readMacOSPreviewLink(paths, "current"),
  });
  if (decision.action === "conflict") {
    throw new KodaPreviewError("KODA_PREVIEW_RECOVERY_CONFLICT");
  }
  const existing = await readMacOSPreviewState(paths);
  const installed = [
    ...(existing?.installed ?? []),
    journal.after,
    ...(journal.before === null ? [] : [journal.before]),
    ...(journal.before_previous === null ? [] : [journal.before_previous]),
  ];
  const now = (options.now ?? Date.now)();
  const token = options.token ?? randomUUID;
  if (decision.action === "rollback") {
    await replaceMacOSPreviewLink(
      paths,
      "previous",
      journal.before_previous,
      token,
    );
    await replaceMacOSPreviewLink(paths, "current", journal.before, token);
    const state = createMacOSPreviewState({
      active: journal.before,
      previous: journal.before === null ? null : journal.before_previous,
      installed,
      updatedAtMs: now,
    });
    await writeMacOSPreviewState(paths, state, token);
    await removeMacOSPreviewActivationJournal(paths);
    return { action: "rolled_back", state };
  }
  await replaceMacOSPreviewLink(paths, "previous", journal.before, token);
  await replaceMacOSPreviewLink(paths, "current", journal.after, token);
  const state = createMacOSPreviewState({
    active: journal.after,
    previous: journal.before,
    installed,
    updatedAtMs: now,
  });
  await writeMacOSPreviewState(paths, state, token);
  await removeMacOSPreviewActivationJournal(paths);
  return { action: "completed", state };
}

export function resolveMacOSPreviewTargetPath(
  paths: MacOSPreviewPaths,
  target: MacOSPreviewTarget,
): string {
  const parsed = macOSPreviewTargetSchema.parse(target);
  return managedChild(paths.root, parsed.relative_path);
}

export function parseMacOSPreviewLinkTarget(
  value: string | null,
): string | null {
  if (value === null) {
    return null;
  }
  return previewRelativeVersionPathSchema.parse(value);
}

export function classifyMacOSPreviewRecovery(input: {
  journal: MacOSPreviewActivationJournal;
  currentTarget: string | null;
}): MacOSPreviewRecoveryDecision {
  const journal = macOSPreviewActivationJournalSchema.parse(input.journal);
  const currentTarget = parseMacOSPreviewLinkTarget(input.currentTarget);
  const beforeTarget = journal.before?.relative_path ?? null;
  if (currentTarget === beforeTarget) {
    return { action: "rollback", target: journal.before };
  }
  if (currentTarget === journal.after.relative_path) {
    return {
      action: "complete",
      active: journal.after,
      previous: journal.before,
    };
  }
  return { action: "conflict" };
}

export function isManagedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function absoluteManagedRoot(value: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\u0000") ||
    resolve(value) !== value ||
    value === sep
  ) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
  return value;
}

function managedChild(root: string, child: string): string {
  const candidate = resolve(root, child);
  if (!isManagedPath(root, candidate)) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
  return candidate;
}

async function readMacOSPreviewLockOwner(
  lockPath: string,
): Promise<z.infer<typeof macOSPreviewLockOwnerSchema> | null> {
  return readPreviewDocument(
    join(lockPath, "owner.json"),
    macOSPreviewLockOwnerSchema,
  );
}

async function readPreviewDocument<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAXIMUM_PREVIEW_DOCUMENT_BYTES
    ) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    if (error instanceof KodaPreviewError) {
      throw error;
    }
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID", {
      cause: error,
    });
  }
}

async function writeAtomicFile(
  path: string,
  content: string,
  token: () => string,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${token()}.tmp`,
  );
  try {
    await writeNewFile(temporaryPath, content, 0o600);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeNewFile(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on filesystems that reject it.
  } finally {
    await handle?.close().catch(() => undefined);
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
