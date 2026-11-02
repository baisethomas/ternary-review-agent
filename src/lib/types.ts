import type { ResolvedReviewPolicy } from "./review-policy";

export type ReviewRequest = {
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
  headSha: string;
  cloneUrl: string;
  author?: string;
  policy?: ResolvedReviewPolicy;
};

export type WebhookReviewRequest = ReviewRequest & { webhookDeliveryId: string };

export type SandboxCommandResult = {
  command: string;
  exitCode: number;
  output: string;
  /** Set when the step failed because of a limit in Ternary's own tooling, not the code under review. */
  toolingFailure?: string;
};

export type SandboxResult = {
  /** True when no executed check failed because of the code under review; unrun or tooling-failed checks are reported via status, not ok. */
  ok: boolean;
  commands: SandboxCommandResult[];
  durationMs: number;
  sandboxId: string;
  /** Absent means "complete". "partial": the time budget or a Ternary tooling failure cut checks short. "unavailable": sandbox could not run at all. */
  status?: "complete" | "partial" | "unavailable";
  skippedCommands?: string[];
  skippedReason?: string;
  /** Checks that do not apply to this repository (for example JavaScript checks without a package.json); never run, never a failure. */
  notApplicableCommands?: string[];
  notApplicableReason?: string;
  unavailableReason?: string;
};

export type FindingState = "open" | "fixed" | "dismissed" | "superseded" | "stale";
export type FindingStateTransition = { state: FindingState; occurredAt: string; headSha: string; reason?: string; actor?: string };

export type ReviewFinding = {
  findingId?: string;
  findingKey?: string;
  supersedesFindingKey?: string;
  ruleId?: string;
  severity: "blocking" | "warning" | "suggestion";
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestedFix?: string;
  state?: FindingState;
  feedbackReason?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastHeadSha?: string;
  history?: FindingStateTransition[];
};

export type ReviewResult = {
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  findings: ReviewFinding[];
  sandbox: SandboxResult;
  authoritativeFindings?: boolean;
  ai?: {
    model: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  route?: import("./review-route-selector").ReviewRoute;
};
