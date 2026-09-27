#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  hashRegularPackage,
  signedMessage,
} from "./update-metadata-contract.mjs";

const [
  packagePath,
  version,
  architecture,
  sourceCommit,
  privateKeyPath,
  publicKeyPath,
  outputPath,
] = process.argv.slice(2);
if (
  !outputPath ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(version) ||
  !["arm64", "x64"].includes(architecture) ||
  !/^[a-f0-9]{40}$/.test(sourceCommit)
) {
  throw new Error(
    "Usage: sign-update-metadata.mjs PACKAGE VERSION ARCH COMMIT PRIVATE_KEY PUBLIC_KEY_BASE64 OUTPUT",
  );
}
const packageName = `Koda-v${version}-darwin-${architecture}.pkg`;
if (basename(packagePath) !== packageName)
  throw new Error("Package name does not match the release identity.");
const privateKey = createPrivateKey(await readFile(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519")
  throw new Error("An Ed25519 signing key is required.");
const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
const actualPublicKey = Buffer.from(publicKey.x, "base64url");
const expectedPublicKey = Buffer.from(
  (await readFile(publicKeyPath, "utf8")).trim(),
  "base64",
);
if (
  actualPublicKey.length !== 32 ||
  !actualPublicKey.equals(expectedPublicKey)
) {
  throw new Error("Update signing key does not match the pinned public key.");
}
const { size: packageSize, sha256: packageSha256 } =
  await hashRegularPackage(packagePath);
const metadata = {
  schema_version: 1,
  version,
  architecture,
  source_commit: sourceCommit,
  package_name: packageName,
  package_size: packageSize,
  package_sha256: packageSha256,
};
metadata.signature = sign(null, signedMessage(metadata), privateKey).toString(
  "base64",
);
await writeFile(outputPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
