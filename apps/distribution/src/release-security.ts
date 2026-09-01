import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createNodeReleaseProvenance,
  EMBEDDED_NODE_RELEASE_SIGNER_FINGERPRINT,
  EMBEDDED_NODE_SIGNED_CHECKSUMS_SHA256,
  embeddedNodeArtifact,
  macOSCodeSignatureRecordSchema,
  NODE_RELEASE_KEYS_SHA256,
  parseNodeChecksumInventory,
  type MacOSCodeSignatureEvidence,
  type NodeReleaseProvenance,
} from "@koda/distribution";

import type { MacOSBundleArchitecture } from "./bundle.js";

const SECURITY_FILE_MAXIMUM_BYTES = 8 * 1_048_576;
const SECURITY_OUTPUT_MAXIMUM_BYTES = 1_048_576;
const SECURITY_TOOL_TIMEOUT_MS = 120_000;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

export type MacOSCodeSignatureRecord =
  MacOSCodeSignatureEvidence["files"][number];

export type MacOSReleaseSecurityErrorCode =
  | "KODA_NODE_SIGNATURE_INVALID"
  | "KODA_CODE_SIGNING_INVALID"
  | "KODA_GATEKEEPER_REJECTED";

const SECURITY_MESSAGES: Readonly<
  Record<MacOSReleaseSecurityErrorCode, string>
> = {
  KODA_NODE_SIGNATURE_INVALID:
    "The embedded Node.js checksum inventory failed its pinned OpenPGP provenance check.",
  KODA_CODE_SIGNING_INVALID:
    "The macOS release code signature is absent or violates the signing contract.",
  KODA_GATEKEEPER_REJECTED:
    "Gatekeeper rejected one or more notarized macOS release executables.",
};

export class KodaReleaseSecurityError extends Error {
  public constructor(
    public readonly code: MacOSReleaseSecurityErrorCode,
    options?: ErrorOptions,
  ) {
    super(SECURITY_MESSAGES[code], options);
    this.name = "KodaReleaseSecurityError";
  }
}

export async function verifyNodeReleaseProvenance(options: {
  readonly keyringPath: string;
  readonly signedInventoryPath: string;
  readonly gpgvPath?: string;
}): Promise<NodeReleaseProvenance> {
  const scratch = await mkdtemp("/private/tmp/koda-node-provenance-");
  try {
    const keyringPath = await boundedRegularFile(
      options.keyringPath,
      SECURITY_FILE_MAXIMUM_BYTES,
    );
    const signedInventoryPath = await boundedRegularFile(
      options.signedInventoryPath,
      SECURITY_FILE_MAXIMUM_BYTES,
    );
    const [keyringSha256, signedInventorySha256] = await Promise.all([
      sha256File(keyringPath),
      sha256File(signedInventoryPath),
    ]);
    if (
      keyringSha256 !== NODE_RELEASE_KEYS_SHA256 ||
      signedInventorySha256 !== EMBEDDED_NODE_SIGNED_CHECKSUMS_SHA256
    ) {
      throw new KodaReleaseSecurityError("KODA_NODE_SIGNATURE_INVALID");
    }

    const inventoryPath = join(scratch, "SHASUMS256.txt");
    const result = await runCapturedTool(
      options.gpgvPath ?? "gpgv",
      [
        "--keyring",
        keyringPath,
        "--status-fd",
        "1",
        "--output",
        inventoryPath,
        signedInventoryPath,
      ],
      scratch,
    );
    const validFingerprints = [
      ...result.stdout.matchAll(/^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})\b/gm),
    ].map((match) => match[1]);
    if (
      result.code !== 0 ||
      validFingerprints.length !== 1 ||
      validFingerprints[0] !== EMBEDDED_NODE_RELEASE_SIGNER_FINGERPRINT
    ) {
      throw new KodaReleaseSecurityError("KODA_NODE_SIGNATURE_INVALID");
    }
    const inventory = await readFile(inventoryPath, "utf8");
    for (const architecture of ["arm64", "x64"] as const) {
      const artifact = embeddedNodeArtifact(architecture);
      if (
        parseNodeChecksumInventory(inventory, artifact.archive) !==
        artifact.sha256
      ) {
        throw new KodaReleaseSecurityError("KODA_NODE_SIGNATURE_INVALID");
      }
    }
    return createNodeReleaseProvenance(signedInventorySha256);
  } catch (error) {
    if (error instanceof KodaReleaseSecurityError) {
      throw error;
    }
    throw new KodaReleaseSecurityError("KODA_NODE_SIGNATURE_INVALID", {
      cause: error,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function signMacOSNativeFiles(options: {
  readonly bundleRoot: string;
  readonly architecture: MacOSBundleArchitecture;
  readonly nativeFiles: readonly string[];
  readonly identity: string;
  readonly teamId: string;
}): Promise<readonly MacOSCodeSignatureRecord[]> {
  if (
    process.platform !== "darwin" ||
    process.arch !== options.architecture ||
    !TEAM_ID_PATTERN.test(options.teamId) ||
    options.identity.length < 1 ||
    options.identity.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(options.identity)
  ) {
    throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID");
  }
  const plan = signingPlan(options.architecture, options.nativeFiles);
  try {
    for (const item of plan) {
      const absolute = join(options.bundleRoot, ...item.path.split("/"));
      const result = await runCapturedTool(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          options.identity,
          "--options",
          "runtime",
          "--timestamp",
          "--identifier",
          item.identifier,
          absolute,
        ],
        options.bundleRoot,
      );
      if (result.code !== 0) {
        throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID");
      }
    }
    return auditMacOSCodeSignatures({
      bundleRoot: options.bundleRoot,
      architecture: options.architecture,
      nativeFiles: options.nativeFiles,
      teamId: options.teamId,
    });
  } catch (error) {
    if (error instanceof KodaReleaseSecurityError) {
      throw error;
    }
    throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID", {
      cause: error,
    });
  }
}

