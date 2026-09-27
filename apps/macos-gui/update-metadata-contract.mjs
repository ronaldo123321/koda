import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export function signedMessage(metadata) {
  const {
    version,
    architecture,
    source_commit: sourceCommit,
    package_name: packageName,
    package_size: packageSize,
    package_sha256: packageSha256,
  } = metadata;
  return Buffer.from(
    `KODA_GUI_UPDATE_V1\n${version}\n${architecture}\n${sourceCommit}\n${packageName}\n${packageSize}\n${packageSha256}\n`,
    "utf8",
  );
}

export async function hashRegularPackage(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 2_000_000_000) {
      throw new Error(
        "Package must be a regular file within the update size limit.",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > before.size)
        throw new Error("Package changed while hashing.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    ) {
      throw new Error("Package changed while hashing.");
    }
    return { size: offset, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
