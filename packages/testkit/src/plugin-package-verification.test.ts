import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  cp,
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
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";

import { sha256CanonicalJson } from "@koda/agent-core";
import {
  runPluginInstallCommand,
  runPluginListCommand,
  runPluginPublishCatalogCommand,
  runPluginStateCommand,
  runPluginVerifyCommand,
} from "@koda/cli";
import {
  installManagedPluginPackage,
  installPluginFromCatalog,
  listManagedPlugins,
  loadPluginConfiguration,
  PluginTurnSession,
  rollbackManagedPlugin,
  setManagedPluginEnabled,
  updatePluginFromCatalog,
  verifySignedPluginCatalog,
  verifySignedPluginManifest,
  discoverPluginCatalog,
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
const managedProtocolScript = `import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url))).version;
const lines = createInterface({input:process.stdin});
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const result = request.method === 'initialize'
    ? {protocolVersion:1,plugin:{name:'Reviewer',version},contributions:{tools:[]}}
    : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
  if (request.method === 'shutdown') setImmediate(() => process.exit(0));
});\n`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("signed local plugin packages", () => {
  it("publishes only verified packages as a signed catalog", async () => {
    const fixture = await packageFixture();
    const root = join(fixture.parent, "catalog");
    await mkdir(join(root, "reviewer"), { recursive: true });
    await cp(fixture.root, join(root, "reviewer", "1.0.0"), {
      recursive: true,
    });
    const keyPath = join(fixture.parent, "publisher-private.pem");
    await writeFile(
      keyPath,
      fixture.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const output: string[] = [];
    const errors: string[] = [];
    const publish = () =>
      runPluginPublishCatalogCommand(
        root,
        {
          keyId: fixture.trust.keyId,
          privateKey: keyPath,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
        {
          environment: {},
          processDirectory: fixture.parent,
          stdout: { write: (text) => output.push(text) },
          stderr: { write: (text) => errors.push(text) },
        },
      );
    expect(await publish()).toBe(0);
    const first = await readFile(join(root, "catalog.json"));
    expect(
      verifySignedPluginCatalog(first, fixture.trust).packages,
    ).toMatchObject([{ id: "reviewer", version: "1.0.0" }]);
    expect(await publish()).toBe(0);
    const previous = await readFile(join(root, "catalog.json"));
    await chmod(keyPath, 0o644);
    expect(await publish()).toBe(1);
    expect(await readFile(join(root, "catalog.json"))).toEqual(previous);
    await chmod(keyPath, 0o600);
    await writeFile(join(root, "reviewer", "1.0.0", "index.mjs"), "changed");
    expect(await publish()).toBe(1);
    expect(await readFile(join(root, "catalog.json"))).toEqual(previous);
    expect(output.join("")).toContain("Published 1 signed plugin package");
    expect(errors.join("")).toContain("Plugin command failed");
  });

  it("validates a signed catalog and downloads a package through HTTPS", async () => {
    const fixture = await packageFixture("index.mjs", managedProtocolScript);
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    const manifestBytes = await readFile(join(fixture.root, "manifest.json"));
    const manifest = verifySignedPluginManifest(manifestBytes, fixture.trust);
    const signed = {
      schema_version: 1,
      generated_at: "2026-09-27T11:00:00.000Z",
      expires_at: "2026-09-28T11:00:00.000Z",
      packages: [
        {
          id: "reviewer",
          version: "1.0.0",
          manifest_path: "reviewer/1.0.0/manifest.json",
          manifest_sha256: manifest.manifestSha256,
        },
      ],
    };
    const catalogSignature = sign(
      null,
      Buffer.concat([
        Buffer.from("KODA_PLUGIN_CATALOG_V1\0"),
        Buffer.from(sha256CanonicalJson(signed), "hex"),
      ]),
      fixture.privateKey,
    ).toString("base64");
    const catalogBytes = Buffer.from(
      JSON.stringify({
        ...signed,
        signature: { key_id: fixture.trust.keyId, ed25519: catalogSignature },
      }),
    );
    expect(
      verifySignedPluginCatalog(catalogBytes, fixture.trust, now).packages,
    ).toMatchObject([{ id: "reviewer", version: "1.0.0" }]);
    expect(() =>
      verifySignedPluginCatalog(
        catalogBytes,
        fixture.trust,
        now + 3 * 24 * 60 * 60_000,
      ),
    ).toThrowError();
    const tampered = Buffer.from(
      catalogBytes.toString("utf8").replace("1.0.0", "1.0.1"),
    );
    expect(() =>
      verifySignedPluginCatalog(tampered, fixture.trust, now),
    ).toThrowError();

    const certificate = join(fixture.parent, "server.pem");
    const key = join(fixture.parent, "server-key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    const files = new Map([
      ["/catalog.json", catalogBytes],
      ["/reviewer/1.0.0/manifest.json", manifestBytes],
      [
        "/reviewer/1.0.0/index.mjs",
        await readFile(join(fixture.root, "index.mjs")),
      ],
    ]);
    const server = createServer(
      {
        cert: await readFile(certificate),
        key: await readFile(key),
      },
      (request, response) => {
        const body = files.get(request.url ?? "");
        response.writeHead(body === undefined ? 404 : 200);
        response.end(body);
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No HTTPS port");
      const catalogUrl = `https://127.0.0.1:${address.port}/catalog.json`;
      const ca = await readFile(certificate);
      expect(
        (
          await discoverPluginCatalog({
            catalogUrl,
            trustRoot: fixture.trust,
            ca,
            nowMs: now,
          })
        ).packages,
      ).toHaveLength(1);
      const home = join(fixture.parent, "home");
      const installed = await installPluginFromCatalog({
        catalogUrl,
        trustRoot: fixture.trust,
        kodaHome: home,
        id: "reviewer",
        version: "1.0.0",
        capabilities: ["tools"],
        ca,
        nowMs: now,
      });
      expect(installed).toMatchObject({ id: "reviewer", enabled: false });
      expect(installed.catalogSha256).toBe(
        sha256CanonicalJson(JSON.parse(catalogBytes.toString("utf8"))),
      );
      await rewriteVersion(fixture, "1.10.0");
      const nextManifestBytes = await readFile(
        join(fixture.root, "manifest.json"),
      );
      const nextManifest = verifySignedPluginManifest(
        nextManifestBytes,
        fixture.trust,
      );
      const nextSigned = {
        ...signed,
        packages: [
          ...signed.packages,
          {
            id: "reviewer",
            version: "1.10.0",
            manifest_path: "reviewer/1.10.0/manifest.json",
            manifest_sha256: nextManifest.manifestSha256,
          },
        ],
      };
      const nextSignature = sign(
        null,
        Buffer.concat([
          Buffer.from("KODA_PLUGIN_CATALOG_V1\0"),
          Buffer.from(sha256CanonicalJson(nextSigned), "hex"),
        ]),
        fixture.privateKey,
      ).toString("base64");
      files.set(
        "/catalog.json",
        Buffer.from(
          JSON.stringify({
            ...nextSigned,
            signature: { key_id: fixture.trust.keyId, ed25519: nextSignature },
          }),
        ),
      );
      files.set("/reviewer/1.10.0/manifest.json", nextManifestBytes);
      files.set(
        "/reviewer/1.10.0/index.mjs",
        await readFile(join(fixture.root, "index.mjs")),
      );
      const updated = await updatePluginFromCatalog({
        kodaHome: home,
        id: "reviewer",
        ca,
        nowMs: now,
      });
      expect(updated).toMatchObject({
        version: "1.10.0",
        previousVersion: "1.0.0",
        enabled: false,
      });
      expect(
        await updatePluginFromCatalog({
          kodaHome: home,
          id: "reviewer",
          ca,
          nowMs: now,
        }),
      ).toBeNull();
      files.set("/reviewer/1.0.0/index.mjs", Buffer.from("altered payload\n"));
      await expect(
        installPluginFromCatalog({
          catalogUrl,
          trustRoot: fixture.trust,
          kodaHome: join(fixture.parent, "rejected-home"),
          id: "reviewer",
          version: "1.0.0",
          capabilities: ["tools"],
          ca,
          nowMs: now,
        }),
      ).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
    const fixture = await packageFixture("index.mjs", managedProtocolScript);
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
    await setManagedPluginEnabled(home, "reviewer", true);
    await rewriteVersion(fixture, "1.2.0", "export default 1;\n");
    await expect(install()).rejects.toMatchObject({
      code: "PLUGIN_SERVER_EXITED",
    });
    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "1.1.0",
      previousVersion: "1.0.0",
      enabled: true,
    });
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
  content?: string,
): Promise<void> {
  const path = join(fixture.root, "manifest.json");
  const { signature: _oldSignature, ...signed } = JSON.parse(
    await readFile(path, "utf8"),
  );
  signed.version = version;
  if (content !== undefined) {
    const payload = Buffer.from(content);
    await writeFile(join(fixture.root, "index.mjs"), payload);
    signed.files[0].bytes = payload.length;
    signed.files[0].sha256 = createHash("sha256").update(payload).digest("hex");
  }
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
