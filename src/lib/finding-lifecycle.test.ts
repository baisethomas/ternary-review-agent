import { describe, expect, it } from "vitest";
import { projectFindingLifecycles } from "./finding-lifecycle";
import type { ReviewEvent } from "./review-event-ledger";

const scope = { installationId: 7, owner: "Ternary", repo: "Agent" };
function completed(headSha: string, occurredAt: string, findings: Array<{ findingId: string; findingKey: string; ruleId: string; file: string; line: number }>): ReviewEvent {
  return { eventId: `completed-${headSha}`, idempotencyKey: `completed-${headSha}`, reviewId: `ternary/agent#8:${headSha}`, type: "review.completed", occurredAt, scope, pullNumber: 8, headSha, payload: { jobId: `job-${headSha}`, attempt: 1, verdict: findings.length ? "request_changes" : "approve", summary: "Review", findings: findings.map((finding) => ({ ...finding, severity: "warning", title: "Finding", explanation: "Explanation" })), sandbox: { sandboxId: "sandbox", durationMs: 1, commands: [] } } };
}
function feedback(kind: "dismissed" | "resolved" | "reopened", occurredAt: string, reason?: string): ReviewEvent {
  return { eventId: `${kind}-${occurredAt}`, idempotencyKey: `${kind}-${occurredAt}`, reviewId: "ternary/agent#8:head-b", type: "finding.feedback_recorded", occurredAt, scope, pullNumber: 8, headSha: "head-b", payload: { findingId: "finding-auth", kind, actor: "maintainer", ...(reason ? { reason } : {}) } };
}
function stateChanged(state: "open" | "fixed" | "dismissed" | "superseded" | "stale", occurredAt: string, headSha = "head-b", reason = "Recorded lifecycle transition"): ReviewEvent {
  return { eventId: `${state}-${occurredAt}`, idempotencyKey: `${state}-${occurredAt}`, reviewId: `ternary/agent#8:${headSha}`, type: "finding.state_changed", occurredAt, scope, pullNumber: 8, headSha, payload: { findingId: "finding-auth", state, reason } };
}
function headChanged(headSha: string, previousHeadSha: string, occurredAt: string): ReviewEvent {
  return { eventId: `head-${headSha}`, idempotencyKey: `head-${headSha}`, reviewId: `ternary/agent#8:${headSha}`, type: "pull_request.head_changed", occurredAt, scope, pullNumber: 8, headSha, payload: { changedAt: occurredAt, previousHeadSha } };
}
function dismissalReaction(id: string, active: boolean, occurredAt: string): ReviewEvent {
  return { eventId: `${id}-${active}`, idempotencyKey: `${id}-${active}`, reviewId: "ternary/agent#8:head-a", type: "finding.feedback_recorded", occurredAt, scope, pullNumber: 8, headSha: "head-a", payload: { findingId: "finding-auth", kind: "reaction", actor: "maintainer", signal: { id, type: "dismissal_reaction", active } } };
}

