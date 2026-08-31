import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bundleDoctorExitCode,
  canonicalIntegrityInventory,
  canonicalRuntimeManifest,
  currentRuntimeManifest,
  integrityInventoryDigest,
  integrityInventorySchema,
  KodaDistributionError,
  releaseRelativePathSchema,
  resolveKodaInstallation,
  resolveNativeExecutorPath,
  runBundleDoctor,
  runtimeManifestDigest,
  runtimeManifestSchema,
  verifyFullIntegrity,
  type IntegrityInventory,
  type KodaInstallation,
  type ReleaseInstallation,
  type RuntimeManifest,
} from "@koda/distribution";
import {
  createDistributionLaunchPlan,
  DistributionUsageError,
  routeDistributionCommand,
  runDistributionCommand,
  type DistributionLaunchPlan,
} from "@koda/distribution-app";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const FIXTURE_ARCH: "arm64" | "x64" = "arm64";
const GOLDEN_CANONICAL_INVENTORY =
  '{"schema_version":1,"files":[{"path":"app/main.mjs","bytes":3,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"path":"node/bin/node","bytes":4,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}';
const GOLDEN_INVENTORY_DIGEST =
  "b94e86c44690eade36d7315cfe2285c7c93b2fb716253c500f316f73ebb8ccc6";
const GOLDEN_RUNTIME_MANIFEST_DIGEST =
  "ab9953aa42c26a07689d4b0c4a461d998ab60c6ed19bc09addb4754e055e02a2";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      }),
    ),
  );
});

describe("distribution contracts", () => {
  it("canonicalizes the v1 inventory fixture with a stable digest", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/distribution/integrity-v1.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;

    expect(canonicalIntegrityInventory(fixture)).toBe(
      GOLDEN_CANONICAL_INVENTORY,
    );
    expect(integrityInventoryDigest(fixture)).toBe(GOLDEN_INVENTORY_DIGEST);
    expect(
      canonicalIntegrityInventory({
        files: [
          {
            sha256: "a".repeat(64),
            bytes: 3,
            path: "app/main.mjs",
          },
          {
            sha256: "b".repeat(64),
            bytes: 4,
            path: "node/bin/node",
          },
        ],
        schema_version: 1,
      }),
    ).toBe(GOLDEN_CANONICAL_INVENTORY);
  });

  it("rejects unsafe paths, duplicate inventory entries, and unknown fields", () => {
    for (const path of [
      "/absolute",
      "../escape",
      "app/../escape",
      "app\\main.mjs",
      "app//main.mjs",
      "app/",
      `app/${"🙂".repeat(2_048)}`,
    ]) {
      expect(releaseRelativePathSchema.safeParse(path).success).toBe(false);
    }

    expect(
      integrityInventorySchema.safeParse({
        schema_version: 1,
        files: [fileRecord("same", "one"), fileRecord("same", "two")],
      }).success,
    ).toBe(false);
    expect(
      integrityInventorySchema.safeParse({
        schema_version: 1,
        files: [{ ...fileRecord("one", "one"), unexpected: true }],
      }).success,
    ).toBe(false);
  });

  it("generates a strict current manifest", () => {
    const integrity = integrityInventorySchema.parse({
      schema_version: 1,
      files: [fileRecord("app/main.mjs", "main")],
    });
    const manifest = currentRuntimeManifest({
      arch: FIXTURE_ARCH,
      nodeVersion: "22.18.0",
      nodePath: "node/bin/node",
      dispatcherPath: "app/dispatcher.mjs",
      cliPath: "app/cli.mjs",
      tuiPath: "app/tui.mjs",
      appServerPath: "app/app-server.mjs",
      doctorPath: "app/doctor.mjs",
      nativeExecutorPath: "native/koda-exec",
      integrity,
    });

    expect(runtimeManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      runtimeManifestSchema.safeParse({ ...manifest, unexpected: true })
        .success,
    ).toBe(false);
    expect(manifest.integrity_sha256).toBe(integrityInventoryDigest(integrity));
  });

  it("canonicalizes the v1 runtime manifest fixture with a stable digest", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../fixtures/distribution/runtime-manifest-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    expect(canonicalRuntimeManifest(fixture)).toBe(
      JSON.stringify(runtimeManifestSchema.parse(fixture)),
    );
    expect(runtimeManifestDigest(fixture)).toBe(GOLDEN_RUNTIME_MANIFEST_DIGEST);
  });
});

