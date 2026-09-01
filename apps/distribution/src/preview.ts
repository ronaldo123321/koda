import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import {
  createMacOSPreviewState,
  createMacOSPreviewTarget,
  KodaPreviewError,
  loadReleaseInstallation,
  macOSPreviewActivationJournalSchema,
  macOSPreviewStateSchema,
  MacOSPreviewOperationLock,
  readMacOSPreviewActivationJournal,
  readMacOSPreviewLink,
  readMacOSPreviewState,
  recoverMacOSPreviewActivation,
  removeMacOSPreviewActivationJournal,
  replaceMacOSPreviewLink,
  resolveMacOSPreviewPaths,
  resolveMacOSPreviewTargetPath,
  runtimeManifestDigest,
  verifyFullIntegrity,
  writeMacOSPreviewActivationJournal,
  writeMacOSPreviewState,
  type MacOSPreviewPaths,
  type MacOSPreviewState,
  type MacOSPreviewTarget,
} from "@koda/distribution";

import {
  auditMachOFiles,
  makeTreeWritable,
  smokeStandaloneBundle,
} from "./bundle.js";
import {
  readMacOSReleaseMetadata,
  validateMacOSArchiveEntries,
  verifyMacOSReleaseArtifact,
} from "./release.js";

const CHILD_OUTPUT_MAXIMUM_BYTES = 1_048_576;

export interface MacOSPreviewStatus {
  readonly schema_version: 1;
  readonly status: "not_installed" | "ready" | "recovery_required" | "invalid";
  readonly root: string;
  readonly bin_directory: string;
  readonly bin_on_path: boolean;
  readonly active: MacOSPreviewTarget | null;
  readonly previous: MacOSPreviewTarget | null;
  readonly installed: readonly MacOSPreviewTarget[];
  readonly recovery_pending: boolean;
  readonly doctor: "passed" | "not_run" | "failed";
  readonly signing: "unsigned_internal_preview";
}

export interface InstallMacOSPreviewOptions {
  readonly paths: MacOSPreviewPaths;
  readonly archivePath: string;
  readonly metadataPath: string;
  readonly now?: () => number;
  readonly token?: () => string;
}

export async function installMacOSPreview(
  options: InstallMacOSPreviewOptions,
): Promise<MacOSPreviewStatus> {
  assertMacOSHost();
  const token: () => string = options.token ?? (() => randomUUID());
  const lock = await MacOSPreviewOperationLock.acquire(
    options.paths,
    "install",
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      operationId: token,
    },
  );
  try {
    await recoverMacOSPreviewActivation(options.paths, {
      ...(options.now === undefined ? {} : { now: options.now }),
      token,
    });
    const staged = await stageMacOSPreviewBundle({
      paths: options.paths,
      archivePath: options.archivePath,
      metadataPath: options.metadataPath,
    });
    try {
      const targetPath = resolveMacOSPreviewTargetPath(
        options.paths,
        staged.target,
      );
      if (await pathExists(targetPath)) {
        await verifyInstalledTarget(targetPath, staged.target, staged.metadata);
      } else {
        await rename(staged.bundleRoot, targetPath);
      }
      await installPreviewLaunchers(options.paths, token);
      const existing = await readMacOSPreviewState(options.paths);
      const active = targetForLink(
        existing,
        await readMacOSPreviewLink(options.paths, "current"),
      );
      const previous = targetForLink(
        existing,
        await readMacOSPreviewLink(options.paths, "previous"),
      );
      if (active?.identity !== staged.target.identity) {
        const journal = macOSPreviewActivationJournalSchema.parse({
          schema_version: 1,
          operation_id: token(),
          operation: "install",
          before: active,
          before_previous: previous,
          after: staged.target,
          created_at_ms: (options.now ?? Date.now)(),
        });
        await writeMacOSPreviewActivationJournal(options.paths, journal, token);
        await replaceMacOSPreviewLink(options.paths, "previous", active, token);
        await replaceMacOSPreviewLink(
          options.paths,
          "current",
          staged.target,
          token,
        );
        await writeMacOSPreviewState(
          options.paths,
          createMacOSPreviewState({
            active: staged.target,
            previous: active,
            installed: [...(existing?.installed ?? []), staged.target],
            updatedAtMs: (options.now ?? Date.now)(),
          }),
          token,
        );
        await removeMacOSPreviewActivationJournal(options.paths);
      }
    } finally {
      await makeTreeWritable(staged.stagingRoot).catch(() => undefined);
      await rm(staged.stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    return inspectMacOSPreview(options.paths, { runDoctor: true });
  } finally {
    await lock.release();
  }
}

export async function rollbackMacOSPreview(input: {
  paths: MacOSPreviewPaths;
  now?: () => number;
  token?: () => string;
}): Promise<MacOSPreviewStatus> {
  assertMacOSHost();
  const token: () => string = input.token ?? (() => randomUUID());
  const lock = await MacOSPreviewOperationLock.acquire(
    input.paths,
    "rollback",
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      operationId: token,
    },
  );
  try {
    await recoverMacOSPreviewActivation(input.paths, {
      ...(input.now === undefined ? {} : { now: input.now }),
      token,
    });
    const state = await requiredState(input.paths);
    if (state.active === null || state.previous === null) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    await verifyInstalledTarget(
      resolveMacOSPreviewTargetPath(input.paths, state.previous),
      state.previous,
    );
    const journal = macOSPreviewActivationJournalSchema.parse({
      schema_version: 1,
      operation_id: token(),
      operation: "rollback",
      before: state.active,
      before_previous: state.previous,
      after: state.previous,
      created_at_ms: (input.now ?? Date.now)(),
    });
    await writeMacOSPreviewActivationJournal(input.paths, journal, token);
    await replaceMacOSPreviewLink(input.paths, "previous", state.active, token);
    await replaceMacOSPreviewLink(
      input.paths,
      "current",
      state.previous,
      token,
    );
    await writeMacOSPreviewState(
      input.paths,
      createMacOSPreviewState({
        active: state.previous,
        previous: state.active,
        installed: state.installed,
        updatedAtMs: (input.now ?? Date.now)(),
      }),
      token,
    );
    await removeMacOSPreviewActivationJournal(input.paths);
    return inspectMacOSPreview(input.paths, { runDoctor: true });
  } finally {
    await lock.release();
  }
}

