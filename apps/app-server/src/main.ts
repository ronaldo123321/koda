#!/usr/bin/env node

import { join } from "node:path";

import { KodaApplication, resolveKodaHome } from "@koda/app";
import { InteractiveProcessService } from "@koda/runtime-node";

import { JsonRpcMessageWriter } from "./message-writer.js";
import { KodaAppServer } from "./server.js";
import { runStdioTransport } from "./stdio-transport.js";

const nativeExecutorPath = process.env.KODA_EXEC_PATH?.trim();
let interactiveProcessService: InteractiveProcessService | undefined;
if (nativeExecutorPath !== undefined && nativeExecutorPath.length > 0) {
  try {
    interactiveProcessService = await InteractiveProcessService.open({
      binaryPath: nativeExecutorPath,
      stateDirectory: join(resolveKodaHome(process.env), "executor"),
    });
  } catch (error) {
    process.stderr.write(
      `[koda-app-server] interactive processes unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const application = new KodaApplication({
  environment: process.env,
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
} catch (error) {
  process.stderr.write(
    `[koda-app-server] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", terminate);
  process.removeListener("SIGTERM", terminate);
}
