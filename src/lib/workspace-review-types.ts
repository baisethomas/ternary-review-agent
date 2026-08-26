/**
 * Workspace Review domain types (docs/workspace-review-spec.md).
 *
 * Workspace Review is a separate concept from the existing Review: it is
 * advisory (`pass` | `findings`), has no pull request, no merge boundary,
 * no GitHub side effects, and no Finding State lifecycle. Nothing here
 * changes `ReviewRequest` or any other shape in `types.ts`.
 */

import type { ReviewSeverity } from "./review-policy";
import type { SandboxResult } from "./types";

export type WorkspaceReviewKind = "changeset" | "snapshot";

/** Advisory verdict: "pass" means no findings at or above the reporting threshold. */
export type WorkspaceVerdict = "pass" | "findings";

/** Changeset entry per spec §8.2 — deletions carry no content and live only in the manifest. */
export type ChangesetEntry = {
  path: string;
  status: "added" | "modified" | "renamed";
  from?: string;
  /** Unified diff text; mutually exclusive with `content`. */
  patch?: string;
  /** Full file text for additions; mutually exclusive with `patch`. */
  content?: string;
};

/** Snapshot entry per spec §8.2 — full post-redaction/truncation file text. */
export type SnapshotEntry = {
  path: string;
  content: string;
};

/** Client- or server-selected bounded context per spec §8.2 (1-based inclusive integer lines). */
export type ContextExcerpt = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

/** The captured subject of one Workspace Review, already parsed from a Canonical Payload. */
export type WorkspaceChangeSet = {
  kind: WorkspaceReviewKind;
  workspaceLabel: string;
  vcs: "git" | "none";
  /** Changeset kind only. */
  baseState?: { headSha: string } | "unborn";
  branch?: string;
  /** Present when kind is "changeset". */
  changeset?: ChangesetEntry[];
  /** Present when kind is "snapshot". */
  snapshot?: SnapshotEntry[];
};

export type CommandEvidence = {
  command: string;
  exitCode: number;
  output: string;
};

/**
 * Evidence provenance per spec §3.2. Invariants (enforced by
 * `assertCheckEvidenceInvariants`): origin "local" implies trust
 * "unverified_client"; origin "sandbox" implies trust "isolated".
 * Local evidence is never treated as equivalent to sandbox evidence.
 */
export type CheckEvidence = {
  origin: "local" | "sandbox";
  trust: "unverified_client" | "isolated";
  status: "complete" | "partial" | "unavailable";
  /** Human label, e.g. "npm test" or "sandbox sbx_123". */
  label: string;
  commands: CommandEvidence[];
  truncation?: { skippedCommands: string[] };
  redaction?: { redactedSpans: number };
  unavailableReason?: string;
};

/**
 * WorkspaceFinding reuses the ReviewFinding severity vocabulary and
 * ruleId/findingKey identity fields, but has no Finding State lifecycle:
 * nothing is persisted, so there is nothing to reconcile across runs.
 */
export type WorkspaceFinding = {
  ruleId: string;
  findingKey: string;
  severity: ReviewSeverity;
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestedFix?: string;
};

export type WorkspaceReviewResult = {
  verdict: WorkspaceVerdict;
  summary: string;
  findings: WorkspaceFinding[];
  evidence: CheckEvidence[];
  /**
   * Count of inbound text fields (changeset/snapshot content, repository
   * context, evidence output, workspace label) that `redactSecrets` actually
   * changed before prompt construction (spec §4.3 defense in depth). Zero
   * means redaction ran and found nothing to withhold.
   */
  redactionApplied: number;
  /**
   * Findings dropped by the wrapper's finding-path boundary check (Phase-4
   * finding hygiene): a finding whose `file` does not normalize to a path
   * present in the submitted changeset/snapshot material is dropped, never
   * silently returned.
   */
  droppedFindings: { unknownPath: number };
  ai?: {
    model: string;
    latencyMs: number;
    /** Serving provider slug when the transport reports one; metadata only. */
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** Reasoning tokens when the provider reports them (ADR-0002: where the latency went). */
    reasoningTokens?: number;
    estimatedCostUsd?: number;
    /**
     * Model requests actually sent for this review: 1 or 2 (ADR-0002 option B,
     * bounded retry). Additive metadata — the `workspace-review/1` request
     * schema is unchanged and the CLI ignores fields it does not know.
     */
    attempts?: number;
    /** Why attempt 1 was retry-eligible, when a retry happened (error class or HTTP status). */
    retryReason?: string;
    /** Serving provider per attempt, when reported; attempt 2 is routed away from attempt 1's. */
    attempt1Provider?: string;
    attempt2Provider?: string;
  };
};

/** The slice of policy Workspace analysis consumes; server-owned, never client-raised. */
export type WorkspaceAnalysisPolicy = {
  model: string;
  minimumSeverity: ReviewSeverity;
  /** Bounded advisory report cap (spec §4.4 default 50). */
  maxFindings?: number;
};

export type WorkspaceAnalysisInput = {
  reviewKind: WorkspaceReviewKind;
  changeSet: WorkspaceChangeSet;
  /** Pre-rendered bounded Review Context text; may be empty. */
  repositoryContext: string;
  evidence: CheckEvidence[];
  policy: WorkspaceAnalysisPolicy;
  /** Absolute epoch-ms deadline; the model request is aborted at this instant. */
  deadlineAt: number;
};

export class InvalidCheckEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckEvidenceError";
  }
}

/** Enforce the structural origin→trust invariants from spec §3.2. */
export function assertCheckEvidenceInvariants(evidence: CheckEvidence) {
  if (evidence.origin === "local" && evidence.trust !== "unverified_client") {
    throw new InvalidCheckEvidenceError(`local evidence "${evidence.label}" must carry trust "unverified_client"`);
  }
  if (evidence.origin === "sandbox" && evidence.trust !== "isolated") {
    throw new InvalidCheckEvidenceError(`sandbox evidence "${evidence.label}" must carry trust "isolated"`);
  }
}

/** Build local (client-reported) evidence; trust is structurally "unverified_client". */
export function localCheckEvidence(
  label: string,
  commands: CommandEvidence[],
  status: CheckEvidence["status"] = "complete",
): CheckEvidence {
  return { origin: "local", trust: "unverified_client", status, label, commands };
}

/**
 * Adapt an existing PR-pipeline SandboxResult to CheckEvidence with sandbox
 * provenance. The GitHub path keeps consuming SandboxResult unchanged; this
 * adapter only translates for provenance-aware reporting.
 */
export function checkEvidenceFromSandboxResult(sandbox: SandboxResult): CheckEvidence {
  return {
    origin: "sandbox",
    trust: "isolated",
    status: sandbox.status ?? "complete",
    label: `sandbox ${sandbox.sandboxId}`,
    commands: sandbox.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      output: command.output,
    })),
    ...(sandbox.skippedCommands?.length ? { truncation: { skippedCommands: [...sandbox.skippedCommands] } } : {}),
    ...(sandbox.unavailableReason ? { unavailableReason: sandbox.unavailableReason } : {}),
  };
}

/** Advisory verdict from reported findings: "pass" iff none remain after policy filtering. */
export function workspaceVerdict(findings: WorkspaceFinding[]): WorkspaceVerdict {
  return findings.length ? "findings" : "pass";
}
