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

const commandTimeout: SandboxResult = {
  ok: false,
  commands: [
    { command: "install dependencies", exitCode: 0, output: "" },
    { command: "lint", exitCode: 137, output: "" },
  ],
  durationMs: 120_000,
  sandboxId: "sandbox-1",
};

const oomKill: SandboxResult = {
  ok: false,
  commands: [{ command: "install dependencies", exitCode: 137, output: "Killed" }],
  durationMs: 8_000,
  sandboxId: "sandbox-1",
};

const budgetPartial: SandboxResult = {
  ok: false,
  status: "partial",
  commands: [
    { command: "install dependencies", exitCode: 0, output: "" },
    { command: "lint", exitCode: 0, output: "" },
  ],
  skippedCommands: ["typecheck", "test"],
  skippedReason: "sandbox time budget",
  durationMs: 100,
  sandboxId: "sandbox-1",
};

const sdkThrow: SandboxResult = {
  ok: false,
  status: "partial",
  commands: [{ command: "install dependencies", exitCode: 1, output: "sandbox command aborted" }],
  skippedCommands: ["lint", "typecheck", "test", "build"],
  skippedReason: "sandbox command failed",
  durationMs: 20,
  sandboxId: "sandbox-1",
};

function expectInfra(sandbox: SandboxResult) {
  expect(isInfraSandboxFailure(sandbox)).toBe(true);
  const result = infraReviewResult(sandbox);
  expect(result.verdict).toBe("request_changes");
  expect(result.findings).toEqual([]);
  expect(result.authoritativeFindings).toBe(false);
  expect(checkRunTitleFor(result)).toBe(INFRA_CHECK_TITLE);
  expect(infraReviewSummary(sandbox)).toContain("infrastructure failure");
}

describe("sandbox infra vs code failure labeling", () => {
  it("treats unavailable sandboxes as infra failures", () => {
    expectInfra(unavailable);
    expect(isInfraSandboxFailure({ ok: false, status: "unavailable" })).toBe(true);
    expect(infraReviewSummary(unavailable)).toContain("clone timed out");
    expect(infraReviewSummary(unavailable)).not.toMatch(/sandbox checks failed/i);
  });

  it("labels a mid-run command timeout as infra", () => {
    expectInfra(commandTimeout);
    expect(infraReviewSummary(commandTimeout)).toContain("`lint` was killed (exit 137)");
  });

  it("labels an exit 137 OOM kill as infra", () => {
    expectInfra(oomKill);
    expect(infraReviewSummary(oomKill)).toContain("`install dependencies` was killed (exit 137)");
  });

  it("labels a budget partial result as infra", () => {
    expectInfra(budgetPartial);
    expect(infraReviewSummary(budgetPartial)).toContain("sandbox time budget");
  });

  it("labels an SDK throw in the middle of a command as infra", () => {
    expectInfra(sdkThrow);
    expect(infraReviewSummary(sdkThrow)).toContain("sandbox command failed");
  });

  it("does not treat a genuine test failure as infra", () => {
    expect(isInfraSandboxFailure(codeFailure)).toBe(false);
    expect(isInfraSandboxFailure({ ok: true, status: "unavailable" })).toBe(false);
    expect(checkRunTitleFor({
      verdict: "request_changes",
      summary: "One or more sandbox checks failed.",
      findings: [{ severity: "blocking", file: "", title: "Sandbox checks failed", explanation: "Inspect the sandbox command output before merging." }],
      sandbox: codeFailure,
    })).toBe(CODE_REVIEW_CHECK_TITLE);
  });
});
