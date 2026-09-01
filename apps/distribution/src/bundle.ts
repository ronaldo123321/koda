import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { APP_SERVER_PROTOCOL_VERSION, type JsonValue } from "@koda/protocol";
import {
  EMBEDDED_NODE_VERSION,
  embeddedNodeArchiveUrl,
  embeddedNodeArtifact,
  embeddedNodeChecksumsUrl,
  KODA_VERSION,
  loadReleaseInstallation,
  parseNodeChecksumInventory,
  verifyFullIntegrity,
  writeRuntimeMetadata,
  type EmbeddedNodeArtifact,
} from "@koda/distribution";
import { build, type Plugin } from "esbuild";

const DOWNLOAD_MAXIMUM_BYTES = 128 * 1_024 * 1_024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const CHILD_OUTPUT_MAXIMUM_BYTES = 1_048_576;
const SMOKE_TIMEOUT_MS = 20_000;
const REPRODUCIBLE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");

export type MacOSBundleArchitecture = "arm64" | "x64";

export interface BundleCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export type BundleCommandRunner = (command: BundleCommand) => Promise<void>;

export interface AssembleMacOSBundleOptions {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly cacheDirectory: string;
  readonly architecture?: MacOSBundleArchitecture;
  readonly nodeArchivePath?: string;
  readonly skipBuild?: boolean;
  readonly skipSmoke?: boolean;
  readonly commandRunner?: BundleCommandRunner;
}

export interface MacOSBundleResult {
  readonly architecture: MacOSBundleArchitecture;
  readonly outputDirectory: string;
  readonly bundleRoot: string;
  readonly runtimeRoot: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly machOFiles: readonly string[];
}

export type BundleAssemblyErrorCode =
  | "KODA_ASSEMBLY_INVALID"
  | "KODA_ASSEMBLY_COMMAND_FAILED"
  | "KODA_NODE_DOWNLOAD_FAILED"
  | "KODA_NODE_INTEGRITY_FAILED"
  | "KODA_BUNDLE_ARCHITECTURE_INVALID"
  | "KODA_BUNDLE_SMOKE_FAILED";

const ASSEMBLY_MESSAGES: Readonly<Record<BundleAssemblyErrorCode, string>> = {
  KODA_ASSEMBLY_INVALID:
    "The macOS bundle assembly input or staging tree is invalid.",
  KODA_ASSEMBLY_COMMAND_FAILED: "A required macOS bundle build command failed.",
  KODA_NODE_DOWNLOAD_FAILED:
    "The pinned embedded Node.js artifact could not be acquired.",
  KODA_NODE_INTEGRITY_FAILED:
    "The embedded Node.js artifact failed its pinned integrity check.",
  KODA_BUNDLE_ARCHITECTURE_INVALID:
    "The macOS bundle contains an unexpected native architecture.",
  KODA_BUNDLE_SMOKE_FAILED:
    "The repository-independent macOS bundle smoke test failed.",
};

export class KodaBundleAssemblyError extends Error {
  public constructor(
    public readonly code: BundleAssemblyErrorCode,
    options?: ErrorOptions,
  ) {
    super(ASSEMBLY_MESSAGES[code], options);
    this.name = "KodaBundleAssemblyError";
  }
}

