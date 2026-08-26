#!/usr/bin/env node

import { CommanderError } from "commander";

import { createProgram } from "./program.js";

const program = createProgram({
  environment: process.env,
  processDirectory: process.cwd(),
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
