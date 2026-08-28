import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
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

const JOURNAL_SCHEMA_VERSION = 1;
const MAXIMUM_CHANGES = 16;
const MAXIMUM_FILE_BYTES = 1_000_000;
const MAXIMUM_TOTAL_BACKUP_BYTES = 8_000_000;
const MAXIMUM_PATH_BYTES = 4_096;
const MAXIMUM_IDENTITY_BYTES = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentitySchema = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAXIMUM_IDENTITY_BYTES,
    `Identity must not exceed ${MAXIMUM_IDENTITY_BYTES} UTF-8 bytes.`,
  );
const boundedPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAXIMUM_PATH_BYTES,
    `Path must not exceed ${MAXIMUM_PATH_BYTES} UTF-8 bytes.`,
  );

function isExpectedStagedPath(
  targetPath: string,
  stagedPath: string | undefined,
): boolean {
  if (stagedPath === undefined) {
    return false;
  }
  const separator = targetPath.lastIndexOf("/");
  const directory = separator < 0 ? "" : targetPath.slice(0, separator + 1);
  const filename = targetPath.slice(separator + 1);
  const prefix = `${directory}.${filename}.koda-change-`;
  if (!stagedPath.startsWith(prefix) || !stagedPath.endsWith(".tmp")) {
    return false;
  }
  const token = stagedPath.slice(prefix.length, -4);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    token,
  );
}

const journalOperationSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CHANGES - 1),
    operation: z.enum(["create", "update", "move", "delete"]),
    path: boundedPathSchema,
    destination: boundedPathSchema.optional(),
    beforeSha256: sha256Schema.nullable(),
    afterSha256: sha256Schema.nullable(),
    bytes: z.number().int().nonnegative().max(MAXIMUM_FILE_BYTES),
    beforeMode: z.number().int().min(0).max(0o777).nullable(),
    afterMode: z.number().int().min(0).max(0o777).nullable(),
    backup: z
      .string()
      .regex(/^backups\/[0-9]+\.before$/u)
      .optional(),
    staged: boundedPathSchema.optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    const hasBefore = operation.beforeSha256 !== null;
    const hasAfter = operation.afterSha256 !== null;
    const valid =
      (operation.operation === "create" &&
        !hasBefore &&
        hasAfter &&
        operation.destination === undefined &&
        operation.beforeMode === null &&
        operation.afterMode !== null &&
        operation.backup === undefined &&
        isExpectedStagedPath(operation.path, operation.staged)) ||
      (operation.operation === "update" &&
        hasBefore &&
        hasAfter &&
        operation.destination === undefined &&
        operation.beforeMode !== null &&
        operation.afterMode === operation.beforeMode &&
        operation.backup === `backups/${operation.index}.before` &&
        isExpectedStagedPath(operation.path, operation.staged)) ||
      (operation.operation === "move" &&
        hasBefore &&
        operation.beforeSha256 === operation.afterSha256 &&
        operation.destination !== undefined &&
        operation.beforeMode !== null &&
        operation.afterMode === operation.beforeMode &&
        operation.backup === `backups/${operation.index}.before` &&
        operation.staged === undefined) ||
      (operation.operation === "delete" &&
        hasBefore &&
        !hasAfter &&
        operation.destination === undefined &&
        operation.beforeMode !== null &&
        operation.afterMode === null &&
        operation.backup === `backups/${operation.index}.before` &&
        operation.staged === undefined);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Journal operation does not match its operation semantics.",
      });
    }
  });

const mutationJournalManifestSchema = z
  .object({
    schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
    workspaceRoot: z.string().min(1),
    workspaceSha256: sha256Schema,
    threadId: boundedIdentitySchema,
    turnId: boundedIdentitySchema,
    callId: boundedIdentitySchema,
    toolName: boundedIdentitySchema,
    planSha256: sha256Schema,
    createdAt: z.string().datetime({ offset: true }),
    changes: z.array(journalOperationSchema).min(1).max(MAXIMUM_CHANGES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const endpoints = new Set<string>();
    for (const [index, change] of manifest.changes.entries()) {
      if (change.index !== index) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "index"],
          message: "Journal operation indexes must be contiguous and ordered.",
        });
      }
      for (const endpoint of [change.path, change.destination]) {
        if (endpoint === undefined) {
          continue;
        }
        if (endpoints.has(endpoint)) {
          context.addIssue({
            code: "custom",
            path: ["changes", index],
            message: "Journal operation endpoints must not overlap.",
          });
        }
        endpoints.add(endpoint);
      }
    }
  });

