// TER-39 dogfood measurement harness.
//
// Runs the CLI's offline collection path (the exact code `ternary review
// <path> --dry-run` runs) across a set of targets and capture modes, and
// emits per-run metrics plus a secret-canary verdict computed against the
// real canonical payload bytes.
//
// Development/measurement tooling only — not part of the shipped CLI
// (cli/tsconfig.build.json compiles src/**, never scripts/**). Like its
// sibling scripts/generate-fixtures.ts it carries no *.test.ts: it produces a
// report, asserts nothing about product behaviour, and the collection logic it
// measures is covered by src/*.test.ts.
//
// ZERO NETWORK by construction: the only product module imported is
// the built ../dist/collect.js, whose import graph the zero-network module-graph test
// (src/zero-network.test.ts) asserts can never reach transmit.ts or any
// transport. This script imports nothing else from src/.
//
// Usage (run `npm run build` in cli/ first — this reads the built dist/):
//   node --experimental-strip-types cli/scripts/dogfood-measure.ts \
//     --target ternary=/path/to/repo \
//     --canary-target ordinary=/scratch/ter39/ordinary \
//     [--modes default,staged,all] \
//     [--repeat 3] \
//     [--json out.json] [--markdown out.md]
//
// --target measures only. --canary-target additionally asserts that no CANARIES
// needle appears in the canonical bytes; use it only for trees built by
// scripts/dogfood-fixtures.sh. Scanning a tree that legitimately contains the
// needles — this repo, whose harness sources spell them out — would report a
// self-reference as a leak, so canary scanning is opt-in per target.
//
// Every target is read-only: the harness never writes into a target tree.

import { writeFileSync } from "node:fs";
import { collectWorkspaceReview } from "../dist/collect.js";
import type { CanonicalPayload, CaptureMode } from "../dist/types.js";

// Needles planted by scripts/dogfood-fixtures.sh. A run is a secret-handling
// FAILURE if any of these appears anywhere in the canonical payload bytes.
export const CANARIES: ReadonlyArray<{ id: string; needle: string; where: string }> = [
  { id: "env-file", needle: "TERNARY_CANARY_ENV_9c1f2a7b40d5", where: ".env / .env.local value" },
  { id: "aws-key-in-source", needle: "AKIACANARY7EXAMPLE99", where: "src/config.ts AWS access key id" },
  {
    id: "aws-secret-in-source",
    needle: "wJalrXUtnFEMIK7MDENGbPxRfiCYCANARY9c1f2a",
    where: "src/config.ts AWS secret access key",
  },
  { id: "private-key-file", needle: "TERNARYCANARYPEM9c1f2a7b40d5", where: "secrets/deploy.key PEM body" },
  {
    id: "staged-gitignored",
    needle: "ghp_TERNARYCANARYGITIGNORED9c1f2a7b",
    where: "local-notes.txt (gitignored, force-staged)",
  },
  {
    id: "hardlinked-env",
    needle: "TERNARY_CANARY_HARDLINK_9c1f2a7b40d5",
    where: "config-notes.txt (hardlink to .env.shared)",
  },
  {
    id: "symlinked-outside-root",
    needle: "TERNARY_CANARY_SYMLINK_9c1f2a7b40d5",
    where: "src/linked-secret.ts -> ../outside/outside-secret.ts",
  },
  { id: "npmrc-token", needle: "TERNARY_CANARY_NPMRC_9c1f2a7b40d5", where: ".npmrc _authToken" },
];

// Deliberate negative control: an unpatterned string literal in a tracked
// source file. The deny classes and redaction rules are path- and
// pattern-based, so this SHOULD reach the payload. Reported, never failed on —
// it marks where the boundary actually is.
export const CONTROL_NEEDLE = "TERNARY_CONTROL_PLAINSTRING_9c1f2a7b40d5";