describe("finding lifecycle projection", () => {
  const auth = { findingId: "finding-auth", findingKey: "security-auth", ruleId: "security-authorization", file: "src/auth.ts", line: 10 };

  it("keeps identity while reconciling moved lines and marks an absent finding fixed", () => {
    const moved = { ...auth, file: "src/moved/auth.ts", line: 42 };
    expect(projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), completed("head-b", "2026-08-02T00:00:00Z", [moved])])).toMatchObject([{ findingId: "finding-auth", state: "open", file: "src/moved/auth.ts", line: 42 }]);
    expect(projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), completed("head-b", "2026-08-02T00:00:00Z", [])])).toMatchObject([{ findingId: "finding-auth", state: "fixed" }]);
  });

  it("preserves dismissal reasons and reopens a resolved finding that returns", () => {
    const dismissed = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), feedback("dismissed", "2026-08-01T01:00:00Z", "Intentional tradeoff")]);
    expect(dismissed).toMatchObject([{ state: "dismissed", feedbackReason: "Intentional tradeoff" }]);
    const returned = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), feedback("resolved", "2026-08-01T01:00:00Z"), completed("head-b", "2026-08-02T00:00:00Z", [auth])]);
    expect(returned[0]).toMatchObject({ state: "open", history: expect.arrayContaining([expect.objectContaining({ state: "fixed" }), expect.objectContaining({ state: "open" })]) });
  });

  it("coalesces a feedback event and its structured state fact into one transition", () => {
    const state = stateChanged("dismissed", "2026-08-01T01:00:00Z", "head-a", "Intentional tradeoff");
    const result = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), feedback("dismissed", "2026-08-01T01:00:00Z", "Intentional tradeoff"), state]);
    expect(result[0].history.filter((item) => item.state === "dismissed")).toHaveLength(1);
  });

  it("reopens only after the last active dismissing reaction is removed", () => {
    const events = [
      completed("head-a", "2026-08-01T00:00:00Z", [auth]),
      dismissalReaction("reaction-1", true, "2026-08-01T01:00:00Z"),
      dismissalReaction("reaction-2", true, "2026-08-01T01:01:00Z"),
      dismissalReaction("reaction-1", false, "2026-08-01T01:02:00Z"),
    ];
    expect(projectFindingLifecycles(events)[0].state).toBe("dismissed");
    expect(projectFindingLifecycles([...events, dismissalReaction("reaction-2", false, "2026-08-01T01:03:00Z")])[0].state).toBe("open");
  });

  it("uses ledger sequence to order opposite reactions with identical timestamps", () => {
    const occurredAt = "2026-08-01T01:00:00Z";
    const created = { ...dismissalReaction("reaction-1", true, occurredAt), sequence: "2" };
    const deleted = { ...dismissalReaction("reaction-1", false, occurredAt), sequence: "3" };
    const base = completed("head-a", "2026-08-01T00:00:00Z", [auth]);

    expect(projectFindingLifecycles([base, deleted, created])[0].state).toBe("open");
    expect(projectFindingLifecycles([base, { ...deleted, sequence: "1" }, created])[0].state).toBe("dismissed");
  });

  it("restores the underlying explicit state when the last reaction is removed", () => {
    const base = completed("head-a", "2026-08-01T00:00:00Z", [auth]);
    const reactions = [
      dismissalReaction("reaction-1", true, "2026-08-01T02:00:00Z"),
      dismissalReaction("reaction-1", false, "2026-08-01T03:00:00Z"),
    ];
    expect(projectFindingLifecycles([base, feedback("dismissed", "2026-08-01T01:00:00Z"), ...reactions])[0].state).toBe("dismissed");
    expect(projectFindingLifecycles([base, feedback("resolved", "2026-08-01T01:00:00Z"), ...reactions])[0].state).toBe("fixed");
  });

  it("marks open findings stale until the newest head is reviewed", () => {
    expect(projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth])], "head-b")).toMatchObject([{
      state: "stale", lastHeadSha: "head-a",
      history: expect.arrayContaining([expect.objectContaining({ state: "stale", headSha: "head-b", reason: expect.stringContaining("live pull request head") })]),
    }]);
  });

  it("uses durable state facts for timestamped lifecycle history", () => {
    const result = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), stateChanged("stale", "2026-08-01T12:00:00Z")]);
    expect(result[0]).toMatchObject({ state: "stale", history: expect.arrayContaining([expect.objectContaining({ state: "stale", occurredAt: "2026-08-01T12:00:00Z" })]) });
  });

  it("marks a prior finding superseded when a new semantic identity replaces it", () => {
    const replacement = { ...auth, findingId: "finding-auth-v2", findingKey: "security-auth-v2", supersedesFindingKey: "security-auth" };
    const result = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), completed("head-b", "2026-08-02T00:00:00Z", [replacement])]);
    expect(result.find((finding) => finding.findingId === "finding-auth")?.state).toBe("superseded");
  });

  it("keeps a superseded finding terminal when later reviews retain its replacement", () => {
    const replacement = { ...auth, findingId: "finding-auth-v2", findingKey: "security-auth-v2", supersedesFindingKey: "security-auth" };
    const retainedReplacement = { ...replacement, supersedesFindingKey: undefined };
    const result = projectFindingLifecycles([
      completed("head-a", "2026-08-01T00:00:00Z", [auth]),
      completed("head-b", "2026-08-02T00:00:00Z", [replacement]),
      completed("head-c", "2026-08-03T00:00:00Z", [retainedReplacement]),
    ]);
    expect(result.find((finding) => finding.findingId === "finding-auth")?.state).toBe("superseded");
  });

  it("marks an absent finding fixed when a different finding shares its rule and file", () => {
    const unrelated = { ...auth, findingId: "finding-other-handler", findingKey: "security-other-handler" };
    const result = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), completed("head-b", "2026-08-02T00:00:00Z", [unrelated])]);
    expect(result.find((finding) => finding.findingId === "finding-auth")?.state).toBe("fixed");
  });

  it("preserves open findings across a non-authoritative fallback review", () => {
    const fallback = completed("head-b", "2026-08-02T00:00:00Z", []);
    if (fallback.type !== "review.completed") throw new Error("Expected completion fixture");
    fallback.payload.authoritativeFindings = false;
    const result = projectFindingLifecycles([completed("head-a", "2026-08-01T00:00:00Z", [auth]), fallback]);
    expect(result.find((finding) => finding.findingId === "finding-auth")?.state).toBe("open");
  });

  it("replays feedback that arrives before review completion is committed", () => {
    const earlyFeedback = feedback("dismissed", "2026-08-01T00:00:00Z", "Accepted webhook before worker acknowledgement");
    const result = projectFindingLifecycles([earlyFeedback, completed("head-a", "2026-08-01T00:00:01Z", [auth])]);
    expect(result).toMatchObject([{ state: "dismissed", feedbackReason: "Accepted webhook before worker acknowledgement" }]);
  });

  it("keeps the current head authoritative when an older review finishes late", () => {
    const currentOnly = { ...auth, findingId: "finding-current", findingKey: "correctness-current", file: "src/current.ts" };
    const moved = { ...auth, file: "src/current/auth.ts", line: 42 };
    const events = [
      completed("head-a", "2026-08-01T00:00:00Z", [auth]),
      headChanged("head-b", "head-a", "2026-08-02T00:00:00Z"),
      completed("head-b", "2026-08-02T00:01:00Z", [moved, currentOnly]),
      completed("head-a", "2026-08-02T00:02:00Z", [auth]),
    ];

    const result = projectFindingLifecycles(events, "head-b");

    expect(result.find((finding) => finding.findingId === "finding-auth")).toMatchObject({ state: "open", file: "src/current/auth.ts", lastHeadSha: "head-b" });
    expect(result.find((finding) => finding.findingId === "finding-current")).toMatchObject({ state: "open", lastHeadSha: "head-b" });
  });

  it("uses the supplied live head when no head-change event was recorded", () => {
    const currentOnly = { ...auth, findingId: "finding-current", findingKey: "correctness-current", file: "src/current.ts" };
    const current = { ...auth, file: "src/current/auth.ts", line: 42 };
    const result = projectFindingLifecycles([
      completed("head-b", "2026-08-02T00:01:00Z", [current, currentOnly]),
      completed("head-a", "2026-08-02T00:02:00Z", [auth]),
    ], "head-b");

    expect(result.find((finding) => finding.findingId === "finding-auth")).toMatchObject({ state: "open", file: "src/current/auth.ts", lastHeadSha: "head-b" });
    expect(result.find((finding) => finding.findingId === "finding-current")).toMatchObject({ state: "open", lastHeadSha: "head-b" });
  });
});
