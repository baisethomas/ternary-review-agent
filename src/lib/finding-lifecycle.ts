import type { FindingSnapshot, ReviewEvent } from "./review-event-ledger";
import type { FindingState, FindingStateTransition } from "./types";

export type { FindingState, FindingStateTransition } from "./types";

export type FindingLifecycle = FindingSnapshot & {
  state: FindingState;
  firstSeenAt: string;
  lastSeenAt: string;
  lastHeadSha: string;
  feedbackReason?: string;
  history: FindingStateTransition[];
};

type FindingFeedbackKind = Extract<ReviewEvent, { type: "finding.feedback_recorded" }>["payload"]["kind"];

export function findingStateForFeedbackKind(kind: FindingFeedbackKind): FindingState | null {
  if (kind === "dismissed") return "dismissed";
  if (kind === "resolved") return "fixed";
  if (kind === "reopened") return "open";
  return null;
}

function transition(finding: FindingLifecycle, state: FindingState, event: Pick<ReviewEvent, "occurredAt" | "headSha">, details: { reason?: string; actor?: string } = {}) {
  if (finding.state === state && !details.reason && !details.actor) return;
  const latest = finding.history.at(-1);
  if (finding.state === state && latest?.occurredAt === event.occurredAt && latest.reason === details.reason) return;
  finding.state = state;
  finding.history.push({ state, occurredAt: event.occurredAt, headSha: event.headSha, ...details });
  if (details.reason) finding.feedbackReason = details.reason;
}

function replacementFor(finding: FindingLifecycle, current: readonly FindingSnapshot[]) {
  const findingKey = finding.findingKey?.trim().toLowerCase();
  if (!findingKey) return undefined;
  return current.find((candidate) => candidate.findingId !== finding.findingId
    && candidate.supersedesFindingKey?.trim().toLowerCase() === findingKey);
}

