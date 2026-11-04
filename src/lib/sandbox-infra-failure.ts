import type { ReviewResult, SandboxResult } from "./types";

/** Check-run output.title for a completed code review (success, comment, or code failure). */
export const CODE_REVIEW_CHECK_TITLE = "Review complete";

/** Check-run output.title when sandbox failed for infrastructure reasons, not this PR's code. */
export const INFRA_CHECK_TITLE = "Sandbox infrastructure failure";

type InfraSandbox = Pick<SandboxResult, "ok" | "status"> & Partial<Pick<SandboxResult, "commands" | "unavailableReason" | "skippedReason">>;

export function isInfraSandboxFailure(sandbox: InfraSandbox) {
  if (sandbox.ok !== false) return false;
  if (sandbox.status === "unavailable" || sandbox.status === "partial") return true;
  return (sandbox.commands ?? []).some((command) => command.exitCode === 137);
}

function infraFailureDetail(sandbox: InfraSandbox) {
  if (sandbox.unavailableReason?.trim()) return sandbox.unavailableReason.trim();
  if (sandbox.status === "partial") return sandbox.skippedReason?.trim() || "sandbox did not finish";
  const killed = (sandbox.commands ?? []).find((command) => command.exitCode === 137);
  if (killed) return `\`${killed.command}\` was killed (exit 137)`;
  return "sandbox unavailable";
}

export function infraReviewSummary(sandbox: InfraSandbox) {
  return `Ternary could not run sandbox checks because of an infrastructure failure, not because of this pull request's code. ${infraFailureDetail(sandbox)}`;
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
