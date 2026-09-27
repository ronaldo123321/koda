import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
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
  readManagedPluginUpdateSource,
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
  it("rejects a stale update after an owner changes the installed plugin", async () => {
    const fixture = await packageFixture("index.mjs", managedProtocolScript);
    const home = join(fixture.parent, "home");
    const install = (expectedStateSha256?: string) =>
      installManagedPluginPackage({
        kodaHome: home,
        sourceDirectory: fixture.root,
        trustRoot: fixture.trust,
        capabilities: ["tools"],
        provenance: {
          catalogUrl: "https://plugins.example/catalog.json",
          catalogSha256: "a".repeat(64),
          manifestPath: "reviewer/manifest.json",
        },
        ...(expectedStateSha256 === undefined ? {} : { expectedStateSha256 }),
      });
    await install();
    const stale = await readManagedPluginUpdateSource(home, "reviewer");
    await rewriteVersion(fixture, "2.0.0");
    await install();
    await rewriteVersion(fixture, "1.5.0");
    await expect(install(stale.stateSha256)).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "2.0.0",
      enabled: false,
    });

    const beforeEnable = await readManagedPluginUpdateSource(home, "reviewer");
    await setManagedPluginEnabled(home, "reviewer", true);
    await rewriteVersion(fixture, "3.0.0");
    await expect(install(beforeEnable.stateSha256)).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "2.0.0",
      enabled: true,
    });
  });

  it("refuses to replace a tampered active package silently", async () => {
    const fixture = await packageFixture("index.mjs", managedProtocolScript);
    const home = join(fixture.parent, "home");
    const first = await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["tools"],
    });
    await writeFile(
      join(
        home,
        "managed-plugins",
        "packages",
        "reviewer",
        first.manifestSha256,
        "index.mjs",
      ),
      "tampered",
    );
    await rewriteVersion(fixture, "2.0.0");
    await expect(
      installManagedPluginPackage({
        kodaHome: home,
        sourceDirectory: fixture.root,
        trustRoot: fixture.trust,
        capabilities: ["tools"],
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" });
    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "1.0.0",
      manifestSha256: first.manifestSha256,
    });
  });

  it("rotates only with the expected old key and drops old-key rollback", async () => {
    const old = await packageFixture("index.mjs", managedProtocolScript);
    const next = await packageFixture(
      "index.mjs",
      managedProtocolScript,
      "new-publisher",
    );
    await rewriteVersion(next, "2.0.0");
    const home = join(old.parent, "home");
    await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: old.root,
      trustRoot: old.trust,
      capabilities: ["tools"],
    });
    await setManagedPluginEnabled(home, "reviewer", true);
    const rotate = (previousTrustRoot?: typeof old.trust) =>
      installManagedPluginPackage({
        kodaHome: home,
        sourceDirectory: next.root,
        trustRoot: next.trust,
        capabilities: ["tools"],
        ...(previousTrustRoot === undefined
          ? {}
          : { rotation: { previousTrustRoot } }),
      });
    await expect(rotate()).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    await expect(rotate(next.trust)).rejects.toMatchObject({
      code: "PLUGIN_PACKAGE_INVALID",
    });
    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "1.0.0",
      enabled: true,
    });

    const rotated = await rotate(old.trust);
    expect(rotated).toMatchObject({
      version: "2.0.0",
      keyId: "new-publisher",
      enabled: false,
    });
    expect(rotated.previousVersion).toBeUndefined();
    await expect(rollbackManagedPlugin(home, "reviewer")).rejects.toMatchObject(
      {
        code: "PLUGIN_PACKAGE_INVALID",
      },
    );
  });

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
    const catalogBytes = signCatalog(
      signed,
      fixture.privateKey,
      fixture.trust.keyId,
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
    let holdNextManifest = false;
    let manifestSeen: (() => void) | undefined;
    let releaseManifest: (() => void) | undefined;
    const server = createServer(
      {
        cert: await readFile(certificate),
        key: await readFile(key),
      },
      (request, response) => {
        const send = () => {
          const body = files.get(request.url ?? "");
          response.writeHead(body === undefined ? 404 : 200);
          response.end(body);
        };
        if (
          holdNextManifest &&
          request.url === "/reviewer/1.10.0/manifest.json"
        ) {
          releaseManifest = send;
          manifestSeen?.();
          return;
        }
        send();
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
      files.set(
        "/catalog.json",
        signCatalog(nextSigned, fixture.privateKey, fixture.trust.keyId),
      );
      files.set("/reviewer/1.10.0/manifest.json", nextManifestBytes);
      files.set(
        "/reviewer/1.10.0/index.mjs",
        await readFile(join(fixture.root, "index.mjs")),
      );
      const requested = new Promise<void>((resolve) => {
        manifestSeen = resolve;
      });
      holdNextManifest = true;
      const staleUpdate = updatePluginFromCatalog({
        kodaHome: home,
        id: "reviewer",
        ca,
        nowMs: now,
      });
      const rejected = expect(staleUpdate).rejects.toMatchObject({
        code: "PLUGIN_PACKAGE_INVALID",
      });
      await requested;
      try {
        await setManagedPluginEnabled(home, "reviewer", true);
      } finally {
        holdNextManifest = false;
        releaseManifest?.();
      }
      await rejected;
      expect((await listManagedPlugins(home))[0]).toMatchObject({
        version: "1.0.0",
        enabled: true,
      });
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

      const replacement = await packageFixture(
        "index.mjs",
        managedProtocolScript,
        "publisher-v2",
      );
      await rewriteVersion(replacement, "2.0.0");
      const replacementManifest = await readFile(
        join(replacement.root, "manifest.json"),
      );
      const replacementDigest = verifySignedPluginManifest(
        replacementManifest,
        replacement.trust,
      ).manifestSha256;
      files.set(
        "/catalog.json",
        signCatalog(
          {
            ...signed,
            packages: [
              {
                id: "reviewer",
                version: "2.0.0",
                manifest_path: "reviewer/2.0.0/manifest.json",
                manifest_sha256: replacementDigest,
              },
            ],
          },
          replacement.privateKey,
          replacement.trust.keyId,
        ),
      );
      files.set("/reviewer/2.0.0/manifest.json", replacementManifest);
      files.set(
        "/reviewer/2.0.0/index.mjs",
        await readFile(join(replacement.root, "index.mjs")),
      );
      await setManagedPluginEnabled(home, "reviewer", true);
      await expect(
        installPluginFromCatalog({
          catalogUrl,
          trustRoot: replacement.trust,
          kodaHome: home,
          id: "reviewer",
          version: "2.0.0",
          capabilities: ["tools"],
          ca,
          nowMs: now,
        }),
      ).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" });
      expect((await listManagedPlugins(home))[0]).toMatchObject({
        version: "1.10.0",
        keyId: "publisher",
        enabled: true,
      });
      const rotated = await installPluginFromCatalog({
        catalogUrl,
        trustRoot: replacement.trust,
        rotation: { previousTrustRoot: fixture.trust },
        kodaHome: home,
        id: "reviewer",
        version: "2.0.0",
        capabilities: ["tools"],
        ca,
        nowMs: now,
      });
      expect(rotated).toMatchObject({
        version: "2.0.0",
        keyId: "publisher-v2",
        enabled: false,
      });
      expect(rotated.previousVersion).toBeUndefined();
      expect(
        await updatePluginFromCatalog({
          kodaHome: home,
          id: "reviewer",
          ca,
          nowMs: now,
        }),
      ).toBeNull();
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

  it("keeps the active plugin after an interrupted package and state write", async () => {
    const fixture = await packageFixture("index.mjs", managedProtocolScript);
    const home = join(fixture.parent, "home");
    const first = await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["tools"],
    });
    await setManagedPluginEnabled(home, "reviewer", true);
    await rewriteVersion(fixture, "1.1.0");
    const next = await verifyLocalPluginPackage(fixture.root, fixture.trust);
    const store = join(home, "managed-plugins");
    const orphan = join(store, "packages", "reviewer", next.manifestSha256);
    await mkdir(join(store, "packages", "reviewer"), { recursive: true });
    await cp(fixture.root, orphan, { recursive: true });
    const state = JSON.parse(await readFile(join(store, "state.json"), "utf8"));
    state.plugins.reviewer.active.version = "1.1.0";
    state.plugins.reviewer.active.manifest_sha256 = next.manifestSha256;
    state.plugins.reviewer.enabled = false;
    await writeFile(join(store, ".state-interrupted"), JSON.stringify(state));

    expect((await listManagedPlugins(home))[0]).toMatchObject({
      version: "1.0.0",
      manifestSha256: first.manifestSha256,
      enabled: true,
    });
    expect(
      (
        await loadPluginConfiguration({
          environment: {},
          kodaHome: home,
          processDirectory: fixture.parent,
        })
      ).plugins[0]?.args[0],
    ).toContain(first.manifestSha256);

    const updated = await installManagedPluginPackage({
      kodaHome: home,
      sourceDirectory: fixture.root,
      trustRoot: fixture.trust,
      capabilities: ["tools"],
    });
    expect(updated).toMatchObject({
      version: "1.1.0",
      previousVersion: "1.0.0",
      enabled: false,
    });
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
  keyId = "publisher",
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
      signature: { key_id: keyId, ed25519: signature },
    }),
  );
  return {
    root,
    parent,
    privateKey: keys.privateKey,
    trust: {
      keyId,
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

function signCatalog(
  signed: object,
  privateKey: KeyObject,
  keyId: string,
): Buffer {
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from("KODA_PLUGIN_CATALOG_V1\0"),
      Buffer.from(sha256CanonicalJson(signed), "hex"),
    ]),
    privateKey,
  ).toString("base64");
  return Buffer.from(
    JSON.stringify({
      ...signed,
      signature: { key_id: keyId, ed25519: signature },
    }),
  );
}
