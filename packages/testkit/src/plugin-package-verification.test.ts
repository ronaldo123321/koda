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
import {
  runPluginInstallCommand,
  runPluginListCommand,
  runPluginStateCommand,
  runPluginVerifyCommand,
} from "@koda/cli";
import {
  installManagedPluginPackage,
  listManagedPlugins,
  loadPluginConfiguration,
  PluginTurnSession,
  rollbackManagedPlugin,
  setManagedPluginEnabled,
  verifyLocalPluginPackage,
} from "@koda/plugin-host-node";
import {
  ArtifactStore,
  ProjectCommandTemplateCatalog,
  ProjectSkillCatalog,
} from "@koda/runtime-node";
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
  it("launches an enabled signed package through the plugin protocol", async () => {
    const script = `import { createInterface } from 'node:readline';
const lines = createInterface({input:process.stdin});
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const result = request.method === 'initialize'
    ? {protocolVersion:1,plugin:{name:'Reviewer',version:'1.0.0'},contributions:{tools:[]}}
    : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
  if (request.method === 'shutdown') setImmediate(() => process.exit(0));
});\n`;
    const fixture = await packageFixture("index.mjs", script);
    const home = join(fixture.parent, "home");
    await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["tools"],
    });
    await setManagedPluginEnabled(home, "reviewer", true);
    const session = await PluginTurnSession.open({
      environment: {},
      kodaHome: home,
      processDirectory: fixture.parent,
      artifactStore: await ArtifactStore.open(
        join(fixture.parent, "artifacts"),
      ),
      projectSkills: new ProjectSkillCatalog([]),
      projectCommandTemplates: new ProjectCommandTemplateCatalog([]),
      signal: new AbortController().signal,
    });
    expect(session.snapshots).toMatchObject([
      { pluginId: "reviewer", version: "1.0.0" },
    ]);
    await session.close();
  });

  it("installs disabled, verifies before launch, and rolls back to the previous signed version", async () => {
    const fixture = await packageFixture();
    const home = join(fixture.parent, "home");
    const install = () =>
      installManagedPluginPackage({
        kodaHome: home,
        sourceDirectory: fixture.root,
        trustRoot: fixture.trust,
        capabilities: ["tools"],
      });
    const first = await install();
    expect(first).toMatchObject({
      id: "reviewer",
      version: "1.0.0",
      enabled: false,
    });
    expect(
      (
        await loadPluginConfiguration({
          environment: {},
          kodaHome: home,
          processDirectory: fixture.parent,
        })
      ).plugins,
    ).toEqual([]);
    await setManagedPluginEnabled(home, "reviewer", true);
    const loaded = await loadPluginConfiguration({
      environment: {},
      kodaHome: home,
      processDirectory: fixture.parent,
    });
    expect(loaded.plugins).toMatchObject([
      { id: "reviewer", command: process.execPath },
    ]);
    expect(loaded.plugins[0]?.args[0]).toContain(
      "managed-plugins/packages/reviewer/",
    );

    const changedReview = await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["skills"],
    });
    expect(changedReview.enabled).toBe(false);
    await setManagedPluginEnabled(home, "reviewer", true);

    await rewriteVersion(fixture, "1.1.0");
    const second = await install();
    expect(second).toMatchObject({
      version: "1.1.0",
      previousVersion: "1.0.0",
      enabled: false,
    });
    expect((await listManagedPlugins(home))[0]).toMatchObject(second);
    const restored = await rollbackManagedPlugin(home, "reviewer");
    expect(restored).toMatchObject({
      version: "1.0.0",
      previousVersion: "1.1.0",
      enabled: false,
    });
    await setManagedPluginEnabled(home, "reviewer", true);
    const installedPayload = join(
      home,
      "managed-plugins",
      "packages",
      "reviewer",
      restored.manifestSha256,
      "index.mjs",
    );
    await writeFile(installedPayload, "tampered");
    await expect(
      loadPluginConfiguration({
        environment: {},
        kodaHome: home,
        processDirectory: fixture.parent,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" });
  });

  it("rejects a manual configuration that shadows an enabled managed plugin", async () => {
    const fixture = await packageFixture();
    const home = join(fixture.parent, "home");
    await mkdir(home);
    await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["tools"],
    });
    await setManagedPluginEnabled(home, "reviewer", true);
    await writeFile(
      join(home, "plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: { reviewer: { command: "node", capabilities: ["tools"] } },
      }),
    );
    await expect(
      loadPluginConfiguration({
        environment: {},
        kodaHome: home,
        processDirectory: fixture.parent,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFIGURATION_INVALID" });
  });

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
    const context = {
      environment: { KODA_HOME: join(fixture.parent, "home") },
      processDirectory: fixture.parent,
      stdout: { write: (text: string) => output.push(text) },
      stderr: { write: (text: string) => errors.push(text) },
    };
    expect(
      await runPluginInstallCommand(
        fixture.root,
        {
          keyId: fixture.trust.keyId,
          key: keyPath,
          capabilities: "tools",
        },
        context,
      ),
    ).toBe(0);
    expect(await runPluginStateCommand("reviewer", "enable", context)).toBe(0);
    expect(await runPluginListCommand(context)).toBe(0);
    expect(output.join("")).toContain("reviewer\t1.0.0\tenabled");
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
    await expect(
      verifyLocalPluginPackage(fixture.root, {
        keyId: "publisher",
        publicKeyPem: other.privateKey
          .export({ type: "pkcs8", format: "pem" })
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

async function packageFixture(
  filePath = "index.mjs",
  content = "export default 1;\n",
) {
  const parent = await mkdtemp(join(tmpdir(), "koda-plugin-package-"));
  directories.push(parent);
  const root = join(parent, "package");
  await mkdir(root);
  const payload = Buffer.from(content);
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
    privateKey: keys.privateKey,
    trust: {
      keyId: "publisher",
      publicKeyPem: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  };
}

async function rewriteVersion(
  fixture: Awaited<ReturnType<typeof packageFixture>>,
  version: string,
): Promise<void> {
  const path = join(fixture.root, "manifest.json");
  const { signature: _oldSignature, ...signed } = JSON.parse(
    await readFile(path, "utf8"),
  );
  signed.version = version;
  const digest = Buffer.from(sha256CanonicalJson(signed), "hex");
  const signature = sign(
    null,
    Buffer.concat([domain, digest]),
    fixture.privateKey,
  ).toString("base64");
  await writeFile(
    path,
    JSON.stringify({
      ...signed,
      signature: { key_id: fixture.trust.keyId, ed25519: signature },
    }),
  );
}
