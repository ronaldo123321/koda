#!/usr/bin/env node

import { KodaApplication } from "@koda/app";

import { JsonRpcMessageWriter } from "./message-writer.js";
import { KodaAppServer } from "./server.js";
import { runStdioTransport } from "./stdio-transport.js";

const server = new KodaAppServer({
  application: new KodaApplication({
    environment: process.env,
    processDirectory: process.cwd(),
  }),
  writer: new JsonRpcMessageWriter(process.stdout),
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
