import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { basename } from "node:path";

import {
  bundleDoctorExitCode,
  KODA_VERSION,
  KodaDistributionError,
  NATIVE_EXECUTOR_PROTOCOL_VERSION,
  renderBundleDoctorReport,
  resolveInstallationPath,
  resolveKodaInstallation,
  resolveNativeExecutorPath,
  runBundleDoctor,
  type KodaInstallation,
} from "@koda/distribution";
import { APP_SERVER_PROTOCOL_VERSION } from "@koda/protocol";

export type DistributionChildKind = "cli" | "tui" | "app_server";

export type DistributionRoute =
  | { readonly kind: DistributionChildKind; readonly args: readonly string[] }
  | { readonly kind: "doctor"; readonly full: boolean; readonly json: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

export interface DistributionSourceEntrypoints {
  readonly cli: string;
  readonly tui: string;
  readonly app_server: string;
}

export interface DistributionLaunchPlan {
  readonly kind: DistributionChildKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly workingDirectory: string;
}

export interface DistributionCommandRuntime {
  readonly anchor: string | URL;
  readonly invokedPath: string;
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly processDirectory: string;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly nodeExecutable: string;
  readonly sourceEntrypoints?: DistributionSourceEntrypoints;
  execute?(plan: DistributionLaunchPlan): Promise<number>;
}

export class DistributionUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DistributionUsageError";
  }
}

export function routeDistributionCommand(
  argv: readonly string[],
  invokedPath: string,
): DistributionRoute {
  if (basename(invokedPath) === "koda-chat") {
    return { kind: "tui", args: [...argv] };
  }
  const [command, ...rest] = argv;
  if (command === undefined) {
    return { kind: "tui", args: [] };
  }
  if (command === "chat") {
    return { kind: "tui", args: rest };
  }
  if (command === "app-server") {
    return { kind: "app_server", args: rest };
  }
  if (command === "doctor") {
    let full = true;
    let json = false;
    const seen = new Set<string>();
    for (const option of rest) {
      if (option !== "--bundle-only" && option !== "--json") {
        throw new DistributionUsageError(
          "Usage: koda doctor [--bundle-only] [--json]",
        );
      }
      if (seen.has(option)) {
        throw new DistributionUsageError(`Duplicate option '${option}'.`);
      }
      seen.add(option);
      if (option === "--json") {
        json = true;
      } else {
        full = true;
      }
    }
    return { kind: "doctor", full, json };
  }
  if ((command === "--version" || command === "-V") && rest.length === 0) {
    return { kind: "version" };
  }
  if ((command === "--help" || command === "-h") && rest.length === 0) {
    return { kind: "help" };
  }
  return { kind: "cli", args: [...argv] };
}

export async function runDistributionCommand(
  runtime: DistributionCommandRuntime,
): Promise<number> {
  const route = routeDistributionCommand(runtime.argv, runtime.invokedPath);
  if (route.kind === "doctor") {
    const report = await runBundleDoctor({
      anchor: runtime.anchor,
      full: route.full,
    });
    runtime.stdout.write(
      route.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderBundleDoctorReport(report),
    );
    return bundleDoctorExitCode(report);
  }

  const installation = await resolveKodaInstallation({
    anchor: runtime.anchor,
    verifyCriticalFiles: true,
  });
  if (route.kind === "help") {
    runtime.stdout.write(renderDistributionHelp());
    return 0;
  }
  if (route.kind === "version") {
    runtime.stdout.write(renderDistributionVersion(installation));
    return 0;
  }

  const plan = createDistributionLaunchPlan(route, installation, {
    environment: runtime.environment,
    nodeExecutable: runtime.nodeExecutable,
    workingDirectory: runtime.processDirectory,
    sourceEntrypoints:
      runtime.sourceEntrypoints ?? resolveDefaultSourceEntrypoints(),
  });
  return (runtime.execute ?? executeDistributionLaunchPlan)(plan);
}

export function createDistributionLaunchPlan(
  route: Extract<DistributionRoute, { kind: DistributionChildKind }>,
  installation: KodaInstallation,
  options: {
    environment: NodeJS.ProcessEnv;
    nodeExecutable: string;
    workingDirectory: string;
    sourceEntrypoints: DistributionSourceEntrypoints;
  },
): DistributionLaunchPlan {
  const environment = { ...options.environment };
  const nativeExecutorPath = resolveNativeExecutorPath(
    installation,
    environment,
  );
  if (installation.mode === "release") {
    environment.KODA_EXEC_PATH = nativeExecutorPath;
    const entry = resolveInstallationPath(
      installation,
      installation.manifest.entrypoints[route.kind],
    );
    return {
      kind: route.kind,
      command: resolveInstallationPath(
        installation,
        installation.manifest.node.path,
      ),
      args: [entry, ...route.args],
      environment,
      workingDirectory: options.workingDirectory,
    };
  }
  return {
    kind: route.kind,
    command: options.nodeExecutable,
    args: [options.sourceEntrypoints[route.kind], ...route.args],
    environment,
    workingDirectory: options.workingDirectory,
  };
}

export async function executeDistributionLaunchPlan(
  plan: DistributionLaunchPlan,
): Promise<number> {
  let child: ChildProcess;
  try {
    child = spawn(plan.command, [...plan.args], {
      env: plan.environment,
      cwd: plan.workingDirectory,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (error) {
    throw childStartError(plan.kind, error);
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      operation();
    };
    const forwardSigint = () => child.kill("SIGINT");
    const forwardSigterm = () => child.kill("SIGTERM");
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);
    child.once("error", (error) => {
      finish(() => reject(childStartError(plan.kind, error)));
    });
    child.once("close", (code, signal) => {
      finish(() => resolve(code ?? (signal === null ? 1 : 128)));
    });
  });
}

export function renderDistributionVersion(
  installation: KodaInstallation,
): string {
  const nodeVersion =
    installation.mode === "release"
      ? installation.manifest.node.version.replace(/^v/, "")
      : process.version.replace(/^v/, "");
  return [
    `koda ${KODA_VERSION}`,
    `node ${nodeVersion}`,
    `app-server protocol ${APP_SERVER_PROTOCOL_VERSION}`,
    `koda-exec protocol ${NATIVE_EXECUTOR_PROTOCOL_VERSION}`,
    `mode ${installation.mode}`,
    "",
  ].join("\n");
}

export function renderDistributionHelp(): string {
  return `Usage: koda [command] [options]\n\nCommands:\n  koda                         Open interactive Koda\n  koda chat [options]          Open interactive Koda\n  koda run <prompt> [options]  Run one coding-agent turn\n  koda app-server              Run the stdio JSON-RPC app-server\n  koda doctor [options]        Inspect the installed runtime\n\nOptions:\n  -h, --help                   Display help\n  -V, --version                Display component versions\n`;
}

function resolveDefaultSourceEntrypoints(): DistributionSourceEntrypoints {
  const require = createRequire(import.meta.url);
  return {
    cli: require.resolve("@koda/cli/main"),
    tui: require.resolve("@koda/tui/main"),
    app_server: require.resolve("@koda/app-server/main"),
  };
}

function childStartError(
  kind: DistributionChildKind,
  cause: unknown,
): KodaDistributionError {
  return new KodaDistributionError(
    kind === "app_server"
      ? "KODA_APP_SERVER_START_FAILED"
      : "KODA_BUNDLE_COMPONENT_MISSING",
    { cause },
  );
}