export async function assembleMacOSBundle(
  options: AssembleMacOSBundleOptions,
): Promise<MacOSBundleResult> {
  const architecture = options.architecture ?? runtimeArchitecture();
  if (process.platform !== "darwin" || process.arch !== architecture) {
    throw new KodaBundleAssemblyError("KODA_BUNDLE_ARCHITECTURE_INVALID");
  }
  const repositoryRoot = await realDirectory(options.repositoryRoot);
  const outputDirectory = resolve(options.outputDirectory);
  const cacheDirectory = resolve(options.cacheDirectory);
  if (await pathExists(outputDirectory)) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(outputParent, `.${basename(outputDirectory)}.staging-`),
  );
  const publishRoot = join(stagingRoot, "publish");
  const workRoot = join(stagingRoot, "work");
  const bundleRoot = join(publishRoot, "koda");
  const runtimeRoot = join(bundleRoot, "libexec", "koda");
  const deployedApplication = join(workRoot, "production-deploy");
  const commandRunner = options.commandRunner ?? runBundleCommand;

  try {
    await Promise.all([
      mkdir(join(bundleRoot, "bin"), { recursive: true }),
      mkdir(join(runtimeRoot, "app"), { recursive: true }),
      mkdir(join(runtimeRoot, "native"), { recursive: true }),
      mkdir(join(runtimeRoot, "node", "bin"), { recursive: true }),
      mkdir(workRoot, { recursive: true }),
    ]);
    if (options.skipBuild !== true) {
      await commandRunner({
        command: "pnpm",
        args: ["-r", "--if-present", "build"],
        cwd: repositoryRoot,
      });
      await commandRunner({
        command: "cargo",
        args: ["build", "--release", "-p", "koda-exec"],
        cwd: repositoryRoot,
      });
    }
    await commandRunner({
      command: "pnpm",
      args: [
        "--filter",
        "@koda/distribution-app",
        "--prod",
        "deploy",
        "--legacy",
        deployedApplication,
      ],
      cwd: repositoryRoot,
    });

    await bundleApplication(deployedApplication, join(runtimeRoot, "app"));
    await copyBetterSqlite(deployedApplication, runtimeRoot, architecture);
    const nodeArtifact = embeddedNodeArtifact(architecture);
    const nodeArchive = await acquirePinnedNodeArchive({
      artifact: nodeArtifact,
      cacheDirectory,
      ...(options.nodeArchivePath === undefined
        ? {}
        : { providedArchivePath: options.nodeArchivePath }),
    });
    await installEmbeddedNode(
      nodeArchive,
      nodeArtifact,
      runtimeRoot,
      workRoot,
      commandRunner,
    );
    await installNativeExecutor(repositoryRoot, runtimeRoot);
    await writeLaunchers(bundleRoot);

    const machOFiles = await auditMachOFiles(bundleRoot, architecture);
    await writeRuntimeMetadata(runtimeRoot, {
      arch: architecture,
      nodeVersion: EMBEDDED_NODE_VERSION,
      nodePath: "node/bin/node",
      dispatcherPath: "app/dispatcher.mjs",
      cliPath: "app/cli.mjs",
      tuiPath: "app/tui.mjs",
      appServerPath: "app/app-server.mjs",
      doctorPath: "app/dispatcher.mjs",
      nativeExecutorPath: "native/koda-exec",
    });
    await normalizePublishedTree(
      bundleRoot,
      new Set([
        "bin/koda",
        "bin/koda-chat",
        "libexec/koda/native/koda-exec",
        "libexec/koda/node/bin/node",
      ]),
    );

    const installation = await loadReleaseInstallation(runtimeRoot, {
      expectedPlatform: "darwin",
      expectedArch: architecture,
      verifyCriticalFiles: true,
    });
    await verifyFullIntegrity(installation);
    if (options.skipSmoke !== true) {
      await smokeStandaloneBundle(bundleRoot);
    }

    const archiveName = `koda-v${KODA_VERSION}-darwin-${architecture}.tar.gz`;
    const archivePath = join(publishRoot, archiveName);
    const archiveSha256 = await createDeterministicArchive({
      publishRoot,
      bundleRoot,
      archivePath,
      listPath: join(workRoot, "archive-files.txt"),
      commandRunner,
    });
    await writeFile(
      `${archivePath}.sha256`,
      `${archiveSha256}  ${archiveName}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    );
    await rename(publishRoot, outputDirectory);
    await makeTreeWritable(stagingRoot);
    await rm(stagingRoot, { recursive: true, force: true });
    return {
      architecture,
      outputDirectory,
      bundleRoot: join(outputDirectory, "koda"),
      runtimeRoot: join(outputDirectory, "koda", "libexec", "koda"),
      archivePath: join(outputDirectory, archiveName),
      archiveSha256,
      machOFiles,
    };
  } catch (error) {
    await makeTreeWritable(stagingRoot).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function acquirePinnedNodeArchive(options: {
  artifact: EmbeddedNodeArtifact;
  cacheDirectory: string;
  providedArchivePath?: string;
}): Promise<string> {
  const expected = options.artifact.sha256;
  if (options.providedArchivePath !== undefined) {
    const provided = await realpath(options.providedArchivePath);
    if ((await sha256File(provided)) !== expected) {
      throw new KodaBundleAssemblyError("KODA_NODE_INTEGRITY_FAILED");
    }
    return provided;
  }

  await mkdir(options.cacheDirectory, { recursive: true });
  const destination = join(options.cacheDirectory, options.artifact.archive);
  if (await pathExists(destination)) {
    if ((await sha256File(destination)) !== expected) {
      throw new KodaBundleAssemblyError("KODA_NODE_INTEGRITY_FAILED");
    }
    return destination;
  }

  try {
    const checksumResponse = await fetchBounded(
      embeddedNodeChecksumsUrl(options.artifact.version),
      1_048_576,
    );
    if (
      parseNodeChecksumInventory(
        checksumResponse.toString("utf8"),
        options.artifact.archive,
      ) !== expected
    ) {
      throw new KodaBundleAssemblyError("KODA_NODE_INTEGRITY_FAILED");
    }
    const temporary = join(
      options.cacheDirectory,
      `.${options.artifact.archive}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await downloadBounded(
        embeddedNodeArchiveUrl(options.artifact),
        temporary,
      );
      if ((await sha256File(temporary)) !== expected) {
        throw new KodaBundleAssemblyError("KODA_NODE_INTEGRITY_FAILED");
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return destination;
  } catch (error) {
    if (error instanceof KodaBundleAssemblyError) {
      throw error;
    }
    throw new KodaBundleAssemblyError("KODA_NODE_DOWNLOAD_FAILED", {
      cause: error,
    });
  }
}

export async function auditMachOFiles(
  root: string,
  expectedArchitecture: MacOSBundleArchitecture,
): Promise<readonly string[]> {
  const paths = await listTreeFiles(root);
  const nativeFiles: string[] = [];
  for (const path of paths) {
    const absolute = join(root, ...path.split("/"));
    const handle = await open(absolute, "r");
    try {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const architecture = parseMachOArchitecture(
        header.subarray(0, bytesRead),
      );
      if (architecture === undefined) {
        continue;
      }
      if (architecture !== expectedArchitecture) {
        throw new KodaBundleAssemblyError("KODA_BUNDLE_ARCHITECTURE_INVALID");
      }
      nativeFiles.push(path);
    } finally {
      await handle.close();
    }
  }
  const required = [
    "libexec/koda/native/koda-exec",
    "libexec/koda/node/bin/node",
    `libexec/koda/app/node_modules/better-sqlite3/prebuilds/darwin-${expectedArchitecture}.node`,
  ];
  if (required.some((path) => !nativeFiles.includes(path))) {
    throw new KodaBundleAssemblyError("KODA_BUNDLE_ARCHITECTURE_INVALID");
  }
  return nativeFiles;
}

export function parseMachOArchitecture(
  header: Uint8Array,
): MacOSBundleArchitecture | "fat" | undefined {
  if (header.byteLength < 8) {
    return undefined;
  }
  const buffer = Buffer.from(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  const magicLittleEndian = buffer.readUInt32LE(0);
  const magicBigEndian = buffer.readUInt32BE(0);
  if (
    magicBigEndian === 0xcafebabe ||
    magicBigEndian === 0xcafebabf ||
    magicLittleEndian === 0xcafebabe ||
    magicLittleEndian === 0xcafebabf
  ) {
    return "fat";
  }
  if (magicLittleEndian !== 0xfeedfacf) {
    return undefined;
  }
  const cpuType = buffer.readUInt32LE(4);
  if (cpuType === 0x0100000c) {
    return "arm64";
  }
  if (cpuType === 0x01000007) {
    return "x64";
  }
  return undefined;
}

export function renderLauncher(alias: "koda" | "koda-chat"): string {
  const dispatcherArguments = alias === "koda-chat" ? ' chat "$@"' : ' "$@"';
  return `#!/bin/sh
set -eu

SOURCE=$0
while [ -h "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH= cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
  LINK_TARGET=$(readlink "$SOURCE")
  case "$LINK_TARGET" in
    /*) SOURCE=$LINK_TARGET ;;
    *) SOURCE=$SOURCE_DIR/$LINK_TARGET ;;
  esac
done
BIN_DIR=$(CDPATH= cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
RUNTIME_DIR=$(CDPATH= cd -P "$BIN_DIR/../libexec/koda" >/dev/null 2>&1 && pwd)
unset NODE_OPTIONS NODE_PATH
unset DEV
exec "$RUNTIME_DIR/node/bin/node" "$RUNTIME_DIR/app/dispatcher.mjs"${dispatcherArguments}
`;
}

async function bundleApplication(
  deployedApplication: string,
  outputDirectory: string,
): Promise<void> {
  const entryPoints = {
    dispatcher: "dist/main.js",
    cli: await realpath(
      join(deployedApplication, "node_modules/@koda/cli/dist/main.js"),
    ),
    tui: await realpath(
      join(deployedApplication, "node_modules/@koda/tui/dist/main.js"),
    ),
    "app-server": await realpath(
      join(deployedApplication, "node_modules/@koda/app-server/dist/main.js"),
    ),
  };
  await build({
    absWorkingDir: deployedApplication,
    entryPoints,
    outdir: outputDirectory,
    outExtension: { ".js": ".mjs" },
    entryNames: "[name]",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.20",
    external: ["better-sqlite3"],
    banner: {
      js: 'import { createRequire as __kodaCreateRequire } from "node:module"; const require = __kodaCreateRequire(import.meta.url);',
    },
    define: {
      "process.env.DEV": '"false"',
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [optionalInkDevtoolsStub()],
    sourcemap: false,
    sourcesContent: false,
    legalComments: "none",
    logLevel: "silent",
    treeShaking: true,
  });
}

function optionalInkDevtoolsStub(): Plugin {
  const namespace = "koda-optional-ink-devtools";
  return {
    name: namespace,
    setup(context) {
      context.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace,
      }));
      context.onLoad({ filter: /.*/, namespace }, () => ({
        contents: "export default { initialize() {}, connectToDevTools() {} };",
        loader: "js",
      }));
    },
  };
}