export interface RunMetrics {
  target: string;
  root: string;
  mode: CaptureMode;
  status: "ok" | "error";
  error?: string;
  kind?: string;
  digest?: string;
  wallClockMs?: number;
  wallClockMsSamples?: number[];
  payloadBytes?: number;
  sourceBytes?: number;
  capturedContentBytes?: number;
  manifestEntries?: number;
  includedFiles?: number;
  manifestOnlyEntries?: number;
  excludedFiles?: number;
  excludedByClass?: Record<string, number>;
  unverifiableFiles?: number;
  truncatedFiles?: number;
  truncatedBytesDropped?: number;
  truncationRatePct?: number;
  omittedManifestEntries?: number;
  redactedSpans?: number;
  redactedByRule?: Record<string, number>;
  canaryFailures?: string[];
  controlPresent?: boolean;
}

function tally(pairs: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of pairs) out[key] = (out[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function contentBytesOf(payload: CanonicalPayload): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const entry of payload.changeset ?? []) {
    if (entry.patch !== undefined) bytes += encoder.encode(entry.patch).byteLength;
    if (entry.content !== undefined) bytes += encoder.encode(entry.content).byteLength;
  }
  for (const entry of payload.snapshot ?? []) {
    bytes += encoder.encode(entry.content).byteLength;
  }
  for (const excerpt of payload.context) {
    bytes += encoder.encode(excerpt.content).byteLength;
  }
  return bytes;
}

