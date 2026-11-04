import type { ReviewResult, SandboxResult } from "./types";

/** Check-run output.title for a completed code review (success, comment, or code failure). */
export const CODE_REVIEW_CHECK_TITLE = "Review complete";

/** Check-run output.title when the sandbox never ran for Ternary-side reasons. */
export const INFRA_CHECK_TITLE = "Sandbox infrastructure failure";

export function isInfraSandboxFailure(sandbox: Pick<SandboxResult, "ok" | "status">) {
  return sandbox.ok === false && sandbox.status === "unavailable";
}

export function infraReviewSummary(sandbox: Pick<SandboxResult, "unavailableReason">) {
  const reason = sandbox.unavailableReason?.trim() || "sandbox unavailable";
  return `Ternary could not run sandbox checks because of an infrastructure failure, not because of this pull request's code. ${reason}`;
}

export function infraReviewResult(sandbox: SandboxResult): ReviewResult {
  return {
    verdict: "request_changes",
    summary: infraReviewSummary(sandbox),
    findings: [],
    sandbox,
    authoritativeFindings: false,
  };
}

export function checkRunTitleFor(result: ReviewResult) {
  return isInfraSandboxFailure(result.sandbox) ? INFRA_CHECK_TITLE : CODE_REVIEW_CHECK_TITLE;
}