export function projectFindingLifecycles(events: readonly ReviewEvent[], currentHeadSha?: string) {
  const findings = new Map<string, FindingLifecycle>();
  const pendingFeedback = new Map<string, Array<Extract<ReviewEvent, { type: "finding.feedback_recorded" }>>>();
  const pendingStates = new Map<string, Array<Extract<ReviewEvent, { type: "finding.state_changed" }>>>();
  const activeDismissalSignals = new Map<string, Set<string>>();
  const underlyingStates = new Map<string, FindingState>();
  let latestCompletedHead: string | undefined;
  let authoritativeHead: string | undefined;
  const hasDismissalSignal = (findingId: string) => Boolean(activeDismissalSignals.get(findingId)?.size);
  const applyUnderlyingState = (finding: FindingLifecycle, state: FindingState, event: Pick<ReviewEvent, "occurredAt" | "headSha">, details: { reason?: string; actor?: string } = {}) => {
    underlyingStates.set(finding.findingId, state);
    if (!hasDismissalSignal(finding.findingId)) transition(finding, state, event, details);
  };
  const applyFeedback = (finding: FindingLifecycle, event: Extract<ReviewEvent, { type: "finding.feedback_recorded" }>) => {
    if (event.payload.signal?.type === "dismissal_reaction") {
      const signals = activeDismissalSignals.get(finding.findingId) ?? new Set<string>();
      if (event.payload.signal.active) signals.add(event.payload.signal.id);
      else signals.delete(event.payload.signal.id);
      activeDismissalSignals.set(finding.findingId, signals);
      if (signals.size) transition(finding, "dismissed", event, event.payload);
      else transition(finding, underlyingStates.get(finding.findingId) ?? "open", event, { actor: event.payload.actor, reason: "The last dismissing reaction was removed" });
      return;
    }
    const state = findingStateForFeedbackKind(event.payload.kind);
    if (state) applyUnderlyingState(finding, state, event, event.payload);
    if (event.payload.reason) finding.feedbackReason = event.payload.reason;
  };
  const applyStateEvent = (finding: FindingLifecycle, event: Extract<ReviewEvent, { type: "finding.state_changed" }>) => {
    if (event.payload.source === "dismissal_signal") {
      if (hasDismissalSignal(finding.findingId)) transition(finding, "dismissed", event, { reason: event.payload.reason });
      else transition(finding, underlyingStates.get(finding.findingId) ?? "open", event, { reason: event.payload.reason });
      return;
    }
    applyUnderlyingState(finding, event.payload.state, event, { reason: event.payload.reason });
  };
  for (const event of [...events].sort((left, right) => {
    const occurredAtOrder = left.occurredAt.localeCompare(right.occurredAt);
    if (occurredAtOrder || !left.sequence || !right.sequence) return occurredAtOrder;
    return BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0;
  })) {
    if (event.type === "pull_request.head_changed") {
      authoritativeHead = event.headSha;
      for (const finding of findings.values()) {
        if ((underlyingStates.get(finding.findingId) ?? finding.state) === "open") {
          applyUnderlyingState(finding, "stale", event, { reason: "Pull request head changed before the finding was reviewed again" });
        }
      }
      continue;
    }
    if (event.type === "review.completed") {
      if (event.payload.authoritativeFindings === false) continue;
      if (currentHeadSha && event.headSha === currentHeadSha) authoritativeHead = currentHeadSha;
      if (authoritativeHead && event.headSha !== authoritativeHead) {
        for (const snapshot of event.payload.findings) {
          if (findings.has(snapshot.findingId)) continue;
          const staleFinding: FindingLifecycle = {
            ...snapshot,
            state: "stale",
            firstSeenAt: event.occurredAt,
            lastSeenAt: event.occurredAt,
            lastHeadSha: event.headSha,
            feedbackReason: "Finding belongs to a superseded pull request head",
            history: [{ state: "stale", occurredAt: event.occurredAt, headSha: event.headSha, reason: "Finding belongs to a superseded pull request head" }],
          };
          findings.set(snapshot.findingId, staleFinding);
          underlyingStates.set(snapshot.findingId, "stale");
        }
        continue;
      }
      latestCompletedHead = event.headSha;
      const currentIds = new Set(event.payload.findings.map((finding) => finding.findingId));
      for (const finding of findings.values()) {
        const underlyingState = underlyingStates.get(finding.findingId) ?? finding.state;
        if (currentIds.has(finding.findingId) || underlyingState === "dismissed" || underlyingState === "superseded") continue;
        applyUnderlyingState(finding, replacementFor(finding, event.payload.findings) ? "superseded" : "fixed", event);
      }
      for (const snapshot of event.payload.findings) {
        const existing = findings.get(snapshot.findingId);
        if (!existing) {
          const created: FindingLifecycle = {
            ...snapshot,
            state: "open",
            firstSeenAt: event.occurredAt,
            lastSeenAt: event.occurredAt,
            lastHeadSha: event.headSha,
            history: [{ state: "open", occurredAt: event.occurredAt, headSha: event.headSha }],
          };
          findings.set(snapshot.findingId, created);
          underlyingStates.set(snapshot.findingId, "open");
          for (const feedback of pendingFeedback.get(snapshot.findingId) ?? []) applyFeedback(created, feedback);
          pendingFeedback.delete(snapshot.findingId);
          for (const state of pendingStates.get(snapshot.findingId) ?? []) applyStateEvent(created, state);
          pendingStates.delete(snapshot.findingId);
          continue;
        }
        Object.assign(existing, snapshot, { lastSeenAt: event.occurredAt, lastHeadSha: event.headSha });
        const underlyingState = underlyingStates.get(existing.findingId) ?? existing.state;
        if (underlyingState !== "open" && underlyingState !== "dismissed") applyUnderlyingState(existing, "open", event, { reason: "Finding observed again on a later commit" });
      }
      continue;
    }
    if (event.type !== "finding.feedback_recorded" && event.type !== "finding.state_changed") continue;
    const finding = findings.get(event.payload.findingId);
    if (!finding) {
      if (event.type === "finding.feedback_recorded") pendingFeedback.set(event.payload.findingId, [...(pendingFeedback.get(event.payload.findingId) ?? []), event]);
      else pendingStates.set(event.payload.findingId, [...(pendingStates.get(event.payload.findingId) ?? []), event]);
      continue;
    }
    if (event.type === "finding.feedback_recorded") applyFeedback(finding, event);
    else applyStateEvent(finding, event);
  }
  if (currentHeadSha && latestCompletedHead && currentHeadSha !== latestCompletedHead) {
    for (const finding of findings.values()) if (finding.state === "open") applyUnderlyingState(finding, "stale", {
      occurredAt: finding.lastSeenAt,
      headSha: currentHeadSha,
    }, { reason: "Derived from the live pull request head because no timestamped head-change event was recorded" });
  }
  return [...findings.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}