const mutationJournalStateSchema = z
  .object({
    schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
    status: z.enum(["active", "committed", "rolled_back", "conflicted"]),
    updatedAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(256).optional(),
    paths: z
      .array(boundedPathSchema)
      .max(MAXIMUM_CHANGES * 3)
      .optional(),
  })
  .strict();

export type WorkspaceMutationJournalErrorCode =
  "WORKSPACE_MUTATION_JOURNAL_CORRUPT" | "WORKSPACE_MUTATION_RECOVERY_CONFLICT";

export class WorkspaceMutationJournalError extends Error {
  public constructor(
    public readonly code: WorkspaceMutationJournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMutationJournalError";
  }
}

export interface WorkspaceMutationJournalIdentity {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
}

export interface WorkspaceMutationJournalChange {
  index: number;
  operation: "create" | "update" | "move" | "delete";
  path: string;
  destination?: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  bytes: number;
  beforeMode: number | null;
  afterMode: number | null;
  beforeBytes?: Buffer;
  stagedPath?: string;
}

export interface WorkspaceMutationJournalPlan {
  identity: WorkspaceMutationJournalIdentity;
  planSha256: string;
  changes: readonly WorkspaceMutationJournalChange[];
}

export type WorkspaceMutationRecoveryStatus =
  "not_started" | "committed" | "rolled_back" | "conflicted";

export interface WorkspaceMutationRecoveryResult {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
  planSha256: string;
  status: WorkspaceMutationRecoveryStatus;
  paths: string[];
  primaryPaths: string[];
  changeCount: number;
  appliedCount: number;
  restoredPaths: string[];
  journalDirectory: string;
}

export interface WorkspaceMutationRecoveryOptions {
  retainRecovered?: boolean;
}

type MutationJournalManifest = z.infer<typeof mutationJournalManifestSchema>;
type MutationJournalOperation = z.infer<typeof journalOperationSchema>;

type ObservedFileState =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; mode: number }
  | { kind: "divergent" };

type OperationState = "before" | "after" | "intermediate" | "divergent";

export interface WorkspaceMutationJournalStoreOptions {
  now?: () => string;
  token?: () => string;
}

export class WorkspaceMutationJournalStore {
  public readonly workspaceDirectory: string;

  private constructor(
    public readonly workspaceRoot: string,
    private readonly options: Required<WorkspaceMutationJournalStoreOptions>,
    workspaceDirectory: string,
  ) {
    this.workspaceDirectory = workspaceDirectory;
  }

  public static async open(
    kodaHome: string,
    workspaceRoot: string,
    options: WorkspaceMutationJournalStoreOptions = {},
  ): Promise<WorkspaceMutationJournalStore> {
    const canonicalRoot = await realpath(resolve(workspaceRoot));
    const workspaceSha256 = hashText(canonicalRoot);
    const workspaceDirectory = join(
      resolve(kodaHome),
      "workspace-mutations",
      workspaceSha256,
    );
    await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
    return new WorkspaceMutationJournalStore(
      canonicalRoot,
      {
        now: options.now ?? (() => new Date().toISOString()),
        token: options.token ?? randomUUID,
      },
      workspaceDirectory,
    );
  }

