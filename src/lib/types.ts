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
};

export type SandboxResult = {
  /** True when every needed check ran and exited 0. Skipped needed steps set ok false; not-applicable and unavailable do not. */
  ok: boolean;
  commands: SandboxCommandResult[];
  durationMs: number;
  sandboxId: string;
  /** Absent means "complete". "partial": remaining needed checks were skipped or a repo command threw. "unavailable": sandbox could not run at all. */
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
