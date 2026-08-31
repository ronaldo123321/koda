#!/usr/bin/env node

import { KodaDistributionError } from "@koda/distribution";

import {
  DistributionUsageError,
  runDistributionCommand,
} from "./dispatcher.js";

try {
  process.exitCode = await runDistributionCommand({
    anchor: import.meta.url,
    invokedPath: process.argv[1] ?? "koda",
    argv: process.argv.slice(2),
    environment: process.env,
    processDirectory: process.cwd(),
    stdout: process.stdout,
    nodeExecutable: process.execPath,
  });
} catch (error) {
  if (error instanceof KodaDistributionError) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof DistributionUsageError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
