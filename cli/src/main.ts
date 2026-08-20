// Argv wiring for the offline Workspace Review collector.
//
// This module (and everything it imports) is the dry-run/manifest entry path:
// it never imports the transmit module or any networking transport, which the
// zero-network module-graph test asserts structurally.

import { resolve } from "node:path";
import { captureWorkspace, loadLocalPolicy, makeContentReaders } from "./capture.js";
import { runExclusionPipeline } from "./deny.js";
import { finalizePayload } from "./payload.js";
import { neutralizeControlSequences, renderReport } from "./render.js";
import {
  CollectorError,
  DEFAULT_CAPS,
  DENY_RULES_VERSION,
  SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
} from "./types.js";
import type { CanonicalPayload, CaptureMode } from "./types.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
}

interface ParsedArgs {
  path: string;
  mode: CaptureMode;
  dryRun: boolean;
  manifest: boolean;
}

const USAGE = [
  "usage: ternary review <path> [--staged | --all] (--dry-run | --manifest)",
  "",
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
  for (const arg of rest) {
    if (arg === "--staged") staged = true;
    else if (arg === "--all") all = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--manifest") manifest = true;
    else if (arg.startsWith("--")) {
      throw new CollectorError("usage", `unknown flag ${JSON.stringify(arg)}\n${USAGE}`);
    } else if (path === null) path = arg;
    else throw new CollectorError("usage", `unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (path === null) throw new CollectorError("usage", `missing <path>\n${USAGE}`);
  if (staged && all) {
    throw new CollectorError("usage", "--staged and --all are mutually exclusive");
  }
  if (!dryRun && !manifest) {
    throw new CollectorError(
      "usage",
      "transmission is not implemented in this phase; run with --dry-run or --manifest",
    );
  }
  return { path, mode: staged ? "staged" : all ? "all" : "default", dryRun, manifest };
}

export function runCli(argv: string[], io: CliIo): number {
  try {
    const args = parseArgs(argv);
    const capture = captureWorkspace(resolve(io.cwd, args.path), args.mode);
    const rootAbs = capture.workspace.rootAbs;
    const policy = loadLocalPolicy(rootAbs, capture.workspace.vcs);
    const readers = makeContentReaders(rootAbs, capture.workspace);
    const outcome = runExclusionPipeline(capture, policy, DEFAULT_CAPS, readers);

    const payload: CanonicalPayload = {
      schemaVersion: SCHEMA_VERSION,
      kind: capture.kind,
      captureMode: capture.captureMode,
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      workspace: {
        label: capture.workspace.label,
        vcs: capture.workspace.vcs,
        ...(capture.kind === "changeset"
          ? {
              baseState: capture.workspace.unborn
                ? ("unborn" as const)
                : { headSha: capture.workspace.headSha as string },
            }
          : {}),
        ...(capture.workspace.branch !== undefined ? { branch: capture.workspace.branch } : {}),
      },
      manifest: outcome.manifest,
      ...(outcome.changeset !== undefined ? { changeset: outcome.changeset } : {}),
      ...(outcome.snapshot !== undefined ? { snapshot: outcome.snapshot } : {}),
      context: [], // bounded context selection lands with the analysis phase (TER-37)
      localPolicy: {
        captureMode: capture.captureMode,
        include: ["**"],
        exclude: policy.excludePatterns,
        denyRulesVersion: DENY_RULES_VERSION,
        caps: DEFAULT_CAPS,
      },
      redaction: outcome.redaction,
    };

    const finalized = finalizePayload(payload, DEFAULT_CAPS);
    const lines = renderReport({
      kind: capture.kind,
      captureMode: capture.captureMode,
      dryRun: args.dryRun,
      workspaceRoot: rootAbs,
      payload: finalized.payload,
      totalSourceBytes: outcome.totalSourceBytes,
      totalPayloadBytes: finalized.bytes.byteLength,
      digest: finalized.digest,
    });
    for (const line of lines) io.stdout(line);
    return 0;
  } catch (error) {
    if (error instanceof CollectorError) {
      io.stderr(`ternary: ${neutralizeControlSequences(error.message)}`);
      return error.code === "usage" ? 2 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`ternary: unexpected error: ${neutralizeControlSequences(message)}`);
    return 1;
  }
}