export async function auditMacOSCodeSignatures(options: {
  readonly bundleRoot: string;
  readonly architecture: MacOSBundleArchitecture;
  readonly nativeFiles: readonly string[];
  readonly teamId: string;
}): Promise<readonly MacOSCodeSignatureRecord[]> {
  if (!TEAM_ID_PATTERN.test(options.teamId)) {
    throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID");
  }
  const plan = signingPlan(options.architecture, options.nativeFiles).sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const records: MacOSCodeSignatureRecord[] = [];
  try {
    for (const item of plan) {
      const absolute = join(options.bundleRoot, ...item.path.split("/"));
      const verification = await runCapturedTool(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--verbose=4", absolute],
        options.bundleRoot,
      );
      const description = await runCapturedTool(
        "/usr/bin/codesign",
        ["-d", "--verbose=4", absolute],
        options.bundleRoot,
      );
      const output = `${description.stdout}\n${description.stderr}`;
      const identifier = /^Identifier=(.+)$/m.exec(output)?.[1];
      const teamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
      const cdhash = /^CandidateCDHashFull sha256=([0-9a-f]{64})$/m.exec(
        output,
      )?.[1];
      const flags = /^CodeDirectory .+ flags=.+\(([^)]+)\)/m.exec(output)?.[1];
      if (
        verification.code !== 0 ||
        description.code !== 0 ||
        identifier !== item.identifier ||
        teamId !== options.teamId ||
        cdhash === undefined ||
        flags?.split(",").includes("runtime") !== true ||
        flags
          .split(",")
          .some((flag) => flag === "adhoc" || flag === "linker-signed") ||
        !/^Timestamp=.+$/m.test(output) ||
        !/^Authority=Developer ID Application:/m.test(output)
      ) {
        throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID");
      }
      records.push(
        macOSCodeSignatureRecordSchema.parse({
          path: item.path,
          role: item.role,
          identifier,
          team_id: teamId,
          cdhash_sha256: cdhash,
          hardened_runtime: true,
          secure_timestamp: true,
        }),
      );
    }
    return records;
  } catch (error) {
    if (error instanceof KodaReleaseSecurityError) {
      throw error;
    }
    throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID", {
      cause: error,
    });
  }
}

export async function assessMacOSGatekeeper(options: {
  readonly bundleRoot: string;
  readonly signedFiles: readonly MacOSCodeSignatureRecord[];
}): Promise<readonly string[]> {
  const assessed: string[] = [];
  try {
    for (const file of options.signedFiles) {
      const absolute = join(options.bundleRoot, ...file.path.split("/"));
      if (!(await assessGatekeeperFile(absolute, options.bundleRoot))) {
        throw new KodaReleaseSecurityError("KODA_GATEKEEPER_REJECTED");
      }
      assessed.push(file.path);
    }
    assessed.sort((left, right) => left.localeCompare(right));
    return assessed;
  } catch (error) {
    if (error instanceof KodaReleaseSecurityError) {
      throw error;
    }
    throw new KodaReleaseSecurityError("KODA_GATEKEEPER_REJECTED", {
      cause: error,
    });
  }
}

async function assessGatekeeperFile(
  absolute: string,
  cwd: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = await runCapturedTool(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=4", absolute],
      cwd,
    );
    if (result.code === 0) {
      return true;
    }
    if (attempt < 6) {
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 2_000);
      });
    }
  }
  return false;
}

function signingPlan(
  architecture: MacOSBundleArchitecture,
  nativeFiles: readonly string[],
): Array<{
  path: string;
  role: MacOSCodeSignatureRecord["role"];
  identifier: string;
}> {
  const expected = [
    {
      path: `libexec/koda/app/node_modules/better-sqlite3/prebuilds/darwin-${architecture}.node`,
      role: "native_addon" as const,
      identifier: "dev.koda.cli.addon.better-sqlite3",
    },
    {
      path: "libexec/koda/native/koda-exec",
      role: "native_executor" as const,
      identifier: "dev.koda.cli.native.koda-exec",
    },
    {
      path: "libexec/koda/node/bin/node",
      role: "embedded_node" as const,
      identifier: "dev.koda.cli.node",
    },
  ];
  if (
    JSON.stringify(
      [...nativeFiles].sort((left, right) => left.localeCompare(right)),
    ) !==
    JSON.stringify(
      expected
        .map((item) => item.path)
        .sort((left, right) => left.localeCompare(right)),
    )
  ) {
    throw new KodaReleaseSecurityError("KODA_CODE_SIGNING_INVALID");
  }
  // Sign leaf add-ons first, followed by Koda's executable and the embedded runtime.
  return expected;
}

async function boundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error("Expected a bounded regular file.");
  }
  return realpath(path);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function runCapturedTool(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, LANG: "C" },
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
        reject(new Error("Release security tool timed out."));
      }
    }, SECURITY_TOOL_TIMEOUT_MS);
    timer.unref();
    const append = (chunks: Buffer[], current: number, chunk: Buffer) => {
      const next = current + chunk.byteLength;
      if (next > SECURITY_OUTPUT_MAXIMUM_BYTES && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("Release security tool output exceeded its limit."));
      }
      chunks.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, stderrBytes, chunk);
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
        if (signal !== null) {
          reject(new Error("Release security tool was terminated."));
        } else {
          resolvePromise({
            code: code ?? 1,
            stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
            stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
          });
        }
      }
    });
  });
}
