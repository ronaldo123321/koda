import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";

import {
  compareMacOSReleaseMetadata,
  loadReleaseInstallation,
  macOSReleaseMetadataSchema,
  runtimeManifestDigest,
  verifyFullIntegrity,
  type MacOSReleaseMetadata,
  type MacOSReleaseSet,
} from "@koda/distribution";

import {
  auditMachOFiles,
  makeTreeWritable,
  smokeStandaloneBundle,
} from "./bundle.js";

const METADATA_MAXIMUM_BYTES = 1_048_576;
const ARCHIVE_LIST_MAXIMUM_BYTES = 8 * 1_048_576;
const ARCHIVE_MAXIMUM_ENTRIES = 100_000;
const TOOL_TIMEOUT_MS = 60_000;

export type KodaReleaseErrorCode =
  | "KODA_RELEASE_METADATA_INVALID"
  | "KODA_RELEASE_ARCHIVE_INTEGRITY_FAILED"
  | "KODA_RELEASE_ARCHIVE_INVALID"
  | "KODA_RELEASE_CONTRACT_MISMATCH"
  | "KODA_RELEASE_CORRUPTION_CHECK_FAILED";

const RELEASE_MESSAGES: Readonly<Record<KodaReleaseErrorCode, string>> = {
  KODA_RELEASE_METADATA_INVALID:
    "The macOS release metadata is invalid or does not match its artifact.",
  KODA_RELEASE_ARCHIVE_INTEGRITY_FAILED:
    "The macOS release archive does not match its declared size and SHA-256.",
  KODA_RELEASE_ARCHIVE_INVALID:
    "The macOS release archive is malformed or its extracted payload is invalid.",
  KODA_RELEASE_CONTRACT_MISMATCH:
    "The arm64 and Intel artifacts do not describe the same release contract.",
  KODA_RELEASE_CORRUPTION_CHECK_FAILED:
    "The macOS release corruption-negative acceptance check failed.",
};

export class KodaReleaseError extends Error {
  public constructor(
    public readonly code: KodaReleaseErrorCode,
    options?: ErrorOptions,
  ) {
    super(RELEASE_MESSAGES[code], options);
    this.name = "KodaReleaseError";
  }
}

export interface VerifyMacOSReleaseOptions {
  readonly archivePath: string;
  readonly metadataPath: string;
  readonly skipSmoke?: boolean;
}

export interface VerifyMacOSReleaseResult {
  readonly architecture: "arm64" | "x64";
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly sourceCommit: string;
  readonly nativeFiles: readonly string[];
}

export async function readMacOSReleaseMetadata(
  path: string,
): Promise<MacOSReleaseMetadata> {
  return (await readMacOSReleaseMetadataDocument(path)).metadata;
}

async function readMacOSReleaseMetadataDocument(path: string): Promise<{
  metadata: MacOSReleaseMetadata;
  sha256: string;
}> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > METADATA_MAXIMUM_BYTES) {
      throw new Error("Release metadata is not a bounded regular file.");
    }
    const content = await readFile(path);
    if (content.byteLength > METADATA_MAXIMUM_BYTES) {
      throw new Error("Release metadata exceeds its byte limit.");
    }
    return {
      metadata: macOSReleaseMetadataSchema.parse(
        JSON.parse(content.toString("utf8")) as unknown,
      ),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    throw new KodaReleaseError("KODA_RELEASE_METADATA_INVALID", {
      cause: error,
    });
  }
}