  public async begin(
    plan: WorkspaceMutationJournalPlan,
  ): Promise<WorkspaceMutationJournalTransaction> {
    const threadDirectory = join(
      this.workspaceDirectory,
      hashText(plan.identity.threadId),
    );
    const transactionDirectory = join(
      threadDirectory,
      hashText(plan.identity.callId),
    );
    await mkdir(threadDirectory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(transactionDirectory, { mode: 0o700 });
    } catch (error) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `A mutation journal already exists for call '${plan.identity.callId}'.`,
        { cause: error },
      );
    }

    try {
      const manifest = await this.createManifest(transactionDirectory, plan);
      await writeAtomicJson(
        join(transactionDirectory, "manifest.json"),
        manifest,
        this.options.token,
      );
      await writeAtomicJson(
        join(transactionDirectory, "state.json"),
        mutationJournalStateSchema.parse({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          status: "active",
          updatedAt: this.options.now(),
        }),
        this.options.token,
      );
      await syncDirectory(transactionDirectory);
      await syncDirectory(threadDirectory);
      return new WorkspaceMutationJournalTransaction(
        transactionDirectory,
        this.options,
      );
    } catch (error) {
      await rm(transactionDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  public async recoverBeforeWrite(
    options: WorkspaceMutationRecoveryOptions = {},
  ): Promise<WorkspaceMutationRecoveryResult[]> {
    const recovered = await this.recoverPending(options);
    const conflicts = recovered.filter(
      (result) => result.status === "conflicted",
    );
    if (conflicts.length > 0) {
      const paths = [...new Set(conflicts.flatMap((result) => result.paths))];
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_RECOVERY_CONFLICT",
        `Interrupted workspace changes conflict with current files: ${paths.join(", ")}. Inspect and explicitly resolve the retained mutation journal before another write.`,
      );
    }
    return recovered;
  }

  public async recoverPending(
    options: WorkspaceMutationRecoveryOptions = {},
  ): Promise<WorkspaceMutationRecoveryResult[]> {
    const transactions = await listTransactionDirectories(
      this.workspaceDirectory,
    );
    const results: WorkspaceMutationRecoveryResult[] = [];
    for (const transactionDirectory of transactions) {
      results.push(
        await this.recoverTransaction(
          transactionDirectory,
          options.retainRecovered ?? false,
        ),
      );
    }
    return results;
  }

  public async acknowledgeRecovery(
    result: WorkspaceMutationRecoveryResult,
  ): Promise<void> {
    const relativeDirectory = relative(
      this.workspaceDirectory,
      result.journalDirectory,
    );
    if (
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`) ||
      isAbsolute(relativeDirectory)
    ) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        "Recovery receipt points outside the workspace mutation journal.",
      );
    }
    const manifest = await readManifest(result.journalDirectory);
    if (
      manifest.threadId !== result.threadId ||
      manifest.turnId !== result.turnId ||
      manifest.callId !== result.callId ||
      manifest.planSha256 !== result.planSha256
    ) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        "Recovery receipt no longer matches its mutation journal.",
      );
    }
    await removeTransactionDirectory(result.journalDirectory);
  }

  private async createManifest(
    transactionDirectory: string,
    plan: WorkspaceMutationJournalPlan,
  ): Promise<MutationJournalManifest> {
    const backupsDirectory = join(transactionDirectory, "backups");
    const changes: MutationJournalOperation[] = [];
    let backupBytes = 0;

    for (const change of plan.changes) {
      let backup: string | undefined;
      if (change.beforeSha256 !== null) {
        if (change.beforeBytes === undefined) {
          throw new WorkspaceMutationJournalError(
            "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
            `Mutation journal is missing before bytes for '${change.path}'.`,
          );
        }
        if (hashBytes(change.beforeBytes) !== change.beforeSha256) {
          throw new WorkspaceMutationJournalError(
            "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
            `Mutation journal before bytes do not match '${change.path}'.`,
          );
        }
        backupBytes += change.beforeBytes.byteLength;
        if (backupBytes > MAXIMUM_TOTAL_BACKUP_BYTES) {
          throw new WorkspaceMutationJournalError(
            "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
            `Mutation journal backups exceed ${MAXIMUM_TOTAL_BACKUP_BYTES} bytes.`,
          );
        }
        await mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
        backup = `backups/${change.index}.before`;
        await writeNewFile(
          join(transactionDirectory, backup),
          change.beforeBytes,
          0o600,
        );
      } else if (change.beforeBytes !== undefined) {
        throw new WorkspaceMutationJournalError(
          "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
          `Create operation '${change.path}' cannot have before bytes.`,
        );
      }

      changes.push(
        journalOperationSchema.parse({
          index: change.index,
          operation: change.operation,
          path: change.path,
          ...(change.destination === undefined
            ? {}
            : { destination: change.destination }),
          beforeSha256: change.beforeSha256,
          afterSha256: change.afterSha256,
          bytes: change.bytes,
          beforeMode: change.beforeMode,
          afterMode: change.afterMode,
          ...(backup === undefined ? {} : { backup }),
          ...(change.stagedPath === undefined
            ? {}
            : { staged: change.stagedPath }),
        }),
      );
    }
    if (backupBytes > 0) {
      await syncDirectory(backupsDirectory);
    }

    return mutationJournalManifestSchema.parse({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      workspaceRoot: this.workspaceRoot,
      workspaceSha256: hashText(this.workspaceRoot),
      threadId: plan.identity.threadId,
      turnId: plan.identity.turnId,
      callId: plan.identity.callId,
      toolName: plan.identity.toolName,
      planSha256: plan.planSha256,
      createdAt: this.options.now(),
      changes,
    });
  }

  private async recoverTransaction(
    transactionDirectory: string,
    retainRecovered: boolean,
  ): Promise<WorkspaceMutationRecoveryResult> {
    const manifest = await readManifest(transactionDirectory);
    if (
      manifest.workspaceRoot !== this.workspaceRoot ||
      manifest.workspaceSha256 !== hashText(this.workspaceRoot)
    ) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `Mutation journal '${transactionDirectory}' belongs to a different workspace.`,
      );
    }
    await verifyBackups(transactionDirectory, manifest);

    const states = await Promise.all(
      manifest.changes.map((change) => this.classifyOperation(change)),
    );
    const paths = manifest.changes.flatMap((change) =>
      change.destination === undefined
        ? [change.path]
        : [change.path, change.destination],
    );
    const resultBase = {
      threadId: manifest.threadId,
      turnId: manifest.turnId,
      callId: manifest.callId,
      toolName: manifest.toolName,
      planSha256: manifest.planSha256,
      paths,
      primaryPaths: manifest.changes.map((change) => change.path),
      changeCount: manifest.changes.length,
      journalDirectory: transactionDirectory,
    };
    const stagingConflicts = await this.cleanupStagedFiles(manifest);
    if (stagingConflicts.length > 0) {
      const conflictPaths = [...paths, ...stagingConflicts];
      await writeAtomicJson(
        join(transactionDirectory, "state.json"),
        mutationJournalStateSchema.parse({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          status: "conflicted",
          updatedAt: this.options.now(),
          reason: "STAGED_CANDIDATE_DIVERGED",
          paths: conflictPaths,
        }),
        this.options.token,
      );
      return {
        ...resultBase,
        status: "conflicted",
        paths: conflictPaths,
        appliedCount: states.filter(
          (state) => state === "after" || state === "intermediate",
        ).length,
        restoredPaths: [],
      };
    }

    if (states.every((state) => state === "before")) {
      if (retainRecovered) {
        await this.markRecovered(
          transactionDirectory,
          "rolled_back",
          "PROCESS_INTERRUPTED_BEFORE_MUTATION",
          [],
        );
      } else {
        await removeTransactionDirectory(transactionDirectory);
      }
      return {
        ...resultBase,
        status: "not_started",
        appliedCount: 0,
        restoredPaths: [],
      };
    }
    if (states.every((state) => state === "after")) {
      if (retainRecovered) {
        await this.markRecovered(
          transactionDirectory,
          "committed",
          "PROCESS_INTERRUPTED_AFTER_COMMIT",
          paths,
        );
      } else {
        await removeTransactionDirectory(transactionDirectory);
      }
      return {
        ...resultBase,
        status: "committed",
        appliedCount: manifest.changes.length,
        restoredPaths: [],
      };
    }
    if (states.some((state) => state === "divergent")) {
      await writeAtomicJson(
        join(transactionDirectory, "state.json"),
        mutationJournalStateSchema.parse({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          status: "conflicted",
          updatedAt: this.options.now(),
          reason: "FILESYSTEM_DIVERGED",
          paths,
        }),
        this.options.token,
      );
      return {
        ...resultBase,
        status: "conflicted",
        appliedCount: states.filter(
          (state) => state === "after" || state === "intermediate",
        ).length,
        restoredPaths: [],
      };
    }

    const initiallyApplied = states.filter(
      (state) => state !== "before",
    ).length;
    const restoredPaths: string[] = [];
    for (const change of [...manifest.changes].reverse()) {
      const state = await this.classifyOperation(change);
      if (state === "before") {
        continue;
      }
      if (state === "divergent") {
        await writeAtomicJson(
          join(transactionDirectory, "state.json"),
          mutationJournalStateSchema.parse({
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            status: "conflicted",
            updatedAt: this.options.now(),
            reason: "FILESYSTEM_CHANGED_DURING_RECOVERY",
            paths: [change.path],
          }),
          this.options.token,
        );
        return {
          ...resultBase,
          status: "conflicted",
          appliedCount: initiallyApplied,
          restoredPaths,
        };
      }
      await this.restoreBefore(transactionDirectory, change, state);
      restoredPaths.push(change.path);
    }

    const verified = await Promise.all(
      manifest.changes.map((change) => this.classifyOperation(change)),
    );
    if (!verified.every((state) => state === "before")) {
      await writeAtomicJson(
        join(transactionDirectory, "state.json"),
        mutationJournalStateSchema.parse({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          status: "conflicted",
          updatedAt: this.options.now(),
          reason: "ROLLBACK_VERIFICATION_FAILED",
          paths,
        }),
        this.options.token,
      );
      return {
        ...resultBase,
        status: "conflicted",
        appliedCount: initiallyApplied,
        restoredPaths,
      };
    }
    if (retainRecovered) {
      await this.markRecovered(
        transactionDirectory,
        "rolled_back",
        "PROCESS_INTERRUPTED_DURING_COMMIT",
        restoredPaths,
      );
    } else {
      await removeTransactionDirectory(transactionDirectory);
    }
    return {
      ...resultBase,
      status: "rolled_back",
      appliedCount: initiallyApplied,
      restoredPaths,
    };
  }

  private async markRecovered(
    transactionDirectory: string,
    status: "committed" | "rolled_back",
    reason: string,
    paths: readonly string[],
  ): Promise<void> {
    await writeAtomicJson(
      join(transactionDirectory, "state.json"),
      mutationJournalStateSchema.parse({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status,
        updatedAt: this.options.now(),
        reason,
        paths: [...paths],
      }),
      this.options.token,
    );
  }

  private async classifyOperation(
    change: MutationJournalOperation,
  ): Promise<OperationState> {
    const source = this.resolveJournalPath(change.path);
    const sourceState = await this.observeJournalFile(source);
    if (change.operation === "create") {
      return matchesAbsent(sourceState)
        ? "before"
        : matchesFile(sourceState, change.afterSha256, change.afterMode)
          ? "after"
          : "divergent";
    }
    if (change.operation === "update") {
      return matchesFile(sourceState, change.beforeSha256, change.beforeMode)
        ? "before"
        : matchesFile(sourceState, change.afterSha256, change.afterMode)
          ? "after"
          : "divergent";
    }
    if (change.operation === "delete") {
      return matchesFile(sourceState, change.beforeSha256, change.beforeMode)
        ? "before"
        : matchesAbsent(sourceState)
          ? "after"
          : "divergent";
    }

    const destination = this.resolveJournalPath(change.destination!);
    const destinationState = await this.observeJournalFile(destination);
    const sourceMatches = matchesFile(
      sourceState,
      change.beforeSha256,
      change.beforeMode,
    );
    const destinationMatches = matchesFile(
      destinationState,
      change.afterSha256,
      change.afterMode,
    );
    if (sourceMatches && matchesAbsent(destinationState)) {
      return "before";
    }
    if (matchesAbsent(sourceState) && destinationMatches) {
      return "after";
    }
    return sourceMatches && destinationMatches ? "intermediate" : "divergent";
  }

  private async restoreBefore(
    transactionDirectory: string,
    change: MutationJournalOperation,
    state: Exclude<OperationState, "before" | "divergent">,
  ): Promise<void> {
    const source = this.resolveJournalPath(change.path);
    if (change.operation === "create") {
      await rm(source);
      await syncDirectory(dirname(source));
      return;
    }
    const backup = await readVerifiedBackup(transactionDirectory, change);
    if (change.operation === "update") {
      await replaceFile(source, backup, change.beforeMode!);
      return;
    }
    if (change.operation === "delete") {
      await createFile(source, backup, change.beforeMode!);
      return;
    }

    const destination = this.resolveJournalPath(change.destination!);
    if (state === "after") {
      await createFile(source, backup, change.beforeMode!);
    }
    await rm(destination);
    await syncDirectory(dirname(destination));
  }

  private async cleanupStagedFiles(
    manifest: MutationJournalManifest,
  ): Promise<string[]> {
    const conflicts: string[] = [];
    for (const change of manifest.changes) {
      if (change.staged === undefined) {
        continue;
      }
      const staged = this.resolveJournalPath(change.staged);
      const state = await this.observeJournalFile(staged);
      if (matchesAbsent(state)) {
        continue;
      }
      if (!matchesFile(state, change.afterSha256, change.afterMode)) {
        conflicts.push(change.staged);
        continue;
      }
      await rm(staged);
      await syncDirectory(dirname(staged));
    }
    return conflicts;
  }

  private resolveJournalPath(workspacePath: string): string {
    if (
      workspacePath.length === 0 ||
      workspacePath.includes("\0") ||
      isAbsolute(workspacePath)
    ) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `Mutation journal contains an invalid path '${workspacePath}'.`,
      );
    }
    const target = resolve(this.workspaceRoot, workspacePath);
    const relativeTarget = relative(this.workspaceRoot, target);
    if (
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `Mutation journal path escapes the workspace: '${workspacePath}'.`,
      );
    }
    return target;
  }

  private async observeJournalFile(path: string): Promise<ObservedFileState> {
    try {
      const parent = dirname(path);
      if ((await realpath(parent)) !== parent) {
        return { kind: "divergent" };
      }
      const relativeParent = relative(this.workspaceRoot, parent);
      if (
        relativeParent === ".." ||
        relativeParent.startsWith(`..${sep}`) ||
        isAbsolute(relativeParent)
      ) {
        return { kind: "divergent" };
      }
      return observeFile(path);
    } catch {
      return { kind: "divergent" };
    }
  }
}

export class WorkspaceMutationJournalTransaction {
  public constructor(
    public readonly directory: string,
    private readonly options: Required<WorkspaceMutationJournalStoreOptions>,
  ) {}

  public async complete(status: "committed" | "rolled_back"): Promise<void> {
    await writeAtomicJson(
      join(this.directory, "state.json"),
      mutationJournalStateSchema.parse({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status,
        updatedAt: this.options.now(),
      }),
      this.options.token,
    );
    await removeTransactionDirectory(this.directory);
  }

  public async retainConflict(paths: readonly string[]): Promise<void> {
    await writeAtomicJson(
      join(this.directory, "state.json"),
      mutationJournalStateSchema.parse({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status: "conflicted",
        updatedAt: this.options.now(),
        reason: "IN_PROCESS_ROLLBACK_UNCERTAIN",
        paths: [...paths],
      }),
      this.options.token,
    );
  }

  public async discardBeforeMutation(): Promise<void> {
    await removeTransactionDirectory(this.directory);
  }
}

async function listTransactionDirectories(root: string): Promise<string[]> {
  const transactions: string[] = [];
  const threadEntries = await readdir(root, { withFileTypes: true });
  for (const threadEntry of threadEntries) {
    if (!threadEntry.isDirectory() || threadEntry.isSymbolicLink()) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `Unexpected entry in mutation journal root: '${threadEntry.name}'.`,
      );
    }
    const threadDirectory = join(root, threadEntry.name);
    const transactionEntries = await readdir(threadDirectory, {
      withFileTypes: true,
    });
    for (const transactionEntry of transactionEntries) {
      if (
        !transactionEntry.isDirectory() ||
        transactionEntry.isSymbolicLink()
      ) {
        throw new WorkspaceMutationJournalError(
          "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
          `Unexpected entry in mutation journal thread directory: '${transactionEntry.name}'.`,
        );
      }
      transactions.push(join(threadDirectory, transactionEntry.name));
    }
  }
  return transactions.sort((left, right) => left.localeCompare(right));
}

async function readManifest(
  transactionDirectory: string,
): Promise<MutationJournalManifest> {
  try {
    const manifestPath = join(transactionDirectory, "manifest.json");
    const manifestStats = await lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    const bytes = await readFile(manifestPath);
    if (bytes.byteLength > 128_000) {
      throw new Error("manifest exceeds 128000 bytes");
    }
    return mutationJournalManifestSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
  } catch (error) {
    throw new WorkspaceMutationJournalError(
      "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
      `Cannot read mutation journal manifest '${transactionDirectory}'.`,
      { cause: error },
    );
  }
}

async function verifyBackups(
  transactionDirectory: string,
  manifest: MutationJournalManifest,
): Promise<void> {
  let totalBytes = 0;
  for (const change of manifest.changes) {
    if (change.backup === undefined) {
      continue;
    }
    const bytes = await readVerifiedBackup(transactionDirectory, change);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAXIMUM_TOTAL_BACKUP_BYTES) {
      throw new WorkspaceMutationJournalError(
        "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
        `Mutation journal backups exceed ${MAXIMUM_TOTAL_BACKUP_BYTES} bytes.`,
      );
    }
  }
}

async function readVerifiedBackup(
  transactionDirectory: string,
  change: MutationJournalOperation,
): Promise<Buffer> {
  if (change.backup === undefined || change.beforeSha256 === null) {
    throw new WorkspaceMutationJournalError(
      "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
      `Mutation journal has no backup for '${change.path}'.`,
    );
  }
  const backupPath = join(transactionDirectory, change.backup);
  const backupStats = await lstat(backupPath).catch(() => undefined);
  if (
    backupStats === undefined ||
    !backupStats.isFile() ||
    backupStats.isSymbolicLink()
  ) {
    throw new WorkspaceMutationJournalError(
      "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
      `Mutation journal backup is missing or invalid for '${change.path}'.`,
    );
  }
  if (backupStats.size > MAXIMUM_FILE_BYTES) {
    throw new WorkspaceMutationJournalError(
      "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
      `Mutation journal backup exceeds the file limit for '${change.path}'.`,
    );
  }
  const bytes = await readFile(backupPath);
  if (hashBytes(bytes) !== change.beforeSha256) {
    throw new WorkspaceMutationJournalError(
      "WORKSPACE_MUTATION_JOURNAL_CORRUPT",
      `Mutation journal backup digest does not match '${change.path}'.`,
    );
  }
  return bytes;
}

async function observeFile(path: string): Promise<ObservedFileState> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { kind: "absent" };
    }
    return { kind: "divergent" };
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > MAXIMUM_FILE_BYTES
  ) {
    return { kind: "divergent" };
  }
  const bytes = await readFile(path).catch(() => undefined);
  return bytes === undefined
    ? { kind: "divergent" }
    : { kind: "file", sha256: hashBytes(bytes), mode: stats.mode & 0o777 };
}

function matchesAbsent(state: ObservedFileState): boolean {
  return state.kind === "absent";
}

function matchesFile(
  state: ObservedFileState,
  sha256: string | null,
  mode: number | null,
): boolean {
  return (
    state.kind === "file" &&
    sha256 !== null &&
    mode !== null &&
    state.sha256 === sha256 &&
    state.mode === mode
  );
}

async function replaceFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.koda-recovery-${randomUUID()}.tmp`,
  );
  try {
    await writeNewFile(temporaryPath, bytes, mode);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function createFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.koda-recovery-${randomUUID()}.tmp`,
  );
  try {
    await writeNewFile(temporaryPath, bytes, mode);
    await link(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeNewFile(
  path: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  token: () => string,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${token()}.tmp`,
  );
  const content = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  try {
    await writeNewFile(temporaryPath, content, 0o600);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeTransactionDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  await rm(path, { recursive: true, force: true });
  await syncDirectory(parent);
  const entries = await readdir(parent).catch(() => ["retained"]);
  if (entries.length === 0) {
    await rm(parent, { recursive: true, force: true });
  }
  await syncDirectory(dirname(parent));
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
