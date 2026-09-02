#!/usr/bin/env node
// Thin launcher for the built collector. Run `npm run build` in cli/ first.
import { runCli } from "../dist/main.js";

// SIGINT during an in-flight submission aborts the network call cleanly
// rather than being killed mid-flight: the controller's signal reaches the
// transmit boundary (cli/src/transmit.ts), which maps an external abort to
// TransmitError code "aborted" — handleError (cli/src/main.ts) maps that to
// a quiet exit 130, no Ternary-branded error text. The confirmation prompt
// has its own independent no-hang guards (stdin close, 60s timeout; see
// confirmOrThrow in cli/src/submit.ts). The dry-run/manifest path is
// synchronous and unaffected.
const controller = new AbortController();
const onSigint = () => controller.abort();
process.on("SIGINT", onSigint);

const result = runCli(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  cwd: process.cwd(),
  signal: controller.signal,
});
// The submit path (plain `ternary review .`) is async (confirmation + a
// network call); the dry-run/manifest path returns a plain number.
Promise.resolve(result).then((code) => {
  process.exitCode = code;
  process.off("SIGINT", onSigint);
});
