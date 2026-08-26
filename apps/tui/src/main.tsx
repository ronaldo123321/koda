#!/usr/bin/env node

import { CommanderError } from "commander";

import { createTuiProgram } from "./program.js";

const program = createTuiProgram({
  environment: process.env,
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
