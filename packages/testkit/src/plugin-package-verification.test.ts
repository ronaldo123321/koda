import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256CanonicalJson } from "@koda/agent-core";
import { runPluginVerifyCommand } from "@koda/cli";
import { verifyLocalPluginPackage } from "@koda/plugin-host-node";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const domain = Buffer.from("KODA_PLUGIN_MANIFEST_V1\0", "utf8");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("signed local plugin packages", () => {
  it("exposes verification through the CLI without executing the plugin", async () => {
    const fixture = await packageFixture();
    const keyPath = join(fixture.parent, "publisher.pem");
    await writeFile(keyPath, fixture.trust.publicKeyPem);
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runPluginVerifyCommand(
      fixture.root,
      {
        keyId: fixture.trust.keyId,
        key: keyPath,
      },
      {
        processDirectory: fixture.parent,
        stdout: { write: (text) => output.push(text) },
        stderr: { write: (text) => errors.push(text) },
      },
    );
    expect(code).toBe(0);
    expect(output.join("")).toContain("Verified reviewer@1.0.0");
    expect(errors).toEqual([]);
  });

  it("accepts an exact signed inventory and rejects altered bytes or extra files", async () => {
    const fixture = await packageFixture();
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).resolves.toMatchObject({
      id: "reviewer",
      version: "1.0.0",
      entrypoint: "index.mjs",
      keyId: "publisher",
    });
    await writeFile(join(fixture.root, "index.mjs"), "different content");
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    await writeFile(join(fixture.root, "index.mjs"), "export default 1;\n");
    await writeFile(join(fixture.root, "extra.mjs"), "unlisted");
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
  });

  it("rejects a different trust root, a symlink, and a hard link", async () => {
    const fixture = await packageFixture();
    const other = generateKeyPairSync("ed25519");
    await expect(
      verifyLocalPluginPackage(fixture.root, {
        keyId: "publisher",
        publicKeyPem: other.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" });
    const payload = join(fixture.root, "index.mjs");
    const outside = join(fixture.parent, "outside.mjs");
    await writeFile(outside, await readFile(payload));
    await rm(payload);
    await symlink(outside, payload);
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    await rm(payload);
    await link(outside, payload);
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
  });

  it("rejects a signed manifest that escapes its package directory", async () => {
    const fixture = await packageFixture("../outside.mjs");
    await expect(
      verifyLocalPluginPackage(fixture.root, fixture.trust),
    ).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
  });
});

async function packageFixture(filePath = "index.mjs") {
  const parent = await mkdtemp(join(tmpdir(), "koda-plugin-package-"));
  directories.push(parent);
  const root = join(parent, "package");
  await mkdir(root);
  const payload = Buffer.from("export default 1;\n");
  if (filePath === "index.mjs") await writeFile(join(root, filePath), payload);
  const keys = generateKeyPairSync("ed25519");
  const signed = {
    schema_version: 1,
    id: "reviewer",
    version: "1.0.0",
    entrypoint: filePath,
    files: [
      {
        path: filePath,
        bytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };
  const digest = Buffer.from(sha256CanonicalJson(signed), "hex");
  const signature = sign(
    null,
    Buffer.concat([domain, digest]),
    keys.privateKey,
  ).toString("base64");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      ...signed,
      signature: { key_id: "publisher", ed25519: signature },
    }),
  );
  return {
    root,
    parent,
    trust: {
      keyId: "publisher",
      publicKeyPem: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  };
}
