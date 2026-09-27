import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { pluginIdSchema } from "@koda/protocol";

import {
  pluginCatalogSigningPayload,
  verifySignedPluginCatalog,
  type VerifiedPluginCatalog,
} from "./catalog.js";
import { verifyLocalPluginPackage } from "./package-verification.js";

export async function buildSignedPluginCatalog(options: {
  rootDirectory: string;
  keyId: string;
  privateKeyPem: string;
  expiresAt: string;
  nowMs?: number;
}): Promise<{ bytes: Buffer; catalog: VerifiedPluginCatalog }> {
  let privateKey;
  try {
    privateKey = createPrivateKey(options.privateKeyPem);
    const canonical = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      options.privateKeyPem.replaceAll("\r\n", "\n").trimEnd() + "\n" !==
        canonical
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Publisher key must be one Ed25519 private PEM key.");
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (!(await lstat(options.rootDirectory)).isDirectory()) {
    throw new Error("Plugin catalog root must be a directory.");
  }
  const packages: {
    id: string;
    version: string;
    manifest_path: string;
    manifest_sha256: string;
  }[] = [];
  for (const plugin of await readdir(options.rootDirectory, {
    withFileTypes: true,
  })) {
    if (plugin.name === "catalog.json" && plugin.isFile()) continue;
    if (
      !plugin.isDirectory() ||
      !pluginIdSchema.safeParse(plugin.name).success
    ) {
      throw new Error("Plugin catalog root contains an unexpected entry.");
    }
    const versions = await readdir(join(options.rootDirectory, plugin.name), {
      withFileTypes: true,
    });
    if (versions.length === 0)
      throw new Error("Plugin catalog contains an empty plugin directory.");
    for (const version of versions) {
      if (!version.isDirectory())
        throw new Error("Plugin catalog contains an unexpected version entry.");
      const verified = await verifyLocalPluginPackage(
        join(options.rootDirectory, plugin.name, version.name),
        { keyId: options.keyId, publicKeyPem },
      );
      if (verified.id !== plugin.name || verified.version !== version.name) {
        throw new Error("Plugin directory does not match its signed manifest.");
      }
      packages.push({
        id: verified.id,
        version: verified.version,
        manifest_path: `${verified.id}/${verified.version}/manifest.json`,
        manifest_sha256: verified.manifestSha256,
      });
      if (packages.length > 256)
        throw new Error("Plugin catalog exceeds the package limit.");
    }
  }
  packages.sort((a, b) => {
    const left = `${a.id}\0${a.version}`;
    const right = `${b.id}\0${b.version}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const nowMs = options.nowMs ?? Date.now();
  const signed = {
    schema_version: 1,
    generated_at: new Date(nowMs).toISOString(),
    expires_at: options.expiresAt,
    packages,
  };
  const bytes = Buffer.from(
    `${JSON.stringify({
      ...signed,
      signature: {
        key_id: options.keyId,
        ed25519: sign(
          null,
          pluginCatalogSigningPayload(signed),
          privateKey,
        ).toString("base64"),
      },
    })}\n`,
  );
  return {
    bytes,
    catalog: verifySignedPluginCatalog(
      bytes,
      { keyId: options.keyId, publicKeyPem },
      nowMs,
    ),
  };
}