export async function inspectMacOSPreview(
  paths: MacOSPreviewPaths,
  options: { readonly runDoctor?: boolean } = {},
): Promise<MacOSPreviewStatus> {
  const [state, current, previous, journal, kodaLauncher, chatLauncher] =
    await Promise.all([
      readMacOSPreviewState(paths),
      readMacOSPreviewLink(paths, "current"),
      readMacOSPreviewLink(paths, "previous"),
      readMacOSPreviewActivationJournal(paths),
      inspectManagedLauncher(
        paths.kodaLauncher,
        expectedLauncherTarget(paths, "koda"),
      ),
      inspectManagedLauncher(
        paths.chatLauncher,
        expectedLauncherTarget(paths, "koda-chat"),
      ),
    ]);
  if (journal !== null) {
    return status(paths, state, "recovery_required", "not_run", true);
  }
  if (
    state === null &&
    current === null &&
    previous === null &&
    kodaLauncher === "absent" &&
    chatLauncher === "absent"
  ) {
    return status(paths, null, "not_installed", "not_run", false);
  }
  if (
    state === null ||
    (state.active?.relative_path ?? null) !== current ||
    (state.previous?.relative_path ?? null) !== previous ||
    kodaLauncher !== "managed" ||
    chatLauncher !== "managed"
  ) {
    return status(paths, state, "invalid", "not_run", false);
  }
  if (options.runDoctor !== true || state.active === null) {
    return status(paths, state, "ready", "not_run", false);
  }
  try {
    await verifyInstalledTarget(
      resolveMacOSPreviewTargetPath(paths, state.active),
      state.active,
    );
    return status(paths, state, "ready", "passed", false);
  } catch {
    return status(paths, state, "invalid", "failed", false);
  }
}

export async function uninstallMacOSPreview(input: {
  paths: MacOSPreviewPaths;
  confirmed: boolean;
  now?: () => number;
  token?: () => string;
}): Promise<MacOSPreviewStatus> {
  if (!input.confirmed) {
    throw new KodaPreviewError("KODA_PREVIEW_CONFIRMATION_REQUIRED");
  }
  const token: () => string = input.token ?? (() => randomUUID());
  const lock = await MacOSPreviewOperationLock.acquire(
    input.paths,
    "uninstall",
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      operationId: token,
    },
  );
  try {
    await recoverMacOSPreviewActivation(input.paths, {
      ...(input.now === undefined ? {} : { now: input.now }),
      token,
    });
    const before = await inspectMacOSPreview(input.paths);
    if (before.status !== "ready" && before.status !== "not_installed") {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    await assertManagedUninstallTree(input.paths);
    await removeManagedLauncher(
      input.paths.kodaLauncher,
      expectedLauncherTarget(input.paths, "koda"),
    );
    await removeManagedLauncher(
      input.paths.chatLauncher,
      expectedLauncherTarget(input.paths, "koda-chat"),
    );
    await Promise.all([
      rm(input.paths.currentLink, { force: true }),
      rm(input.paths.previousLink, { force: true }),
      rm(input.paths.state, { force: true }),
      rm(input.paths.transactions, { recursive: true, force: true }),
      rm(input.paths.versions, { recursive: true, force: true }),
    ]);
  } finally {
    await lock.release();
  }
  await rmdir(input.paths.root).catch(() => undefined);
  return status(input.paths, null, "not_installed", "not_run", false);
}

