// Terminal rendering with control-sequence neutralization (spec section 10).
// Pure module: no filesystem, no git, no network.
//
// Everything rendered — filenames, branch names, reason codes sourced from
// data, future model output — is untrusted text. Every control character
// (ESC, C1 controls including CSI 0x9b, bare CR, and the rest of C0 except
// \n and \t used by our own layout) is replaced with a visible escaped form,
// so the only escape sequences in the output are the CLI's own (none today).

import type { CanonicalPayload, CaptureMode, ReviewKind } from "./types.js";

export function neutralizeControlSequences(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const isC0 = code < 0x20 && code !== 0x0a && code !== 0x09;
    const isDelOrC1 = code >= 0x7f && code <= 0x9f;
    if (isC0 || isDelOrC1) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export interface SnapshotCoverage {
  includedFiles: number;
  eligibleFiles: number;
  coveredBytes: number;
  eligibleBytes: number;
  pct: number;
}

// TER-47 (dogfood §8.12): a `--all` snapshot silently drops files once the
// snapshot budget/caps are hit, so "0 findings" can mean "clean" or "most of
// the workspace was never looked at" — indistinguishable without this. This
// reports what fraction of the *eligible* source was actually included.
//
// "Eligible" deliberately excludes binary, oversize, withheld (deny-listed),
// deleted, and symlink manifest entries: none of those could ever carry
// reviewable content (there is no byte budget that would have included them),
// so counting them as part of the denominator would overstate the coverage
// gap with files that were never candidates for inclusion in the first
// place. Only content that was included, or that was cut for budget/size
// reasons (truncated entries), counts toward eligibility.
export function snapshotCoverage(payload: CanonicalPayload): SnapshotCoverage {
  const included = payload.manifest.filter((m) => m.contentIncluded);
  const truncatedToZero = payload.redaction.truncated.filter((t) => t.keptBytes === 0);
  const includedFiles = included.length;
  const eligibleFiles = includedFiles + truncatedToZero.length;

  // A manifest entry's `size` is always the ORIGINAL on-disk byte length
  // (deny.ts's collector never mutates it after slicing) — the bytes lost to
  // slicing are visible only via the `truncated` record's
  // originalBytes/keptBytes, subtracted below. Summing `size` here and NOT
  // subtracting the partial-truncation loss would double count a sliced
  // file's kept bytes.
  const includedBytes = included.reduce((sum, m) => sum + m.size, 0);
  const truncationLoss = (t: { originalBytes: number; keptBytes: number }) => t.originalBytes - t.keptBytes;
  const partialTruncationLoss = payload.redaction.truncated
    .filter((t) => t.keptBytes > 0)
    .reduce((sum, t) => sum + truncationLoss(t), 0);
  const totalTruncationLoss = payload.redaction.truncated.reduce((sum, t) => sum + truncationLoss(t), 0);

  const coveredBytes = includedBytes - partialTruncationLoss;
  const eligibleBytes = coveredBytes + totalTruncationLoss;
  const pct = eligibleBytes === 0 ? 100 : Math.round((100 * coveredBytes) / eligibleBytes);

  return { includedFiles, eligibleFiles, coveredBytes, eligibleBytes, pct };
}

export interface ReviewReport {
  kind: ReviewKind;
  captureMode: CaptureMode;
  dryRun: boolean;
  workspaceRoot: string;
  payload: CanonicalPayload;
  totalSourceBytes: number;
  totalPayloadBytes: number;
  digest: string;
}

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unchanged: " ",
};

export function renderReport(report: ReviewReport): string[] {
  const n = neutralizeControlSequences;
  const p = report.payload;
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? "Ternary Workspace Review — dry run (nothing transmitted)"
      : "Ternary Workspace Review — manifest (nothing transmitted)",
  );
  lines.push(`review mode:       ${p.kind} (${p.captureMode} capture)`);
  lines.push(`workspace root:    ${n(report.workspaceRoot)}`);
  if (p.workspace.branch !== undefined) {
    lines.push(`branch:            ${n(p.workspace.branch)}`);
  }
  if (p.workspace.baseState === "unborn") {
    lines.push("base state:        unborn HEAD (all files are additions)");
  } else if (p.workspace.baseState !== undefined) {
    lines.push(`base state:        HEAD ${n(p.workspace.baseState.headSha)}`);
  }
  lines.push(`schema version:    ${n(p.schemaVersion)}`);
  lines.push(`canonical digest:  ${n(report.digest)}`);

  const included = p.manifest.filter((m) => m.contentIncluded);
  const markers = p.manifest.filter((m) => !m.contentIncluded);
  lines.push(`included files (${included.length}):`);
  for (const entry of included) {
    const letter = STATUS_LETTER[entry.status] ?? "?";
    const renamedFrom = entry.from !== undefined ? ` (from ${n(entry.from)})` : "";
    lines.push(`  ${letter} ${n(entry.path)}${renamedFrom} — ${entry.size} bytes`);
  }
  lines.push(`manifest-only entries (${markers.length}):`);
  for (const entry of markers) {
    const marks = [
      entry.binary === true ? "binary" : null,
      entry.oversize === true ? "oversize" : null,
      entry.lfs === true ? "lfs-pointer" : null,
      entry.mode === "symlink" ? "symlink" : null,
      entry.status === "deleted" ? "deleted" : null,
    ]
      .filter((m) => m !== null)
      .join(", ");
    lines.push(`  ${STATUS_LETTER[entry.status] ?? "?"} ${n(entry.path)}${marks === "" ? "" : ` — ${marks}`}`);
  }
  lines.push(`excluded files (${p.redaction.withheldFiles.length}):`);
  for (const withheld of p.redaction.withheldFiles) {
    lines.push(`  ${n(withheld.path)} — ${n(withheld.class)}`);
  }
  lines.push(`truncated files (${p.redaction.truncated.length}):`);
  for (const t of p.redaction.truncated) {
    lines.push(`  ${n(t.path)} — kept ${t.keptBytes} of ${t.originalBytes} bytes`);
  }
  if (p.redaction.redactedSpans.length > 0) {
    lines.push(`redacted spans (${p.redaction.redactedSpans.length}):`);
    for (const span of p.redaction.redactedSpans) {
      lines.push(`  ${n(span.path)} — ${n(span.rule)} × ${span.count}`);
    }
  }
  if (p.redaction.omittedManifestEntries > 0) {
    lines.push(`manifest entries omitted beyond cap: ${p.redaction.omittedManifestEntries}`);
  }
  lines.push(`total source bytes:  ${report.totalSourceBytes}`);
  lines.push(`total payload bytes: ${report.totalPayloadBytes}`);
  if (p.kind === "snapshot") {
    const coverage = snapshotCoverage(p);
    lines.push(
      `coverage: content included for ${coverage.includedFiles} of ${coverage.eligibleFiles} eligible files (${coverage.pct}% of eligible bytes)`,
    );
  }
  return lines;
}
