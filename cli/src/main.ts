// Argv wiring for the Workspace Review collector.
//
// Two code paths live here:
//  - --dry-run / --manifest: the offline path. It (and everything it
//    transitively imports via collect.ts) never imports the transmit module
//    or any networking transport, which the zero-network module-graph test
//    asserts structurally by walking the graph rooted at collect.ts.
//  - plain `ternary review .`: the submit path (submit.ts), which performs
//    capture, prints the same summary as --dry-run, asks for interactive
//    confirmation (or accepts --yes), then transmits and renders the result.
//    This is the one path allowed to reach transmit.ts (spec fixed decision
//    7 / docs/workspace-review-endpoint.md §6).

import { resolve } from "node:path";
import { collectWorkspaceReview } from "./collect.js";
import { neutralizeControlSequences, renderReport } from "./render.js";
import { runSubmit } from "./submit.js";
import type { SubmitIo } from "./submit.js";
import { TransmitError } from "./transmit.js";
import { CollectorError } from "./types.js";
import type { CaptureMode } from "./types.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  // Optional seams for the submit path; default to the real process env/stdin
  // when omitted so existing dry-run/manifest callers need not supply them.
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

interface ParsedArgs {
  path: string;
  mode: CaptureMode;
  dryRun: boolean;
  manifest: boolean;
  yes: boolean;
}

const USAGE = [
  "usage: ternary review <path> [--staged | --all] [--dry-run | --manifest | --yes]",
  "",
  "  (no flag)    capture, confirm, and submit the Workspace Review for analysis",
  "  --yes        skip the interactive confirmation (for scripted/CI use)",
  "  --dry-run    build and report the Canonical Payload; transmit nothing",
  "  --manifest   report what would be captured; transmit nothing",
  "  --staged     changeset of the Git index only (HEAD vs index)",
  "  --all        bounded whole-workspace Snapshot Review",
].join("\n");

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "review") {
    throw new CollectorError("usage", `unknown command ${JSON.stringify(command ?? "")}\n${USAGE}`);
  }
  let path: string | null = null;
  let staged = false;
  let all = false;
  let dryRun = false;
  let manifest = false;
  let yes = false;
  for (const arg of rest) {
    if (arg === "--staged") staged = true;
    else if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--manifest") manifest = true;
    else if (arg === "--yes") yes = true;
    else if (arg.startsWith("--")) {
      throw new CollectorError("usage", `unknown flag ${JSON.stringify(arg)}\n${USAGE}`);
    } else if (path === null) path = arg;
    else throw new CollectorError("usage", `unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (path === null) throw new CollectorError("usage", `missing <path>\n${USAGE}`);
  if (staged && all) {
    throw new CollectorError("usage", "--staged and --all are mutually exclusive");
  }
  return { path, mode: staged ? "staged" : all ? "all" : "default", dryRun, manifest, yes };
}

function handleError(error: unknown, io: CliIo): number {
  if (error instanceof CollectorError) {
    io.stderr(`ternary: ${neutralizeControlSequences(error.message)}`);
    return error.code === "usage" ? 2 : 1;
  }
  if (error instanceof TransmitError) {
    io.stderr(`ternary: ${neutralizeControlSequences(error.message)}`);
    // Absent/misconfigured token or endpoint is a usage/config error (exit
    // 2, existing convention); every other transmit failure — rejection,
    // timeout, malformed response — is a transport/server error (exit 3).
    const isConfigError =
      error.code === "usage_missing_token" || error.code === "usage_missing_endpoint";
    return isConfigError ? 2 : 3;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`ternary: unexpected error: ${neutralizeControlSequences(message)}`);
  return 1;
}

// Exit codes:
//   0  verdict "pass"                       (submit path only)
//   1  verdict "findings", or a non-usage CollectorError (dry-run/manifest
//      hard errors, e.g. path escapes the Workspace Root)
//   2  usage/config error (bad argv, or the submit path missing
//      TERNARY_CLI_TOKEN / TERNARY_ENDPOINT, or a non-TTY confirmation
//      refusal without --yes) — existing convention, extended to transmit
//   3  transport/server error from the submit path (rejected by the server,
//      malformed response, or client-side timeout)
export function runCli(argv: string[], io: CliIo): number | Promise<number> {
  try {
    const args = parseArgs(argv);
    const rootAbs = resolve(io.cwd, args.path);

    if (args.dryRun || args.manifest) {
      const collected = collectWorkspaceReview(rootAbs, args.mode);
      const lines = renderReport({
        kind: collected.kind,
        captureMode: collected.captureMode,
        dryRun: args.dryRun,
        workspaceRoot: collected.rootAbs,
        payload: collected.finalized.payload,
        totalSourceBytes: collected.totalSourceBytes,
        totalPayloadBytes: collected.finalized.bytes.byteLength,
        digest: collected.finalized.digest,
      });
      for (const line of lines) io.stdout(line);
      return 0;
    }

    const submitIo: SubmitIo = {
      stdout: io.stdout,
      stderr: io.stderr,
      env: io.env ?? process.env,
      stdin: io.stdin ?? process.stdin,
    };
    return runSubmit(rootAbs, args.mode, args.yes, submitIo).catch((error: unknown) =>
      handleError(error, io),
    );
  } catch (error) {
    return handleError(error, io);
  }
}
