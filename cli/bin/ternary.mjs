#!/usr/bin/env node
// Thin launcher for the built collector. Run `npm run build` in cli/ first.
import { runCli } from "../dist/main.js";

const code = runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  cwd: process.cwd(),
});
process.exitCode = code;
