export type ReviewRequest = {
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
  headSha: string;
  cloneUrl: string;
};

export type WebhookReviewRequest = ReviewRequest & { webhookDeliveryId: string };

export type SandboxResult = {
  ok: boolean;
  commands: Array<{ command: string; exitCode: number; output: string }>;
  durationMs: number;
  sandboxId: string;
};

export type ReviewFinding = {
  findingKey?: string;
  severity: "blocking" | "warning" | "suggestion";
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestedFix?: string;
};

export type ReviewResult = {
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  findings: ReviewFinding[];
  sandbox: SandboxResult;
};