describe("installed runtime resolution", () => {
  it("discovers and verifies a release from a nested entry point", async () => {
    const fixture = await createReleaseFixture();
    const installation = await resolveKodaInstallation({
      anchor: join(fixture.root, fixture.manifest.entrypoints.dispatcher),
      expectedPlatform: "darwin",
      expectedArch: FIXTURE_ARCH,
    });

    expect(installation.mode).toBe("release");
    expect(
      resolveNativeExecutorPath(installation, {
        KODA_EXEC_PATH: "/tmp/untrusted-executor",
      }),
    ).toBe(join(fixture.root, "native/koda-exec"));
  });

  it("preserves explicit executor overrides only in source mode", async () => {
    const installation = await resolveKodaInstallation({
      anchor: import.meta.url,
    });

    expect(installation.mode).toBe("development");
    expect(
      resolveNativeExecutorPath(installation, {
        KODA_EXEC_PATH: "/tmp/source-executor",
      }),
    ).toBe("/tmp/source-executor");
  });

  it("fails closed for partial metadata and critical corruption", async () => {
    const partialRoot = await createTemporaryDirectory();
    await writeFile(join(partialRoot, "runtime-manifest.json"), "{}", "utf8");
    await expectDistributionCode(
      resolveKodaInstallation({ anchor: partialRoot }),
      "KODA_BUNDLE_MANIFEST_INVALID",
    );

    const fixture = await createReleaseFixture();
    await writeFile(
      join(fixture.root, "app/dispatcher.mjs"),
      "tampered",
      "utf8",
    );
    await expectDistributionCode(
      loadFixture(fixture),
      "KODA_BUNDLE_INTEGRITY_FAILED",
    );
  });

  it("detects non-critical corruption and unexpected payload files in full mode", async () => {
    const fixture = await createReleaseFixture();
    const installation = await loadFixture(fixture);
    await writeFile(join(fixture.root, "app/optional.mjs"), "tampered", "utf8");

    await expectDistributionCode(
      verifyFullIntegrity(installation),
      "KODA_BUNDLE_INTEGRITY_FAILED",
    );

    const fresh = await createReleaseFixture();
    const freshInstallation = await loadFixture(fresh);
    await writeFile(join(fresh.root, "unexpected.txt"), "unexpected", "utf8");
    await expectDistributionCode(
      verifyFullIntegrity(freshInstallation),
      "KODA_BUNDLE_INTEGRITY_FAILED",
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a critical file reached through a symlinked directory",
    async () => {
      const fixture = await createReleaseFixture();
      const outside = await createTemporaryDirectory();
      await writeFile(join(outside, "koda-exec"), "native executor\n", "utf8");
      await rm(join(fixture.root, "native"), { recursive: true, force: true });
      await symlink(outside, join(fixture.root, "native"), "dir");

      await expectDistributionCode(
        loadFixture(fixture),
        "KODA_BUNDLE_INTEGRITY_FAILED",
      );
    },
  );

  it("reports stable platform, architecture, version, and protocol failures", async () => {
    const fixture = await createReleaseFixture();
    await expectDistributionCode(
      loadFixture(fixture, { expectedPlatform: "linux" }),
      "KODA_BUNDLE_PLATFORM_MISMATCH",
    );
    await expectDistributionCode(
      loadFixture(fixture, { expectedArch: "x64" }),
      "KODA_BUNDLE_ARCH_MISMATCH",
    );

    await writeRuntimeManifest(fixture.root, {
      ...fixture.manifest,
      version: "9.9.9",
    });
    await expectDistributionCode(
      loadFixture(fixture),
      "KODA_BUNDLE_VERSION_MISMATCH",
    );

    const protocolFixture = await createReleaseFixture();
    await writeRuntimeManifest(protocolFixture.root, {
      ...protocolFixture.manifest,
      protocols: {
        ...protocolFixture.manifest.protocols,
        native_executor: protocolFixture.manifest.protocols.native_executor + 1,
      },
    });
    await expectDistributionCode(
      loadFixture(protocolFixture),
      "KODA_BUNDLE_VERSION_MISMATCH",
    );
  });

  it("keeps public distribution messages bounded and secret-free", () => {
    const error = new KodaDistributionError("KODA_BUNDLE_INTEGRITY_FAILED", {
      cause: new Error("sk-secret-value /private/sensitive/path"),
    });

    expect(error.message).not.toContain("sk-secret-value");
    expect(error.message).not.toContain("/private/sensitive/path");
    expect(error.message.length).toBeLessThan(512);
  });
});

describe("bundle doctor", () => {
  it("returns a versioned development report without exposing paths", async () => {
    const report = await runBundleDoctor({ anchor: import.meta.url });

    expect(report).toMatchObject({
      schema_version: 1,
      mode: "development",
      status: "development",
    });
    expect(JSON.stringify(report)).not.toContain(process.cwd());
    expect(bundleDoctorExitCode(report)).toBe(0);
  });

  it("passes a complete bundle and can skip the full payload scan", async () => {
    const fixture = await createReleaseFixture();
    await writeFile(join(fixture.root, "app/optional.mjs"), "tampered", "utf8");
    const criticalOnly = await runBundleDoctor({
      anchor: join(fixture.root, "app/dispatcher.mjs"),
      expectedPlatform: "darwin",
      expectedArch: FIXTURE_ARCH,
      full: false,
    });
    const full = await runBundleDoctor({
      anchor: join(fixture.root, "app/dispatcher.mjs"),
      expectedPlatform: "darwin",
      expectedArch: FIXTURE_ARCH,
      full: true,
    });

    expect(criticalOnly.status).toBe("passed");
    expect(criticalOnly.checks.at(-1)).toMatchObject({
      id: "bundle.full_integrity",
      status: "skipped",
    });
    expect(full).toMatchObject({ mode: "invalid", status: "failed" });
    expect(bundleDoctorExitCode(full)).toBe(1);
  });
});

describe("unified command dispatcher", () => {
  it("routes the installed command surface deterministically", () => {
    expect(routeDistributionCommand([], "/usr/local/bin/koda")).toEqual({
      kind: "tui",
      args: [],
    });
    expect(
      routeDistributionCommand(["--provider", "deepseek"], "koda-chat"),
    ).toEqual({ kind: "tui", args: ["--provider", "deepseek"] });
    expect(routeDistributionCommand(["chat", "--help"], "koda")).toEqual({
      kind: "tui",
      args: ["--help"],
    });
    expect(routeDistributionCommand(["run", "inspect"], "koda")).toEqual({
      kind: "cli",
      args: ["run", "inspect"],
    });
    expect(routeDistributionCommand(["app-server"], "koda")).toEqual({
      kind: "app_server",
      args: [],
    });
    expect(routeDistributionCommand(["doctor", "--json"], "koda")).toEqual({
      kind: "doctor",
      full: true,
      json: true,
    });
    expect(routeDistributionCommand(["--version"], "koda")).toEqual({
      kind: "version",
    });
    expect(routeDistributionCommand(["--help"], "koda")).toEqual({
      kind: "help",
    });
    expect(() =>
      routeDistributionCommand(["doctor", "--json", "--json"], "koda"),
    ).toThrow(DistributionUsageError);
    expect(() =>
      routeDistributionCommand(["doctor", "--network"], "koda"),
    ).toThrow(DistributionUsageError);
  });

  it("creates source and release launch plans with the correct trust boundary", async () => {
    const source: KodaInstallation = {
      mode: "development",
      anchorPath: "/source/dispatcher.mjs",
    };
    const sourcePlan = createDistributionLaunchPlan(
      { kind: "cli", args: ["run", "inspect"] },
      source,
      launchOptions(),
    );
    expect(sourcePlan).toMatchObject({
      command: "/runtime/node",
      args: ["/source/cli.mjs", "run", "inspect"],
      workingDirectory: "/workspace",
      environment: { KODA_EXEC_PATH: "/source/koda-exec" },
    });

    const fixture = await createReleaseFixture();
    const installation = await loadFixture(fixture);
    const releasePlan = createDistributionLaunchPlan(
      { kind: "app_server", args: ["--stdio"] },
      installation,
      launchOptions(),
    );
    expect(releasePlan).toMatchObject({
      command: join(fixture.root, "node/bin/node"),
      args: [join(fixture.root, "app/app-server.mjs"), "--stdio"],
      workingDirectory: "/workspace",
      environment: { KODA_EXEC_PATH: join(fixture.root, "native/koda-exec") },
    });
  });

  it("runs source-mode help, version, and delegated commands through injected I/O", async () => {
    let output = "";
    let captured: DistributionLaunchPlan | undefined;
    const common = {
      anchor: import.meta.url,
      invokedPath: "koda",
      environment: { KODA_EXEC_PATH: "/source/koda-exec" },
      processDirectory: "/workspace",
      stdout: {
        write: (value: string | Uint8Array) => {
          output += value.toString();
          return true;
        },
      },
      nodeExecutable: "/runtime/node",
      sourceEntrypoints: launchOptions().sourceEntrypoints,
      execute: async (plan: DistributionLaunchPlan) => {
        captured = plan;
        return 23;
      },
    };

    expect(await runDistributionCommand({ ...common, argv: ["--help"] })).toBe(
      0,
    );
    expect(output).toContain("koda run <prompt>");
    output = "";
    expect(
      await runDistributionCommand({ ...common, argv: ["--version"] }),
    ).toBe(0);
    expect(output).toContain("koda 0.1.0");
    expect(output).toContain("mode development");
    expect(
      await runDistributionCommand({ ...common, argv: ["run", "inspect"] }),
    ).toBe(23);
    expect(captured).toMatchObject({
      kind: "cli",
      args: ["/source/cli.mjs", "run", "inspect"],
    });
  });
});

interface ReleaseFixture {
  readonly root: string;
  readonly manifest: RuntimeManifest;
  readonly integrity: IntegrityInventory;
}

async function createReleaseFixture(): Promise<ReleaseFixture> {
  const root = await createTemporaryDirectory();
  const payloads = new Map<string, string>([
    ["app/app-server.mjs", "app server\n"],
    ["app/cli.mjs", "cli\n"],
    ["app/dispatcher.mjs", "dispatcher\n"],
    ["app/doctor.mjs", "doctor\n"],
    ["app/optional.mjs", "optional\n"],
    ["app/tui.mjs", "tui\n"],
    ["native/koda-exec", "native executor\n"],
    ["node/bin/node", "embedded node\n"],
  ]);
  for (const [path, content] of payloads) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  const integrity = integrityInventorySchema.parse({
    schema_version: 1,
    files: [...payloads]
      .map(([path, content]) => fileRecord(path, content))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  const manifest = currentRuntimeManifest({
    arch: FIXTURE_ARCH,
    nodeVersion: "22.18.0",
    nodePath: "node/bin/node",
    dispatcherPath: "app/dispatcher.mjs",
    cliPath: "app/cli.mjs",
    tuiPath: "app/tui.mjs",
    appServerPath: "app/app-server.mjs",
    doctorPath: "app/doctor.mjs",
    nativeExecutorPath: "native/koda-exec",
    integrity,
  });
  await Promise.all([
    writeFile(
      join(root, "integrity.json"),
      `${JSON.stringify(integrity, null, 2)}\n`,
      "utf8",
    ),
    writeRuntimeManifest(root, manifest),
  ]);
  return { root, manifest, integrity };
}

async function loadFixture(
  fixture: ReleaseFixture,
  overrides: {
    expectedPlatform?: NodeJS.Platform;
    expectedArch?: NodeJS.Architecture;
  } = {},
): Promise<ReleaseInstallation> {
  const installation = await resolveKodaInstallation({
    anchor: join(fixture.root, "app/dispatcher.mjs"),
    expectedPlatform: overrides.expectedPlatform ?? "darwin",
    expectedArch: overrides.expectedArch ?? FIXTURE_ARCH,
  });
  if (installation.mode !== "release") {
    throw new Error("Expected a release installation fixture.");
  }
  return installation;
}

async function writeRuntimeManifest(
  root: string,
  manifest: RuntimeManifest,
): Promise<void> {
  await writeFile(
    join(root, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function fileRecord(path: string, content: string) {
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function launchOptions() {
  return {
    environment: { KODA_EXEC_PATH: "/source/koda-exec" },
    nodeExecutable: "/runtime/node",
    workingDirectory: "/workspace",
    sourceEntrypoints: {
      cli: "/source/cli.mjs",
      tui: "/source/tui.mjs",
      app_server: "/source/app-server.mjs",
    },
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "koda-distribution-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

async function expectDistributionCode(
  promise: Promise<unknown>,
  code: KodaDistributionError["code"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KodaDistributionError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected distribution error ${code}.`);
}