async function copyBetterSqlite(
  deployedApplication: string,
  runtimeRoot: string,
  architecture: MacOSBundleArchitecture,
): Promise<void> {
  const source = await realpath(
    join(deployedApplication, "node_modules", "better-sqlite3"),
  );
  const destination = join(
    runtimeRoot,
    "app",
    "node_modules",
    "better-sqlite3",
  );
  await mkdir(join(destination, "prebuilds"), { recursive: true });
  await Promise.all([
    copyFile(join(source, "package.json"), join(destination, "package.json")),
    copyFile(join(source, "LICENSE"), join(destination, "LICENSE")),
    cp(join(source, "lib"), join(destination, "lib"), {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    }),
    copyFile(
      join(source, "prebuilds", `darwin-${architecture}.node`),
      join(destination, "prebuilds", `darwin-${architecture}.node`),
    ),
  ]);
}

async function installEmbeddedNode(
  archivePath: string,
  artifact: EmbeddedNodeArtifact,
  runtimeRoot: string,
  workRoot: string,
  commandRunner: BundleCommandRunner,
): Promise<void> {
  const extractRoot = join(workRoot, "embedded-node");
  await mkdir(extractRoot, { recursive: true });
  await commandRunner({
    command: "/usr/bin/tar",
    args: ["-xzf", archivePath, "-C", extractRoot],
    cwd: workRoot,
    environment: { ...process.env, COPYFILE_DISABLE: "1", LANG: "C" },
  });
  const distributionRoot = join(
    extractRoot,
    artifact.archive.replace(/\.tar\.gz$/, ""),
  );
  await Promise.all([
    copyFile(
      join(distributionRoot, "bin", "node"),
      join(runtimeRoot, "node", "bin", "node"),
    ),
    copyFile(
      join(distributionRoot, "LICENSE"),
      join(runtimeRoot, "node", "LICENSE"),
    ),
  ]);
}

