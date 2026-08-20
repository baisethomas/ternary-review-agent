// The submit entry path: capture -> dry-run-style summary -> interactive
// confirmation -> transmit -> render result.
//
// This is the one code path (besides transmit.ts itself) allowed to reach
// the transmit module (spec fixed decision 7; docs/workspace-review-endpoint
// .md §6). collect.ts, which does the actual capture/payload work, has no
// idea this module exists and never imports it.

import { createInterface } from "node:readline/promises";
import { collectWorkspaceReview } from "./collect.js";
import { neutralizeControlSequences, renderReport } from "./render.js";
import {
  DEFAULT_TIMEOUT_MS,
  resolveTransmitConfig,
  transmitCanonicalPayload,
} from "./transmit.js";
import type { WorkspaceReviewResult } from "./transmit.js";
import { CollectorError } from "./types.js";
import type { CaptureMode } from "./types.js";

export interface SubmitIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

export async function runSubmit(
  rootAbs: string,
  mode: CaptureMode,
  yes: boolean,
  io: SubmitIo,
): Promise<number> {
  const collected = collectWorkspaceReview(rootAbs, mode);
  const summaryLines = renderReport({
    kind: collected.kind,
    captureMode: collected.captureMode,
    // Reuse the exact dry-run rendering (mode, root, counts, digest) as the
    // pre-transmit summary; nothing has been transmitted at this point.
    dryRun: true,
    workspaceRoot: collected.rootAbs,
    payload: collected.finalized.payload,
    totalSourceBytes: collected.totalSourceBytes,
    totalPayloadBytes: collected.finalized.bytes.byteLength,
    digest: collected.finalized.digest,
  });
  for (const line of summaryLines) io.stdout(line);

  if (!yes) {
    await confirmOrThrow(io);
  }

  // Config is resolved (and TERNARY_CLI_TOKEN/TERNARY_ENDPOINT validated)
  // only once the operator has committed to submitting, so a missing-config
  // error never fires ahead of an unanswered confirmation prompt.
  const config = resolveTransmitConfig(io.env, DEFAULT_TIMEOUT_MS);
  const result = await transmitCanonicalPayload(
    collected.finalized.bytes,
    collected.finalized.digest,
    config,
  );
  renderResult(result, io);
  return result.verdict === "pass" ? 0 : 1;
}

async function confirmOrThrow(io: SubmitIo): Promise<void> {
  const isTTY = io.stdin.isTTY === true;
  if (!isTTY) {
    throw new CollectorError(
      "usage",
      "stdin is not a TTY; refusing to prompt for confirmation (no accidental hangs in CI). Pass --yes to submit non-interactively.",
    );
  }
  io.stdout('Submit this Workspace Review for analysis? Type "yes" to continue; anything else aborts.');
  const rl = createInterface({ input: io.stdin });
  let answer: string | undefined;
  try {
    const next = await rl[Symbol.asyncIterator]().next();
    answer = next.done ? undefined : next.value;
  } finally {
    rl.close();
  }
  if ((answer ?? "").trim().toLowerCase() !== "yes") {
    throw new CollectorError("usage", 'submission aborted: confirmation was not explicit "yes"');
  }
}

function renderResult(result: WorkspaceReviewResult, io: SubmitIo): void {
  const n = neutralizeControlSequences;
  io.stdout("");
  io.stdout(`verdict: ${result.verdict}`);
  io.stdout(n(result.summary));
  if (result.findings.length > 0) {
    io.stdout(`findings (${result.findings.length}):`);
    for (const finding of result.findings) {
      const location = finding.line !== undefined ? `${n(finding.file)}:${finding.line}` : n(finding.file);
      io.stdout(`  [${finding.severity}] ${location} — ${n(finding.title)}`);
      io.stdout(`    ${n(finding.explanation)}`);
      if (finding.suggestedFix !== undefined) {
        io.stdout(`    suggested fix: ${n(finding.suggestedFix)}`);
      }
    }
  }
  if (result.redactionApplied > 0) {
    io.stdout(`server-side redaction applied to ${result.redactionApplied} field(s)`);
  }
  if (result.droppedFindings.unknownPath > 0) {
    io.stdout(`${result.droppedFindings.unknownPath} finding(s) dropped: file path not present in the submitted material`);
  }
  if (result.ai !== undefined) {
    io.stdout(`model: ${n(result.ai.model)} (${result.ai.latencyMs} ms)`);
  }
}
