#!/usr/bin/env node

import { CommanderError } from "commander";

import {
  resolveInstallationEnvironment,
  resolveKodaInstallation,
} from "@koda/distribution";

import { createProgram } from "./program.js";

const installation = await resolveKodaInstallation({
  anchor: import.meta.url,
  verifyCriticalFiles: true,
});
const environment = resolveInstallationEnvironment(installation, process.env);
const program = createProgram({
  environment,
  processDirectory: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
