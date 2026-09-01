#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KODA_VERSION,
  KodaDistributionError,
  KodaPreviewError,
} from "@koda/distribution";

import { KodaBundleAssemblyError } from "./bundle.js";
import {
  defaultMacOSPreviewPaths,
  inspectMacOSPreview,
  installMacOSPreview,
  rollbackMacOSPreview,
  uninstallMacOSPreview,
  type MacOSPreviewStatus,
} from "./preview.js";
import { KodaReleaseError } from "./release.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof KodaPreviewError ||
    error instanceof KodaDistributionError ||
    error instanceof KodaReleaseError ||
    error instanceof KodaBundleAssemblyError
  ) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      "error [KODA_PREVIEW_INVALID]: The macOS preview command input is invalid.\n",
    );
    process.exitCode = 2;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  const paths = defaultMacOSPreviewPaths({
    homeDirectory: homedir(),
    environment: process.env,
  });
  const json = options.delete("--json") === true;
  let result: MacOSPreviewStatus;
  if (command === "install") {
    const defaults = defaultArtifacts();
    const archive = optionPath(options, "--archive") ?? defaults.archive;
    result = await installMacOSPreview({
      paths,
      archivePath: archive,
      metadataPath:
        optionPath(options, "--metadata") ??
        (archive === defaults.archive
          ? defaults.metadata
          : siblingMetadataPath(archive)),
    });
  } else if (command === "status") {
    rejectOptions(options);
    result = await inspectMacOSPreview(paths, { runDoctor: true });
  } else if (command === "rollback") {
    rejectOptions(options);
    result = await rollbackMacOSPreview({ paths });
  } else if (command === "uninstall") {
    const confirmed = options.delete("--yes") === true;
    rejectOptions(options);
    result = await uninstallMacOSPreview({ paths, confirmed });
  } else {
    throw new Error("Expected install, status, rollback, or uninstall.");
  }
  process.stdout.write(
    json ? `${JSON.stringify(result)}\n` : renderStatus(result),
  );
}

function defaultArtifacts(): { archive: string; metadata: string } {
  const repositoryRoot = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../..",
  );
  const directory = resolve(repositoryRoot, "dist", "release", process.arch);
  const stem = `koda-v${KODA_VERSION}-darwin-${process.arch}`;
  return {
    archive: resolve(directory, `${stem}.tar.gz`),
    metadata: resolve(directory, `${stem}.release.json`),
  };
}

function renderStatus(status: MacOSPreviewStatus): string {
  const active = status.active?.identity ?? "none";
  const previous = status.previous?.identity ?? "none";
  return [
    `Koda preview ${status.status}`,
    `active:   ${active}`,
    `previous: ${previous}`,
    `arch:     ${status.active?.arch ?? process.arch}`,
    `bin:      ${status.bin_directory}/koda`,
    `doctor:   ${status.doctor}`,
    "signing:  unsigned internal preview",
    status.recovery_pending ? "recovery: pending" : "recovery: none",
    ...(status.bin_on_path
      ? []
      : [
          `PATH:     add ${status.bin_directory} to invoke koda without an absolute path`,
        ]),
    "",
  ].join("\n");
}

function siblingMetadataPath(archive: string): string {
  const name = basename(archive);
  const stem = name.endsWith(".tar.gz")
    ? name.slice(0, -".tar.gz".length)
    : name.endsWith(".zip")
      ? name.slice(0, -".zip".length)
      : name;
  return resolve(dirname(archive), `${stem}.release.json`);
}

function parseOptions(argv: readonly string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--json" || name === "--yes") {
      result.set(name, true);
      continue;
    }
    if (name !== "--archive" && name !== "--metadata") {
      throw new Error("Unknown preview option.");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Missing preview option value.");
    }
    result.set(name, value);
    index += 1;
  }
  return result;
}

function optionPath(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  options.delete(name);
  return typeof value === "string" ? resolve(value) : undefined;
}

function rejectOptions(options: Map<string, string | true>): void {
  if (options.size > 0) {
    throw new Error("Unexpected preview options.");
  }
}