export function defaultMacOSPreviewPaths(input: {
  homeDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
}): MacOSPreviewPaths {
  return resolveMacOSPreviewPaths({
    homeDirectory: resolve(input.homeDirectory),
    ...(input.environment.KODA_PREVIEW_ROOT === undefined
      ? {}
      : { previewRoot: input.environment.KODA_PREVIEW_ROOT }),
    ...(input.environment.KODA_PREVIEW_BIN_DIR === undefined
      ? {}
      : { binDirectory: input.environment.KODA_PREVIEW_BIN_DIR }),
  });
}

async function stageMacOSPreviewBundle(input: {
  paths: MacOSPreviewPaths;
  archivePath: string;
  metadataPath: string;
}): Promise<{
  stagingRoot: string;
  bundleRoot: string;
  target: MacOSPreviewTarget;
  metadata: Awaited<ReturnType<typeof readMacOSReleaseMetadata>>;
}> {
  await mkdir(input.paths.versions, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(join(input.paths.versions, ".staging-"));
  try {
    const archive = join(stagingRoot, basename(input.archivePath));
    const metadataPath = join(stagingRoot, basename(input.metadataPath));
    await copyFile(
      await realpath(input.archivePath),
      archive,
      constants.COPYFILE_EXCL,
    );
    await copyFile(
      await realpath(input.metadataPath),
      metadataPath,
      constants.COPYFILE_EXCL,
    );
    const verification = await verifyMacOSReleaseArtifact({
      archivePath: archive,
      metadataPath,
      skipSmoke: true,
    });
    if (verification.architecture !== process.arch) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
    const metadata = await readMacOSReleaseMetadata(metadataPath);
    const listing = await capture(
      archive.endsWith(".zip") ? "/usr/bin/unzip" : "/usr/bin/tar",
      archive.endsWith(".zip") ? ["-Z1", archive] : ["-tzf", archive],
      stagingRoot,
    );
    validateMacOSArchiveEntries(listing);
    const extractRoot = join(stagingRoot, "extract");
    await mkdir(extractRoot, { mode: 0o700 });
    await capture(
      archive.endsWith(".zip") ? "/usr/bin/unzip" : "/usr/bin/tar",
      archive.endsWith(".zip")
        ? ["-q", archive, "-d", extractRoot]
        : ["-xzf", archive, "-C", extractRoot],
      stagingRoot,
    );
    const bundleRoot = await realpath(join(extractRoot, "koda"));
    const target = createMacOSPreviewTarget({
      version: metadata.version,
      sourceCommit: metadata.source_commit,
      arch: metadata.arch,
    });
    await verifyInstalledTarget(bundleRoot, target, metadata);
    return { stagingRoot, bundleRoot, target, metadata };
  } catch (error) {
    await makeTreeWritable(stagingRoot).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function verifyInstalledTarget(
  bundleRoot: string,
  target: MacOSPreviewTarget,
  metadata?: Awaited<ReturnType<typeof readMacOSReleaseMetadata>>,
): Promise<void> {
  const rootMetadata = await lstat(bundleRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
  }
  const installation = await loadReleaseInstallation(
    join(bundleRoot, "libexec", "koda"),
    {
      expectedPlatform: "darwin",
      expectedArch: target.arch,
      verifyCriticalFiles: true,
    },
  );
  await verifyFullIntegrity(installation);
  await smokeStandaloneBundle(bundleRoot);
  if (metadata !== undefined) {
    const nativeFiles = await auditMachOFiles(bundleRoot, target.arch);
    if (
      runtimeManifestDigest(installation.manifest) !==
        metadata.payload.runtime_manifest_sha256 ||
      installation.manifest.integrity_sha256 !==
        metadata.payload.integrity_inventory_sha256 ||
      JSON.stringify(nativeFiles) !==
        JSON.stringify(metadata.payload.native_files)
    ) {
      throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
    }
  }
}

async function installPreviewLaunchers(
  paths: MacOSPreviewPaths,
  token: () => string,
): Promise<void> {
  await mkdir(paths.binDirectory, { recursive: true, mode: 0o700 });
  await replaceManagedLauncher(
    paths.kodaLauncher,
    expectedLauncherTarget(paths, "koda"),
    token,
  );
  await replaceManagedLauncher(
    paths.chatLauncher,
    expectedLauncherTarget(paths, "koda-chat"),
    token,
  );
}

async function replaceManagedLauncher(
  path: string,
  target: string,
  token: () => string,
): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink() || (await readlink(path)) !== target) {
      throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
    }
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  const temporary = join(dirname(path), `.${basename(path)}.${token()}.tmp`);
  try {
    await symlink(target, temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function removeManagedLauncher(
  path: string,
  target: string,
): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink() || (await readlink(path)) !== target) {
      throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
    }
    await rm(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

async function inspectManagedLauncher(
  path: string,
  target: string,
): Promise<"absent" | "managed" | "invalid"> {
  try {
    const metadata = await lstat(path);
    return metadata.isSymbolicLink() && (await readlink(path)) === target
      ? "managed"
      : "invalid";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return "absent";
    }
    return "invalid";
  }
}

async function assertManagedUninstallTree(
  paths: MacOSPreviewPaths,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(paths.root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const allowed = new Set([
    "versions",
    "transactions",
    "current",
    "previous",
    "state.json",
    "operation.lock",
  ]);
  if (entries.some((entry) => !allowed.has(entry.name))) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
  const state = await readMacOSPreviewState(paths);
  const expectedVersions = new Set(
    state?.installed.map((target) => target.identity) ?? [],
  );
  let versions: Dirent[];
  try {
    versions = await readdir(paths.versions, { withFileTypes: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
    versions = [];
  }
  if (
    versions.length !== expectedVersions.size ||
    versions.some(
      (entry) =>
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !expectedVersions.has(entry.name),
    )
  ) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
  let transactions;
  try {
    transactions = await readdir(paths.transactions);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
    transactions = [];
  }
  if (transactions.length > 0) {
    throw new KodaPreviewError("KODA_PREVIEW_PATH_INVALID");
  }
}

function expectedLauncherTarget(
  paths: MacOSPreviewPaths,
  command: "koda" | "koda-chat",
): string {
  return join(paths.currentLink, "bin", command);
}

function targetForLink(
  state: MacOSPreviewState | null,
  link: string | null,
): MacOSPreviewTarget | null {
  if (link === null) {
    return null;
  }
  const target = state?.installed.find(
    (candidate) => candidate.relative_path === link,
  );
  if (target === undefined) {
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
  }
  return target;
}

async function requiredState(
  paths: MacOSPreviewPaths,
): Promise<MacOSPreviewState> {
  const state = await readMacOSPreviewState(paths);
  if (state === null) {
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
  }
  return macOSPreviewStateSchema.parse(state);
}

function status(
  paths: MacOSPreviewPaths,
  state: MacOSPreviewState | null,
  currentStatus: MacOSPreviewStatus["status"],
  doctor: MacOSPreviewStatus["doctor"],
  recoveryPending: boolean,
): MacOSPreviewStatus {
  return {
    schema_version: 1,
    status: currentStatus,
    root: paths.root,
    bin_directory: paths.binDirectory,
    bin_on_path: pathContainsDirectory(process.env.PATH, paths.binDirectory),
    active: state?.active ?? null,
    previous: state?.previous ?? null,
    installed: state?.installed ?? [],
    recovery_pending: recoveryPending,
    doctor,
    signing: "unsigned_internal_preview",
  };
}

function pathContainsDirectory(
  pathValue: string | undefined,
  directory: string,
): boolean {
  return (pathValue ?? "")
    .split(delimiter)
    .some((entry) => entry.length > 0 && resolve(entry) === directory);
}

async function capture(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, COPYFILE_DISABLE: "1", LANG: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const append = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > CHILD_OUTPUT_MAXIMUM_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (
        code !== 0 ||
        bytes > CHILD_OUTPUT_MAXIMUM_BYTES ||
        stderr.length > 0
      ) {
        reject(new KodaPreviewError("KODA_PREVIEW_STATE_INVALID"));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function assertMacOSHost(): void {
  if (
    process.platform !== "darwin" ||
    (process.arch !== "arm64" && process.arch !== "x64")
  ) {
    throw new KodaPreviewError("KODA_PREVIEW_STATE_INVALID");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
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