export function measure(
  target: string,
  root: string,
  mode: CaptureMode,
  repeat: number,
  scanCanaries: boolean,
): RunMetrics {
  const samples: number[] = [];
  let collected;
  try {
    for (let i = 0; i < Math.max(1, repeat); i++) {
      const started = performance.now();
      collected = collectWorkspaceReview(root, mode);
      samples.push(Math.round((performance.now() - started) * 1000) / 1000);
    }
  } catch (error) {
    return {
      target,
      root,
      mode,
      status: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  if (collected === undefined) throw new Error("unreachable: no collection result");

  const payload = collected.finalized.payload;
  const bytes = collected.finalized.bytes;
  const text = new TextDecoder().decode(bytes);

  const truncatedDropped = payload.redaction.truncated.reduce(
    (sum, t) => sum + (t.originalBytes - t.keptBytes),
    0,
  );
  const truncatedOriginal = payload.redaction.truncated.reduce((sum, t) => sum + t.originalBytes, 0);
  const capturedContentBytes = contentBytesOf(payload);
  const excludedByClass = tally(payload.redaction.withheldFiles.map((w) => w.class));
  const redactedByRule: Record<string, number> = {};
  for (const span of payload.redaction.redactedSpans) {
    redactedByRule[span.rule] = (redactedByRule[span.rule] ?? 0) + span.count;
  }

  return {
    target,
    root: collected.rootAbs,
    mode,
    status: "ok",
    kind: collected.kind,
    digest: collected.finalized.digest,
    wallClockMs: Math.min(...samples),
    wallClockMsSamples: samples,
    payloadBytes: bytes.byteLength,
    sourceBytes: collected.totalSourceBytes,
    capturedContentBytes,
    manifestEntries: payload.manifest.length,
    includedFiles: payload.manifest.filter((m) => m.contentIncluded).length,
    manifestOnlyEntries: payload.manifest.filter((m) => !m.contentIncluded).length,
    excludedFiles: payload.redaction.withheldFiles.length,
    excludedByClass,
    unverifiableFiles: excludedByClass["unverifiable"] ?? 0,
    truncatedFiles: payload.redaction.truncated.length,
    truncatedBytesDropped: truncatedDropped,
    truncationRatePct:
      truncatedOriginal === 0 ? 0 : Math.round((truncatedDropped / truncatedOriginal) * 10000) / 100,
    omittedManifestEntries: payload.redaction.omittedManifestEntries,
    redactedSpans: payload.redaction.redactedSpans.reduce((sum, s) => sum + s.count, 0),
    redactedByRule: Object.fromEntries(
      Object.entries(redactedByRule).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    canaryFailures: scanCanaries
      ? CANARIES.filter((c) => text.includes(c.needle)).map((c) => c.id)
      : undefined,
    controlPresent: scanCanaries ? text.includes(CONTROL_NEEDLE) : undefined,
  };
}

const NUMERIC_COLUMNS: Array<[keyof RunMetrics, string]> = [
  ["payloadBytes", "payload bytes"],
  ["includedFiles", "included files"],
  ["manifestEntries", "manifest entries"],
  ["capturedContentBytes", "captured content bytes"],
  ["truncatedFiles", "truncated files"],
  ["truncatedBytesDropped", "bytes dropped"],
  ["excludedFiles", "excluded files"],
  ["unverifiableFiles", "unverifiable"],
  ["redactedSpans", "redacted spans"],
  ["wallClockMs", "capture ms"],
];

export function toMarkdown(runs: RunMetrics[]): string {
  const header = ["target", "mode", "kind", ...NUMERIC_COLUMNS.map(([, label]) => label), "canaries"];
  const rows = runs.map((run) => {
    if (run.status === "error") {
      return [run.target, run.mode, "ERROR", ...NUMERIC_COLUMNS.map(() => "—"), run.error ?? ""];
    }
    return [
      run.target,
      run.mode,
      run.kind ?? "",
      ...NUMERIC_COLUMNS.map(([key]) => String(run[key] ?? 0)),
      run.canaryFailures === undefined
        ? "not scanned"
        : run.canaryFailures.length > 0
          ? `LEAK: ${run.canaryFailures.join(", ")}`
          : "clean",
    ];
  });
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function parseArgv(argv: string[]): {
  targets: Array<{ name: string; path: string; canaries: boolean }>;
  modes: CaptureMode[];
  repeat: number;
  json?: string;
  markdown?: string;
} {
  const targets: Array<{ name: string; path: string; canaries: boolean }> = [];
  let modes: CaptureMode[] = ["default", "staged", "all"];
  let repeat = 3;
  let json: string | undefined;
  let markdown: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--target" || arg === "--canary-target") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq < 0) throw new Error(`${arg} expects name=path, got ${spec}`);
      targets.push({
        name: spec.slice(0, eq),
        path: spec.slice(eq + 1),
        canaries: arg === "--canary-target",
      });
    } else if (arg === "--modes") {
      modes = next().split(",") as CaptureMode[];
    } else if (arg === "--repeat") {
      repeat = Number(next());
    } else if (arg === "--json") {
      json = next();
    } else if (arg === "--markdown") {
      markdown = next();
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (targets.length === 0) {
    throw new Error("at least one --target/--canary-target name=path is required");
  }
  return { targets, modes, repeat, json, markdown };
}

function main(): void {
  const { targets, modes, repeat, json, markdown } = parseArgv(process.argv.slice(2));
  const runs: RunMetrics[] = [];
  for (const target of targets) {
    for (const mode of modes) {
      runs.push(measure(target.name, target.path, mode, repeat, target.canaries));
    }
  }
  const table = toMarkdown(runs);
  process.stdout.write(table + "\n");
  const scanned = runs.filter((r) => r.canaryFailures !== undefined);
  const leaks = scanned.flatMap((r) =>
    (r.canaryFailures ?? []).map((id) => `${r.target}/${r.mode}: ${id}`),
  );
  process.stdout.write(
    leaks.length === 0
      ? `\nsecret canaries: PASS (${CANARIES.length} needles, 0 occurrences across ${scanned.length} scanned runs)\n`
      : `\nsecret canaries: FAIL\n${leaks.map((l) => `  ${l}`).join("\n")}\n`,
  );
  const controls = runs.filter((r) => r.controlPresent === true).map((r) => `${r.target}/${r.mode}`);
  process.stdout.write(
    `negative control (unpatterned literal, expected to be transmitted) present in: ${
      controls.length === 0 ? "no run" : controls.join(", ")
    }\n`,
  );
  if (json !== undefined)
    writeFileSync(
      json,
      JSON.stringify({ canaries: CANARIES, controlNeedle: CONTROL_NEEDLE, runs }, null, 2) + "\n",
    );
  if (markdown !== undefined) writeFileSync(markdown, table + "\n");
  process.exitCode = leaks.length === 0 ? 0 : 1;
}

main();