export async function verifyMacOSReleaseArtifact(
  options: VerifyMacOSReleaseOptions,
): Promise<VerifyMacOSReleaseResult> {
  const archivePath = await regularFile(options.archivePath);
  const metadata = await readMacOSReleaseMetadata(options.metadataPath);
  if (basename(archivePath) !== metadata.archive.name) {
    throw new KodaReleaseError("KODA_RELEASE_METADATA_INVALID");
  }
  const archiveMetadata = await stat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  if (
    archiveMetadata.size !== metadata.archive.bytes ||
    archiveSha256 !== metadata.archive.sha256
  ) {
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INTEGRITY_FAILED");
  }

  const verificationRoot = await mkdtemp("/private/tmp/koda-release-verify-");
  try {
    const zipArchive = metadata.archive.name.endsWith(".zip");
    const listing = await runCapturedTool(
      zipArchive ? "/usr/bin/unzip" : "/usr/bin/tar",
      zipArchive ? ["-Z1", archivePath] : ["-tzf", archivePath],
      dirname(archivePath),
      ARCHIVE_LIST_MAXIMUM_BYTES,
    );
    if (listing.code !== 0 || listing.stderr.length > 0) {
      throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
    }
    validateMacOSArchiveEntries(listing.stdout);
    await mkdir(join(verificationRoot, "extract"), { recursive: true });
    const extraction = await runCapturedTool(
      zipArchive ? "/usr/bin/unzip" : "/usr/bin/tar",
      zipArchive
        ? ["-q", archivePath, "-d", join(verificationRoot, "extract")]
        : ["-xzf", archivePath, "-C", join(verificationRoot, "extract")],
      verificationRoot,
      METADATA_MAXIMUM_BYTES,
    );
    if (extraction.code !== 0 || extraction.stderr.length > 0) {
      throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
    }
    const bundleRoot = await realDirectory(
      join(verificationRoot, "extract", "koda"),
    );
    const runtimeRoot = join(bundleRoot, "libexec", "koda");
    const installation = await loadReleaseInstallation(runtimeRoot, {
      expectedPlatform: "darwin",
      expectedArch: metadata.arch,
      verifyCriticalFiles: true,
    });
    await verifyFullIntegrity(installation);
    const nativeFiles = await auditMachOFiles(bundleRoot, metadata.arch);
    if (
      runtimeManifestDigest(installation.manifest) !==
        metadata.payload.runtime_manifest_sha256 ||
      installation.manifest.integrity_sha256 !==
        metadata.payload.integrity_inventory_sha256 ||
      JSON.stringify(nativeFiles) !==
        JSON.stringify(metadata.payload.native_files)
    ) {
      throw new KodaReleaseError("KODA_RELEASE_METADATA_INVALID");
    }
    if (options.skipSmoke !== true) {
      if (process.platform !== "darwin" || process.arch !== metadata.arch) {
        throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
      }
      await smokeStandaloneBundle(bundleRoot);
    }
    return {
      architecture: metadata.arch,
      archivePath,
      archiveSha256,
      sourceCommit: metadata.source_commit,
      nativeFiles,
    };
  } catch (error) {
    if (error instanceof KodaReleaseError) {
      throw error;
    }
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID", {
      cause: error,
    });
  } finally {
    await makeTreeWritable(verificationRoot).catch(() => undefined);
    await rm(verificationRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function assertMacOSReleaseRejectsCorruption(
  options: VerifyMacOSReleaseOptions,
): Promise<void> {
  const source = await regularFile(options.archivePath);
  const scratch = await mkdtemp("/private/tmp/koda-release-corrupt-");
  const destination = join(scratch, basename(source));
  try {
    await copyFile(source, destination);
    const metadata = await stat(destination);
    if (metadata.size < 1) {
      throw new KodaReleaseError("KODA_RELEASE_CORRUPTION_CHECK_FAILED");
    }
    const handle = await open(destination, "r+");
    try {
      const offset = Math.floor(metadata.size / 2);
      const byte = Buffer.alloc(1);
      const read = await handle.read(byte, 0, 1, offset);
      if (read.bytesRead !== 1) {
        throw new KodaReleaseError("KODA_RELEASE_CORRUPTION_CHECK_FAILED");
      }
      byte[0] = byte[0]! ^ 0xff;
      await handle.write(byte, 0, 1, offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await verifyMacOSReleaseArtifact({
        archivePath: destination,
        metadataPath: options.metadataPath,
        skipSmoke: true,
      });
    } catch (error) {
      if (
        error instanceof KodaReleaseError &&
        error.code === "KODA_RELEASE_ARCHIVE_INTEGRITY_FAILED"
      ) {
        return;
      }
      throw new KodaReleaseError("KODA_RELEASE_CORRUPTION_CHECK_FAILED", {
        cause: error,
      });
    }
    throw new KodaReleaseError("KODA_RELEASE_CORRUPTION_CHECK_FAILED");
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function compareMacOSReleaseMetadataFiles(input: {
  arm64MetadataPath: string;
  x64MetadataPath: string;
}): Promise<MacOSReleaseSet> {
  try {
    const [arm64, x64] = await Promise.all([
      readMacOSReleaseMetadataDocument(input.arm64MetadataPath),
      readMacOSReleaseMetadataDocument(input.x64MetadataPath),
    ]);
    return compareMacOSReleaseMetadata({
      arm64: arm64.metadata,
      x64: x64.metadata,
      arm64MetadataSha256: arm64.sha256,
      x64MetadataSha256: x64.sha256,
    });
  } catch (error) {
    if (error instanceof KodaReleaseError) {
      throw error;
    }
    throw new KodaReleaseError("KODA_RELEASE_CONTRACT_MISMATCH", {
      cause: error,
    });
  }
}

export function validateMacOSArchiveEntries(
  listing: string,
): readonly string[] {
  if (Buffer.byteLength(listing, "utf8") > ARCHIVE_LIST_MAXIMUM_BYTES) {
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
  }
  const entries = listing.endsWith("\n")
    ? listing.slice(0, -1).split("\n")
    : listing.split("\n");
  if (
    entries.length < 1 ||
    entries.length > ARCHIVE_MAXIMUM_ENTRIES ||
    entries.some((entry) => entry.length === 0)
  ) {
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
  }
  let previous: string | undefined;
  for (const entry of entries) {
    if (
      /[\u0000-\u001f\u007f]/.test(entry) ||
      entry.includes("\\") ||
      !entry.startsWith("koda/") ||
      entry.endsWith("/") ||
      posix.normalize(entry) !== entry ||
      entry
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ) ||
      (previous !== undefined && entry <= previous)
    ) {
      throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
    }
    previous = entry;
  }
  return entries;
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function regularFile(path: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new Error("Expected a regular file.");
    }
    return realpath(path);
  } catch (error) {
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID", {
      cause: error,
    });
  }
}

async function realDirectory(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID");
  }
  return realpath(path);
}

async function runCapturedTool(
  command: string,
  args: readonly string[],
  cwd: string,
  maximumBytes: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, COPYFILE_DISABLE: "1", LANG: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID"));
      }
    }, TOOL_TIMEOUT_MS);
    timer.unref();
    const collect = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
    ): number => {
      const next = currentBytes + chunk.byteLength;
      if (next > maximumBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new KodaReleaseError("KODA_RELEASE_ARCHIVE_INVALID"));
      }
      chunks.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          code: signal === null ? (code ?? 1) : 1,
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        });
      }
    });
  });
}
