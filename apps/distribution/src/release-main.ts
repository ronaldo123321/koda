#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  canonicalNodeReleaseProvenance,
  canonicalMacOSNotarizationEvidence,
  canonicalMacOSPublicReleaseProvenance,
  canonicalMacOSReleaseSet,
  KODA_VERSION,
  renderHomebrewFormula,
} from "@koda/distribution";

import {
  assertMacOSReleaseRejectsCorruption,
  compareMacOSReleaseMetadataFiles,
  KodaReleaseError,
  readMacOSReleaseMetadata,
  verifyMacOSReleaseArtifact,
} from "./release.js";
import {
  KodaReleaseSecurityError,
  verifyNodeReleaseProvenance,
} from "./release-security.js";
import {
  createMacOSNotarizationEvidence,
  createMacOSPublicReleaseProvenance,
} from "./release-public.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof KodaReleaseError) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof KodaReleaseSecurityError) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof Error) {
    process.stderr.write(
      "error [KODA_RELEASE_INVALID]: The macOS release command input is invalid.\n",
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (command === "version") {
    rejectUnknown(options, []);
    process.stdout.write(`${KODA_VERSION}\n`);
    return;
  }
  if (command === "verify-node") {
    rejectUnknown(options, ["--keyring", "--signed-inventory", "--output"]);
    const provenance = await verifyNodeReleaseProvenance({
      keyringPath: requiredPath(options, "--keyring"),
      signedInventoryPath: requiredPath(options, "--signed-inventory"),
    });
    const output = requiredPath(options, "--output");
    await writeNewFile(
      output,
      `${canonicalNodeReleaseProvenance(provenance)}\n`,
    );
    process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
    return;
  }
  if (command === "notarization") {
    rejectUnknown(options, [
      "--response",
      "--archive",
      "--metadata",
      "--codesign",
      "--bundle",
      "--output",
    ]);
    const evidence = await createMacOSNotarizationEvidence({
      responsePath: requiredPath(options, "--response"),
      archivePath: requiredPath(options, "--archive"),
      releaseMetadataPath: requiredPath(options, "--metadata"),
      codeSignatureEvidencePath: requiredPath(options, "--codesign"),
      bundleRoot: requiredPath(options, "--bundle"),
    });
    const output = requiredPath(options, "--output");
    await writeNewFile(
      output,
      `${canonicalMacOSNotarizationEvidence(evidence)}\n`,
    );
    process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
    return;
  }
  if (command === "provenance") {
    rejectUnknown(options, [
      "--repository",
      "--tag",
      "--workflow-run-id",
      "--workflow-run-attempt",
      "--node-provenance",
      "--release-set",
      "--formula",
      "--arm64-metadata",
      "--arm64-codesign",
      "--arm64-notarization",
      "--x64-metadata",
      "--x64-codesign",
      "--x64-notarization",
      "--output",
    ]);
    const runAttempt = Number(requiredValue(options, "--workflow-run-attempt"));
    const provenance = await createMacOSPublicReleaseProvenance({
      repository: requiredValue(options, "--repository"),
      tag: requiredValue(options, "--tag"),
      workflowRunId: requiredValue(options, "--workflow-run-id"),
      workflowRunAttempt: runAttempt,
      nodeProvenancePath: requiredPath(options, "--node-provenance"),
      releaseSetPath: requiredPath(options, "--release-set"),
      formulaPath: requiredPath(options, "--formula"),
      arm64: {
        releaseMetadataPath: requiredPath(options, "--arm64-metadata"),
        codeSignatureEvidencePath: requiredPath(options, "--arm64-codesign"),
        notarizationEvidencePath: requiredPath(options, "--arm64-notarization"),
      },
      x64: {
        releaseMetadataPath: requiredPath(options, "--x64-metadata"),
        codeSignatureEvidencePath: requiredPath(options, "--x64-codesign"),
        notarizationEvidencePath: requiredPath(options, "--x64-notarization"),
      },
    });
    const output = requiredPath(options, "--output");
    await writeNewFile(
      output,
      `${canonicalMacOSPublicReleaseProvenance(provenance)}\n`,
    );
    process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const archivePath = requiredPath(options, "--archive");
    const metadataPath = requiredPath(options, "--metadata");
    rejectUnknown(options, [
      "--archive",
      "--metadata",
      "--skip-smoke",
      "--corruption-check",
    ]);
    const skipSmoke = flag(options, "--skip-smoke");
    const corruptionCheck = flag(options, "--corruption-check");
    const result = await verifyMacOSReleaseArtifact({
      archivePath,
      metadataPath,
      ...(skipSmoke ? { skipSmoke: true } : {}),
    });
    if (corruptionCheck) {
      await assertMacOSReleaseRejectsCorruption({
        archivePath,
        metadataPath,
        skipSmoke: true,
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "compare") {
    rejectUnknown(options, ["--arm64-metadata", "--x64-metadata", "--output"]);
    const releaseSet = await compareMacOSReleaseMetadataFiles({
      arm64MetadataPath: requiredPath(options, "--arm64-metadata"),
      x64MetadataPath: requiredPath(options, "--x64-metadata"),
    });
    const output = optionalPath(options, "--output");
    const serialized = `${canonicalMacOSReleaseSet(releaseSet)}\n`;
    if (output === undefined) {
      process.stdout.write(serialized);
    } else {
      await writeNewFile(output, serialized);
      process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
    }
    return;
  }
  if (command === "formula") {
    rejectUnknown(options, [
      "--arm64-metadata",
      "--x64-metadata",
      "--repository",
      "--tag",
      "--output",
      "--arm64-url",
      "--x64-url",
    ]);
    const [arm64Metadata, x64Metadata] = await Promise.all([
      readMacOSReleaseMetadata(requiredPath(options, "--arm64-metadata")),
      readMacOSReleaseMetadata(requiredPath(options, "--x64-metadata")),
    ]);
    const arm64Url = optionalValue(options, "--arm64-url");
    const x64Url = optionalValue(options, "--x64-url");
    const formula = renderHomebrewFormula({
      arm64Metadata,
      x64Metadata,
      repository: requiredValue(options, "--repository"),
      tag: optionalValue(options, "--tag") ?? `v${arm64Metadata.version}`,
      ...(arm64Url === undefined ? {} : { arm64Url }),
      ...(x64Url === undefined ? {} : { x64Url }),
    });
    const output = requiredPath(options, "--output");
    await writeNewFile(output, formula);
    process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
    return;
  }
  throw new Error(
    "Expected release command version, verify-node, notarization, provenance, verify, compare, or formula.",
  );
}

function parseOptions(argv: readonly string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (!name.startsWith("--") || result.has(name)) {
      throw new Error("Invalid or duplicate release option.");
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result.set(name, true);
    } else {
      result.set(name, next);
      index += 1;
    }
  }
  return result;
}

function rejectUnknown(
  options: ReadonlyMap<string, string | true>,
  accepted: readonly string[],
): void {
  for (const name of options.keys()) {
    if (!accepted.includes(name)) {
      throw new Error("Unknown release option.");
    }
  }
}

function requiredValue(
  options: ReadonlyMap<string, string | true>,
  name: string,
): string {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

function optionalValue(
  options: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected a value for ${name}.`);
  }
  return value;
}

function flag(
  options: ReadonlyMap<string, string | true>,
  name: string,
): boolean {
  const value = options.get(name);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new Error(`Expected ${name} without a value.`);
  }
  return true;
}

function requiredPath(
  options: ReadonlyMap<string, string | true>,
  name: string,
): string {
  return resolve(requiredValue(options, name));
}

function optionalPath(
  options: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = optionalValue(options, name);
  return value === undefined ? undefined : resolve(value);
}

async function writeNewFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
}
