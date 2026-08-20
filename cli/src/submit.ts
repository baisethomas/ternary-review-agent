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
  TransmitError,
  transmitCanonicalPayload,
} from "./transmit.js";
import type { WorkspaceReviewResult } from "./transmit.js";
import { CollectorError } from "./types.js";
import type { CaptureMode } from "./types.js";

export interface SubmitIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /**
   * Optional external abort signal (wired from the CLI entry's SIGINT
   * handler; see cli/bin/ternary.mjs). When set, an in-flight transmit ends
   * the same way a client timeout does, but is reported as `TransmitError`
   * code "aborted" — a deliberate user interrupt, never a config/usage error.
   */
  signal?: AbortSignal;
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
    await confirmOrThrow(io, CONFIRM_TIMEOUT_MS);
  }

  // Config is resolved (and TERNARY_CLI_TOKEN/TERNARY_ENDPOINT validated)
  // only once the operator has committed to submitting, so a missing-config
  // error never fires ahead of an unanswered confirmation prompt.
  const config = resolveTransmitConfig(io.env, DEFAULT_TIMEOUT_MS);
  const result = await transmitCanonicalPayload(
    collected.finalized.bytes,
    collected.finalized.digest,
    config,
    io.signal,
  );
  renderResult(result, io);
  return result.verdict === "pass" ? 0 : 1;
}

// The confirmation prompt must never hang: (1) a stdin that ends/closes
// without ever emitting a line must resolve as an abort, not wait forever on
// the readline async iterator, and (2) an operator who walks away must not
// leave the process running indefinitely, so a timeout race aborts on their
// behalf too. Both races are decided by Promise.race against the same
// readline read, so whichever settles first wins and the others are moot.
export const CONFIRM_TIMEOUT_MS = 60_000;

export async function confirmOrThrow(io: SubmitIo, timeoutMs: number = CONFIRM_TIMEOUT_MS): Promise<void> {
  const isTTY = io.stdin.isTTY === true;
  if (!isTTY) {
    throw new CollectorError(
      "usage",
      "stdin is not a TTY; refusing to prompt for confirmation (no accidental hangs in CI). Pass --yes to submit non-interactively.",
    );
  }
  io.stdout('Submit this Workspace Review for analysis? Type "yes" to continue; anything else aborts.');
  const rl = createInterface({ input: io.stdin });
  let timer: NodeJS.Timeout | undefined;
  let answer: string | undefined;
  // Race the confirmation read against the external abort signal too (the
  // CLI's SIGINT handler; see SubmitIo.signal): without this, the whole-run
  // SIGINT listener disables Node's default SIGINT kill, and this prompt
  // never observes `io.signal`, so Ctrl+C here just keeps the prompt
  // waiting on input/close/the 60s timer instead of ending immediately.
  let onSignalAbort: (() => void) | undefined;
  try {
    const outcome = await Promise.race<"answered" | "closed" | "timeout" | "signalAborted">([
      (async () => {
        const next = await rl[Symbol.asyncIterator]().next();
        answer = next.done ? undefined : next.value;
        return "answered" as const;
      })(),
      // Listen on the raw input stream's own 'close', not readline's: when
      // stdin is destroyed (as opposed to ended gracefully) readline's
      // 'close' event never fires and the async iterator's `.next()` never
      // settles on its own — exactly the hang this guards against.
      new Promise<"closed">((resolve) => io.stdin.once("close", () => resolve("closed"))),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
      new Promise<"signalAborted">((resolve) => {
        if (io.signal === undefined) return; // no external signal wired: never settles
        if (io.signal.aborted) {
          resolve("signalAborted");
          return;
        }
        onSignalAbort = () => resolve("signalAborted");
        io.signal.addEventListener("abort", onSignalAbort, { once: true });
      }),
    ]);

    if (outcome === "signalAborted") {
      // A deliberate user interrupt, reported the same way transmit.ts
      // reports one: `TransmitError` code "aborted", which runCli maps to
      // exit code 130 — never a CollectorError, and never Ternary-branded
      // config/usage text.
      throw new TransmitError("aborted", "Workspace Review confirmation aborted by interrupt");
    }
    if (outcome === "timeout") {
      throw new CollectorError(
        "usage",
        `confirmation timed out after ${timeoutMs} ms waiting for an answer; pass --yes to submit non-interactively`,
      );
    }
    if (outcome === "closed" || (answer ?? "").trim().toLowerCase() !== "yes") {
      throw new CollectorError("usage", 'submission aborted: confirmation was not explicit "yes"');
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (io.signal !== undefined && onSignalAbort !== undefined) {
      io.signal.removeEventListener("abort", onSignalAbort);
    }
    rl.close();
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
