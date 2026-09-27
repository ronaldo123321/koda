#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

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
const packageFile = await open(
  packagePath,
  constants.O_RDONLY | constants.O_NOFOLLOW,
);
let packageSize;
let packageSha256;
try {
  const before = await packageFile.stat();
  if (!before.isFile() || before.size <= 0 || before.size > 2_000_000_000) {
    throw new Error(
      "Package must be a regular file within the update size limit.",
    );
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await packageFile.read(
      buffer,
      0,
      buffer.length,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset > before.size) throw new Error("Package changed while hashing.");
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await packageFile.stat();
  if (
    offset !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino
  ) {
    throw new Error("Package changed while hashing.");
  }
  packageSize = offset;
  packageSha256 = hash.digest("hex");
} finally {
  await packageFile.close();
}
const message = `KODA_GUI_UPDATE_V1\n${version}\n${architecture}\n${sourceCommit}\n${packageName}\n${packageSize}\n${packageSha256}\n`;
const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString(
  "base64",
);
const metadata = {
  schema_version: 1,
  version,
  architecture,
  source_commit: sourceCommit,
  package_name: packageName,
  package_size: packageSize,
  package_sha256: packageSha256,
  signature,
};
await writeFile(outputPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