async function installNativeExecutor(
  repositoryRoot: string,
  runtimeRoot: string,
): Promise<void> {
  const source = join(repositoryRoot, "target", "release", "koda-exec");
  if (!(await stat(source)).isFile()) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  await copyFile(source, join(runtimeRoot, "native", "koda-exec"));
}

async function writeLaunchers(bundleRoot: string): Promise<void> {
  await Promise.all(
    (["koda", "koda-chat"] as const).map(async (alias) => {
      const path = join(bundleRoot, "bin", alias);
      await writeFile(path, renderLauncher(alias), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o755,
      });
    }),
  );
}

async function smokeStandaloneBundle(bundleRoot: string): Promise<void> {
  const smokeRoot = await mkdtemp("/private/tmp/koda-bundle-smoke-");
  let smokeSupervisor: ChildProcess | undefined;
  try {
    const workspace = join(smokeRoot, "workspace 测试");
    const kodaHome = join(smokeRoot, "state");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(kodaHome, { recursive: true }),
    ]);
    const environment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      KODA_HOME: kodaHome,
      KODA_EXEC_PATH: "/untrusted/executor/override",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      TMPDIR: smokeRoot,
    };
    smokeSupervisor = await startSmokeSupervisor(
      bundleRoot,
      kodaHome,
      environment,
    );
    const executable = join(bundleRoot, "bin", "koda");
    const version = await runCaptured(executable, ["--version"], {
      cwd: workspace,
      environment,
    });
    if (version.code !== 0 || !version.stdout.includes("mode release")) {
      throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED");
    }
    const doctor = await runCaptured(
      executable,
      ["doctor", "--bundle-only", "--json"],
      { cwd: workspace, environment },
    );
    let report: { status?: unknown; mode?: unknown };
    try {
      report = JSON.parse(doctor.stdout) as typeof report;
    } catch (error) {
      throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED", {
        cause: error,
      });
    }
    if (
      doctor.code !== 0 ||
      report.status !== "passed" ||
      report.mode !== "release"
    ) {
      throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED");
    }
    const appServer = await runCaptured(executable, ["app-server"], {
      cwd: workspace,
      environment,
      stdin:
        [
          jsonRpcRequest(1, "initialize", {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            client: { name: "standalone-smoke", version: KODA_VERSION },
          }),
          jsonRpcRequest(2, "thread/list", {}),
          jsonRpcRequest(3, "shutdown", {}),
        ].join("\n") + "\n",
    });
    let messages: Array<Record<string, unknown>>;
    try {
      messages = appServer.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED", {
        cause: error,
      });
    }
    const initialize = messages.find((message) => message.id === 1)?.result as
      | {
          capabilities?: { interactiveProcesses?: unknown };
          protocolVersion?: unknown;
        }
      | undefined;
    if (
      appServer.code !== 0 ||
      appServer.stderr.length !== 0 ||
      initialize?.protocolVersion !== APP_SERVER_PROTOCOL_VERSION ||
      initialize.capabilities?.interactiveProcesses !== true ||
      messages.find((message) => message.id === 3)?.result === undefined
    ) {
      throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED");
    }
  } finally {
    if (smokeSupervisor !== undefined) {
      await stopSmokeSupervisor(smokeSupervisor).catch(() => undefined);
    }
    await makeTreeWritable(smokeRoot).catch(() => undefined);
    await rm(smokeRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function startSmokeSupervisor(
  bundleRoot: string,
  kodaHome: string,
  environment: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const stateDirectory = join(kodaHome, "executor");
  const endpoint = join(stateDirectory, "koda-exec.sock");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const child = spawn(
    join(bundleRoot, "libexec", "koda", "native", "koda-exec"),
    ["serve", "--endpoint", endpoint, "--state-dir", stateDirectory],
    {
      cwd: bundleRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let diagnosticsBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnosticsBytes += chunk.byteLength;
    if (diagnosticsBytes > CHILD_OUTPUT_MAXIMUM_BYTES) {
      child.kill("SIGKILL");
    }
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    const deadline = Date.now() + SMOKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED");
      }
      try {
        if ((await lstat(endpoint)).isSocket()) {
          return child;
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      await delay(25);
    }
    throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED");
  } catch (error) {
    await stopSmokeSupervisor(child).catch(() => undefined);
    if (error instanceof KodaBundleAssemblyError) {
      throw error;
    }
    throw new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED", {
      cause: error,
    });
  }
}

async function stopSmokeSupervisor(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
  child.kill("SIGTERM");
  await Promise.race([closed, delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, delay(1_000)]);
  }
}

