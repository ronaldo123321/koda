#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleMacOSBundle,
  KodaBundleAssemblyError,
  type MacOSBundleArchitecture,
} from "./bundle.js";

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await assembleMacOSBundle(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        architecture: result.architecture,
        outputDirectory: result.outputDirectory,
        archivePath: result.archivePath,
        archiveSha256: result.archiveSha256,
        metadataPath: result.metadataPath,
        sourceCommit: result.sourceCommit,
        machOFiles: result.machOFiles,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (error instanceof KodaBundleAssemblyError) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

function parseArguments(argv: readonly string[]) {
  const repositoryRoot = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../..",
  );
  let outputDirectory = resolve(
    repositoryRoot,
    "dist",
    "release",
    process.arch,
  );
  let cacheDirectory = resolve(repositoryRoot, "dist", "cache", "node");
  let architecture: MacOSBundleArchitecture | undefined;
  let nodeArchivePath: string | undefined;
  let sourceCommit: string | undefined;
  let skipBuild = false;
  let skipSmoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") {
      continue;
    }
    if (option === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (option === "--skip-smoke") {
      skipSmoke = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
    }
    index += 1;
    if (option === "--output") {
      outputDirectory = resolve(repositoryRoot, value);
    } else if (option === "--cache") {
      cacheDirectory = resolve(repositoryRoot, value);
    } else if (option === "--node-archive") {
      nodeArchivePath = resolve(repositoryRoot, value);
    } else if (option === "--source-commit") {
      sourceCommit = value;
    } else if (option === "--arch" && (value === "arm64" || value === "x64")) {
      architecture = value;
    } else {
      throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
    }
  }
  return {
    repositoryRoot,
    outputDirectory,
    cacheDirectory,
    ...(architecture === undefined ? {} : { architecture }),
    ...(nodeArchivePath === undefined ? {} : { nodeArchivePath }),
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    ...(skipBuild ? { skipBuild: true } : {}),
    ...(skipSmoke ? { skipSmoke: true } : {}),
  };
}
