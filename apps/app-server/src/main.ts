#!/usr/bin/env node

import { join } from "node:path";

import { KodaApplication, resolveKodaHome } from "@koda/app";
import {
  KodaDistributionError,
  resolveInstallationEnvironment,
  resolveKodaInstallation,
  resolveNativeExecutorPath,
} from "@koda/distribution";
import { InteractiveProcessService } from "@koda/runtime-node";

import { JsonRpcMessageWriter } from "./message-writer.js";
import { KodaAppServer } from "./server.js";
import { runStdioTransport } from "./stdio-transport.js";

try {
  await runAppServer();
} catch (error) {
  process.stderr.write(
    error instanceof KodaDistributionError
      ? `[koda-app-server] error [${error.code}]: ${error.message}\n`
      : `[koda-app-server] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function runAppServer(): Promise<void> {
  const installation = await resolveKodaInstallation({
    anchor: import.meta.url,
    verifyCriticalFiles: true,
  });
  const environment = resolveInstallationEnvironment(installation, process.env);
  const nativeExecutorPath = resolveNativeExecutorPath(
    installation,
    environment,
  );
  let interactiveProcessService: InteractiveProcessService | undefined;
  if (nativeExecutorPath !== undefined) {
    try {
      interactiveProcessService = await InteractiveProcessService.open({
        binaryPath: nativeExecutorPath,
        stateDirectory: join(resolveKodaHome(environment), "executor"),
      });
    } catch (error) {
      if (installation.mode === "release") {
        throw new KodaDistributionError("KODA_NATIVE_EXECUTOR_UNAVAILABLE", {
          cause: error,
        });
      }
      process.stderr.write(
        `[koda-app-server] interactive processes unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const application = new KodaApplication({
    environment,
    processDirectory: process.cwd(),
    ...(interactiveProcessService === undefined
      ? {}
      : { interactiveProcessService }),
  });
  const server = new KodaAppServer({
    application,
    writer: new JsonRpcMessageWriter(process.stdout),
    ...(interactiveProcessService === undefined
      ? {}
      : { interactiveProcessService }),
    diagnostic: (message) => {
      process.stderr.write(`[koda-app-server] ${message}\n`);
    },
    fatal: () => {
      process.stdin.destroy();
    },
  });
  const terminate = () => {
    process.stdin.destroy();
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    await runStdioTransport(server, process.stdin);
  } finally {
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }
}
