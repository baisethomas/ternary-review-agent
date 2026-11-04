import { describe, expect, it } from "vitest";
import type { SandboxResult } from "./types";
import {
  CODE_REVIEW_CHECK_TITLE,
  INFRA_CHECK_TITLE,
  checkRunTitleFor,
  infraReviewResult,
  infraReviewSummary,
  isInfraSandboxFailure,
} from "./sandbox-infra-failure";

const unavailable: SandboxResult = {
  ok: false,
  commands: [],
  durationMs: 0,
  sandboxId: "unavailable",
  status: "unavailable",
  unavailableReason: "clone timed out",
};

const codeFailure: SandboxResult = {
  ok: false,
  commands: [{ command: "test", exitCode: 1, output: "1 failed" }],
  durationMs: 40,
  sandboxId: "sandbox-1",
};

describe("sandbox infra vs code failure labeling", () => {
  it("treats unavailable sandboxes as infra failures", () => {
    expect(isInfraSandboxFailure(unavailable)).toBe(true);
    expect(isInfraSandboxFailure({ ok: false, status: "unavailable" })).toBe(true);
    expect(infraReviewSummary(unavailable)).toContain("infrastructure failure");
    expect(infraReviewSummary(unavailable)).toContain("clone timed out");
    expect(infraReviewSummary(unavailable)).not.toMatch(/sandbox checks failed/i);
    const result = infraReviewResult(unavailable);
    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    expect(result.authoritativeFindings).toBe(false);
    expect(checkRunTitleFor(result)).toBe(INFRA_CHECK_TITLE);
  });

  it("does not treat command failures or skipped steps as infra", () => {
    expect(isInfraSandboxFailure(codeFailure)).toBe(false);
    expect(isInfraSandboxFailure({
      ok: false,
      status: "partial",
    })).toBe(false);
    expect(isInfraSandboxFailure({ ok: true, status: "unavailable" })).toBe(false);
    expect(checkRunTitleFor({
      verdict: "request_changes",
      summary: "One or more sandbox checks failed.",
      findings: [{ severity: "blocking", file: "", title: "Sandbox checks failed", explanation: "Inspect the sandbox command output before merging." }],
      sandbox: codeFailure,
    })).toBe(CODE_REVIEW_CHECK_TITLE);
  });
});
