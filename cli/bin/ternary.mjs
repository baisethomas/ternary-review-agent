#!/usr/bin/env node
// Thin launcher for the built collector. Run `npm run build` in cli/ first.
import { runCli } from "../dist/main.js";

const result = runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  cwd: process.cwd(),
});
// The submit path (plain `ternary review .`) is async (confirmation + a
// network call); the dry-run/manifest path returns a plain number.
Promise.resolve(result).then((code) => {
  process.exitCode = code;
});