async function createDeterministicArchive(options: {
  publishRoot: string;
  bundleRoot: string;
  archivePath: string;
  listPath: string;
  commandRunner: BundleCommandRunner;
}): Promise<string> {
  const tarPath = options.archivePath.replace(/\.gz$/, "");
  if (tarPath === options.archivePath) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  const files = (await listTreeFiles(options.bundleRoot)).map(
    (path) => `koda/${path}`,
  );
  await writeFile(options.listPath, `${files.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await options.commandRunner({
    command: "/usr/bin/tar",
    args: ["-cf", tarPath, "-C", options.publishRoot, "-T", options.listPath],
    cwd: options.publishRoot,
    environment: { ...process.env, COPYFILE_DISABLE: "1", LANG: "C" },
  });
  await options.commandRunner({
    command: "/usr/bin/gzip",
    args: ["-n", "-9", tarPath],
    cwd: options.publishRoot,
    environment: { ...process.env, LANG: "C" },
  });
  return sha256File(options.archivePath);
}

async function normalizePublishedTree(
  root: string,
  executablePaths: ReadonlySet<string>,
): Promise<void> {
  await normalizeEntry(root, root, executablePaths);
}

async function normalizeEntry(
  root: string,
  path: string,
  executablePaths: ReadonlySet<string>,
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  if (metadata.isDirectory()) {
    const handle = await opendir(path);
    const children: string[] = [];
    for await (const entry of handle) {
      children.push(entry.name);
    }
    children.sort(comparePaths);
    for (const child of children) {
      await normalizeEntry(root, join(path, child), executablePaths);
    }
    await utimes(path, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP);
    await chmod(path, 0o555);
    return;
  }
  if (!metadata.isFile()) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  const relativePath = relative(root, path).split(sep).join("/");
  await utimes(path, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP);
  await chmod(path, executablePaths.has(relativePath) ? 0o555 : 0o444);
}

/** @internal Exported so the no-symlink-follow cleanup invariant can be tested. */
export async function makeTreeWritable(root: string): Promise<void> {
  if (!(await pathExists(root))) {
    return;
  }
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) {
    return;
  }
  if (metadata.isFile()) {
    await chmod(root, 0o600).catch(() => undefined);
    return;
  }
  await chmod(root, 0o700).catch(() => undefined);
  const handle = await opendir(root);
  for await (const entry of handle) {
    await makeTreeWritable(join(root, entry.name));
  }
}

async function listTreeFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  await listFilesRecursive(root, root, paths);
  paths.sort(comparePaths);
  return paths;
}

async function listFilesRecursive(
  root: string,
  directory: string,
  paths: string[],
): Promise<void> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
    }
    if (entry.isDirectory()) {
      await listFilesRecursive(root, absolute, paths);
      continue;
    }
    if (!entry.isFile()) {
      throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
    }
    const path = relative(root, absolute).split(sep).join("/");
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
    }
    paths.push(path);
  }
}

async function fetchBounded(
  url: string,
  maximumBytes: number,
): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error("Pinned artifact request failed.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const chunk = Buffer.from(result.value);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Pinned artifact response exceeds the byte limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function downloadBounded(
  url: string,
  destination: string,
): Promise<void> {
  const data = await fetchBounded(url, DOWNLOAD_MAXIMUM_BYTES);
  await writeFile(destination, data, { flag: "wx", mode: 0o600 });
}

async function runBundleCommand(specification: BundleCommand): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(specification.command, [...specification.args], {
      cwd: specification.cwd,
      env: specification.environment ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(
        new KodaBundleAssemblyError("KODA_ASSEMBLY_COMMAND_FAILED", {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePromise();
      } else {
        reject(new KodaBundleAssemblyError("KODA_ASSEMBLY_COMMAND_FAILED"));
      }
    });
  });
}

async function runCaptured(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    stdin?: string;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED"));
    }, SMOKE_TIMEOUT_MS);
    timer.unref();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const append = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
      const nextBytes = bytes + chunk.byteLength;
      if (nextBytes > CHILD_OUTPUT_MAXIMUM_BYTES && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED"));
      }
      chunks.push(chunk);
      return nextBytes;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, stderrBytes, chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED", {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (signal !== null) {
        reject(new KodaBundleAssemblyError("KODA_BUNDLE_SMOKE_FAILED"));
        return;
      }
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

function jsonRpcRequest(id: number, method: string, params: JsonValue): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function realDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) {
    throw new KodaBundleAssemblyError("KODA_ASSEMBLY_INVALID");
  }
  return canonical;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runtimeArchitecture(): MacOSBundleArchitecture {
  if (process.arch === "arm64" || process.arch === "x64") {
    return process.arch;
  }
  throw new KodaBundleAssemblyError("KODA_BUNDLE_ARCHITECTURE_INVALID");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
