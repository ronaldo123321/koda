#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  hashRegularPackage,
  signedMessage,
} from "./update-metadata-contract.mjs";

const [
  publicKeyPath,
  version,
  sourceCommit,
  arm64Package,
  arm64Metadata,
  x64Package,
  x64Metadata,
] = process.argv.slice(2);
if (
  !x64Metadata ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(version) ||
  !/^[a-f0-9]{40}$/.test(sourceCommit)
) {
  throw new Error(
    "Usage: verify-update-assets.mjs PUBLIC_KEY_BASE64 VERSION COMMIT ARM64_PKG ARM64_JSON X64_PKG X64_JSON",
  );
}
const encodedKey = (await readFile(publicKeyPath, "utf8")).trim();
const keyBytes = Buffer.from(encodedKey, "base64");
if (keyBytes.length !== 32 || keyBytes.toString("base64") !== encodedKey) {
  throw new Error("The pinned update public key is invalid.");
}
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    keyBytes,
  ]),
  format: "der",
  type: "spki",
});
const fields = [
  "architecture",
  "package_name",
  "package_sha256",
  "package_size",
  "schema_version",
  "signature",
  "source_commit",
  "version",
];

async function check(architecture, packagePath, metadataPath) {
  const name = `Koda-v${version}-darwin-${architecture}`;
  if (
    basename(packagePath) !== `${name}.pkg` ||
    basename(metadataPath) !== `${name}.update.json`
  ) {
    throw new Error(
      `${architecture} asset names do not match the release identity.`,
    );
  }
  const file = await open(
    metadataPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let metadata;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 8_192) {
      throw new Error(
        `${architecture} update metadata is not a bounded regular file.`,
      );
    }
    metadata = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  if (
    JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(fields) ||
    metadata.schema_version !== 1 ||
    metadata.version !== version ||
    metadata.architecture !== architecture ||
    metadata.source_commit !== sourceCommit ||
    metadata.package_name !== `${name}.pkg` ||
    !Number.isInteger(metadata.package_size) ||
    metadata.package_size <= 0 ||
    metadata.package_size > 2_000_000_000 ||
    typeof metadata.package_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.package_sha256) ||
    typeof metadata.signature !== "string"
  ) {
    throw new Error(
      `${architecture} update metadata does not match the release.`,
    );
  }
  const signature = Buffer.from(metadata.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== metadata.signature ||
    !verify(null, signedMessage(metadata), publicKey, signature)
  ) {
    throw new Error(`${architecture} update signature is invalid.`);
  }
  const packageDigest = await hashRegularPackage(packagePath);
  if (
    packageDigest.size !== metadata.package_size ||
    packageDigest.sha256 !== metadata.package_sha256
  ) {
    throw new Error(
      `${architecture} package does not match signed update metadata.`,
    );
  }
  return { architecture, ...packageDigest };
}

const arm64 = await check("arm64", arm64Package, arm64Metadata);
const x64 = await check("x64", x64Package, x64Metadata);
process.stdout.write(
  JSON.stringify({ version, source_commit: sourceCommit, arm64, x64 }) + "\n",
);
