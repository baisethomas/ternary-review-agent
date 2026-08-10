export type ReviewRequest = {
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
  headSha: string;
  cloneUrl: string;
  author?: string;
};

export type WebhookReviewRequest = ReviewRequest & { webhookDeliveryId: string };

export type SandboxResult = {
  ok: boolean;
  commands: Array<{ command: string; exitCode: number; output: string }>;
  durationMs: number;
  sandboxId: string;
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
};
