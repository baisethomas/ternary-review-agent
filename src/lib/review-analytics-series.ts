import type { ReviewAnalytics } from "./review-analytics";
import type { ReviewEvent } from "./review-event-ledger";

export type AnalyticsRangeDays = 14 | 30 | 60;

export type AnalyticsWindow = {
  rangeDays: number;
  from: string;
  to: string;
  priorFrom: string;
  priorTo: string;
};

export type DailyCount = { day: string; value: number };
export type DailySeverity = { day: string; blocking: number; warning: number; suggestion: number };
export type DailyLatency = { day: string; queueMs: number; sandboxMs: number; modelMs: number; samples: number };
export type DailySpend = { day: string; spendUsd: number };
export type DailyFeedback = { day: string; accepted: number; dismissed: number };
export type WeeklyAddressed = { week: string; rate: number | null; addressed: number; eligible: number };

export type ReviewAnalyticsSeries = {
  reviewsOverTime: DailyCount[];
  findingsBySeverity: DailySeverity[];
  addressedRate: WeeklyAddressed[];
  timeToVerdict: DailyLatency[];
  spendOverTime: DailySpend[];
  feedbackRatio: DailyFeedback[];
  averages: {
    reviewsPerDay: number;
    findingsPerDay: number;
    addressedRate: number | null;
    timeToVerdictMs: number | null;
    spendPerDay: number;
    acceptShare: number | null;
  };
};

export type StatDelta = { value: number; prior: number; delta: number | null };

export type ReviewAnalyticsStatStrip = {
  reviews: StatDelta;
  passRate: StatDelta;
  changeRate: StatDelta;
  failureRate: StatDelta;
};

const DAY_MS = 86_400_000;
const ADDRESSED_WITHIN_MS = 7 * DAY_MS;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function utcDay(isoOrDay: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay)) return isoOrDay;
  const date = new Date(isoOrDay);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addUtcDays(day: string, delta: number) {
  const date = new Date(`${utcDay(day)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return utcDay(date.toISOString());
}

export function eachUtcDay(from: string, to: string) {
  const start = utcDay(from);
  const end = utcDay(to);
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) days.push(cursor);
  return days;
}

/** Monday UTC week key for a day. */
export function utcWeekStart(day: string) {
  const date = new Date(`${utcDay(day)}T00:00:00.000Z`);
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return utcDay(date.toISOString());
}

export function parseAnalyticsRange(value?: string): AnalyticsRangeDays | undefined {
  if (value === "14" || value === "30" || value === "60") return Number(value) as AnalyticsRangeDays;
  return undefined;
}

export function resolveAnalyticsWindow(input: {
  range?: AnalyticsRangeDays | string;
  from?: string;
  to?: string;
  now?: Date;
} = {}): AnalyticsWindow {
  const now = input.now ?? new Date();
  const today = utcDay(now.toISOString());
  const explicitFrom = input.from ? utcDay(input.from) : undefined;
  const explicitTo = input.to ? utcDay(input.to) : undefined;
  const parsedRange = typeof input.range === "number" ? input.range : parseAnalyticsRange(input.range);
  const defaultRange = parsedRange ?? 30;

  let from: string;
  let to: string;
  if (explicitFrom && explicitTo) {
    from = explicitFrom;
    to = explicitTo;
  } else if (explicitFrom) {
    // One-sided from: span through today; prior period matches that actual length.
    from = explicitFrom;
    to = today;
  } else if (explicitTo) {
    to = explicitTo;
    from = addUtcDays(to, -(defaultRange - 1));
  } else {
    to = today;
    from = addUtcDays(to, -(defaultRange - 1));
  }
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  const rangeDays = Math.max(1, eachUtcDay(from, to).length);
  const priorTo = addUtcDays(from, -1);
  const priorFrom = addUtcDays(priorTo, -(rangeDays - 1));
  return { rangeDays, from, to, priorFrom, priorTo };
}

export function relativeDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return (current - prior) / Math.abs(prior);
}

export function buildStatStrip(current: ReviewAnalytics, prior: ReviewAnalytics): ReviewAnalyticsStatStrip {
  const metric = (value: number, priorValue: number): StatDelta => ({ value, prior: priorValue, delta: relativeDelta(value, priorValue) });
  return {
    reviews: metric(current.outcomes.reviews, prior.outcomes.reviews),
    passRate: metric(current.outcomes.passRate, prior.outcomes.passRate),
    changeRate: metric(current.outcomes.changeRate, prior.outcomes.changeRate),
    failureRate: metric(current.outcomes.failureRate, prior.outcomes.failureRate),
  };
}

function emptySeries(from: string, to: string): ReviewAnalyticsSeries {
  const days = eachUtcDay(from, to);
  const weeks = [...new Set(days.map(utcWeekStart))];
  return {
    reviewsOverTime: days.map((day) => ({ day, value: 0 })),
    findingsBySeverity: days.map((day) => ({ day, blocking: 0, warning: 0, suggestion: 0 })),
    addressedRate: weeks.map((week) => ({ week, rate: null, addressed: 0, eligible: 0 })),
    timeToVerdict: days.map((day) => ({ day, queueMs: 0, sandboxMs: 0, modelMs: 0, samples: 0 })),
    spendOverTime: days.map((day) => ({ day, spendUsd: 0 })),
    feedbackRatio: days.map((day) => ({ day, accepted: 0, dismissed: 0 })),
    averages: { reviewsPerDay: 0, findingsPerDay: 0, addressedRate: null, timeToVerdictMs: null, spendPerDay: 0, acceptShare: null },
  };
}

function averageOrNull(total: number, samples: number) {
  return samples ? total / samples : null;
}

function finalizeAverages(series: ReviewAnalyticsSeries): ReviewAnalyticsSeries {
  const dayCount = Math.max(1, series.reviewsOverTime.length);
  const reviews = series.reviewsOverTime.reduce((total, item) => total + item.value, 0);
  const findings = series.findingsBySeverity.reduce((total, item) => total + item.blocking + item.warning + item.suggestion, 0);
  const addressed = series.addressedRate.reduce((total, item) => total + item.addressed, 0);
  const eligible = series.addressedRate.reduce((total, item) => total + item.eligible, 0);
  const latencySamples = series.timeToVerdict.reduce((total, item) => total + item.samples, 0);
  const latencyTotal = series.timeToVerdict.reduce((total, item) => total + (item.queueMs + item.sandboxMs + item.modelMs) * item.samples, 0);
  const spend = series.spendOverTime.reduce((total, item) => total + item.spendUsd, 0);
  const accepted = series.feedbackRatio.reduce((total, item) => total + item.accepted, 0);
  const dismissed = series.feedbackRatio.reduce((total, item) => total + item.dismissed, 0);
  const feedbackTotal = accepted + dismissed;
  return {
    ...series,
    addressedRate: series.addressedRate.map((item) => ({
      ...item,
      rate: item.eligible ? item.addressed / item.eligible : null,
    })),
    averages: {
      reviewsPerDay: reviews / dayCount,
      findingsPerDay: findings / dayCount,
      addressedRate: eligible ? addressed / eligible : null,
      timeToVerdictMs: averageOrNull(latencyTotal, latencySamples),
      spendPerDay: spend / dayCount,
      acceptShare: feedbackTotal ? accepted / feedbackTotal : null,
    },
  };
}

type FindingClock = { firstSeenAt: number; addressedAt?: number };

export function buildReviewAnalyticsSeries(events: readonly ReviewEvent[], from: string, to: string): ReviewAnalyticsSeries {
  const series = emptySeries(from, to);
  const dayIndex = new Map(series.reviewsOverTime.map((item, index) => [item.day, index]));
  const weekIndex = new Map(series.addressedRate.map((item, index) => [item.week, index]));
  const requestedJobs = new Set<string>();
  const queuedAtByJob = new Map<string, number>();
  const queueMsByJob = new Map<string, number>();
  const startedJobs = new Set<string>();
  const completedJobs = new Set<string>();
  const findings = new Map<string, FindingClock>();
  const windowStartMs = Date.parse(`${utcDay(from)}T00:00:00.000Z`);
  const windowEndMs = Date.parse(`${utcDay(to)}T23:59:59.999Z`);

  const inWindowDay = (iso: string) => {
    const day = utcDay(iso);
    return dayIndex.has(day) ? day : null;
  };

  for (const event of events) {
    if (event.type === "review.requested") {
      const requestKey = event.payload.jobId ?? `legacy:${event.idempotencyKey}`;
      if (requestedJobs.has(requestKey)) continue;
      requestedJobs.add(requestKey);
      const day = inWindowDay(event.occurredAt);
      if (!day) continue;
      series.reviewsOverTime[dayIndex.get(day)!].value += 1;
      continue;
    }

    if (event.type === "review.queued") {
      if (!queuedAtByJob.has(event.payload.jobId) && !startedJobs.has(event.payload.jobId)) {
        queuedAtByJob.set(event.payload.jobId, Date.parse(event.occurredAt));
      }
      continue;
    }

    if (event.type === "review.started") {
      const queuedAt = queuedAtByJob.get(event.payload.jobId);
      if (queuedAt !== undefined && !startedJobs.has(event.payload.jobId)) {
        queueMsByJob.set(event.payload.jobId, Math.max(0, Date.parse(event.occurredAt) - queuedAt));
        startedJobs.add(event.payload.jobId);
        queuedAtByJob.delete(event.payload.jobId);
      }
      continue;
    }

    if (event.type === "review.completed") {
      if (completedJobs.has(event.payload.jobId)) continue;
      completedJobs.add(event.payload.jobId);
      const day = inWindowDay(event.occurredAt);
      const authoritative = event.payload.authoritativeFindings !== false;
      if (day) {
        const latency = series.timeToVerdict[dayIndex.get(day)!];
        const queueMs = queueMsByJob.get(event.payload.jobId) ?? 0;
        const sandboxMs = event.payload.sandbox?.durationMs ?? 0;
        const modelMs = event.payload.ai?.latencyMs ?? 0;
        const nextSamples = latency.samples + 1;
        latency.queueMs = (latency.queueMs * latency.samples + queueMs) / nextSamples;
        latency.sandboxMs = (latency.sandboxMs * latency.samples + sandboxMs) / nextSamples;
        latency.modelMs = (latency.modelMs * latency.samples + modelMs) / nextSamples;
        latency.samples = nextSamples;
        if (event.payload.ai?.estimatedCostUsd !== undefined) {
          series.spendOverTime[dayIndex.get(day)!].spendUsd += event.payload.ai.estimatedCostUsd;
        }
        if (authoritative) {
          const severity = series.findingsBySeverity[dayIndex.get(day)!];
          for (const finding of event.payload.findings) severity[finding.severity] += 1;
        }
      }
      if (authoritative) {
        for (const finding of event.payload.findings) {
          const seenAt = Date.parse(event.occurredAt);
          const current = findings.get(finding.findingId);
          if (!current || seenAt < current.firstSeenAt) findings.set(finding.findingId, { firstSeenAt: seenAt, addressedAt: current?.addressedAt });
        }
      }
      continue;
    }

    if (event.type === "finding.feedback_recorded") {
      const day = inWindowDay(event.occurredAt);
      if (day && (event.payload.kind === "accepted" || event.payload.kind === "dismissed")) {
        series.feedbackRatio[dayIndex.get(day)!][event.payload.kind] += 1;
      }
      if (event.payload.kind === "accepted" || event.payload.kind === "dismissed" || event.payload.kind === "resolved") {
        const current = findings.get(event.payload.findingId) ?? { firstSeenAt: Date.parse(event.occurredAt) };
        if (current.addressedAt === undefined) current.addressedAt = Date.parse(event.occurredAt);
        findings.set(event.payload.findingId, current);
      }
      continue;
    }

    if (event.type === "finding.state_changed" && (event.payload.state === "fixed" || event.payload.state === "dismissed")) {
      const current = findings.get(event.payload.findingId) ?? { firstSeenAt: Date.parse(event.occurredAt) };
      if (current.addressedAt === undefined) current.addressedAt = Date.parse(event.occurredAt);
      findings.set(event.payload.findingId, current);
    }
  }

  for (const finding of findings.values()) {
    if (finding.firstSeenAt < windowStartMs || finding.firstSeenAt > windowEndMs) continue;
    const firstDay = utcDay(new Date(finding.firstSeenAt).toISOString());
    const week = utcWeekStart(firstDay);
    const index = weekIndex.get(week);
    if (index === undefined) continue;
    const deadline = finding.firstSeenAt + ADDRESSED_WITHIN_MS;
    // Only count findings whose 7-day window has elapsed, or that already addressed.
    if (deadline > windowEndMs && finding.addressedAt === undefined) continue;
    series.addressedRate[index].eligible += 1;
    if (finding.addressedAt !== undefined && finding.addressedAt <= deadline) series.addressedRate[index].addressed += 1;
  }

  return finalizeAverages(series);
}

export function combineReviewAnalyticsSeries(items: readonly ReviewAnalyticsSeries[], from: string, to: string): ReviewAnalyticsSeries {
  if (items.length === 0) return emptySeries(from, to);
  if (items.length === 1) return items[0];
  const combined = emptySeries(from, to);
  for (const item of items) {
    for (let index = 0; index < combined.reviewsOverTime.length; index += 1) {
      combined.reviewsOverTime[index].value += item.reviewsOverTime[index]?.value ?? 0;
      const severity = combined.findingsBySeverity[index];
      const sourceSeverity = item.findingsBySeverity[index];
      if (sourceSeverity) {
        severity.blocking += sourceSeverity.blocking;
        severity.warning += sourceSeverity.warning;
        severity.suggestion += sourceSeverity.suggestion;
      }
      const latency = combined.timeToVerdict[index];
      const sourceLatency = item.timeToVerdict[index];
      if (sourceLatency?.samples) {
        const nextSamples = latency.samples + sourceLatency.samples;
        latency.queueMs = (latency.queueMs * latency.samples + sourceLatency.queueMs * sourceLatency.samples) / nextSamples;
        latency.sandboxMs = (latency.sandboxMs * latency.samples + sourceLatency.sandboxMs * sourceLatency.samples) / nextSamples;
        latency.modelMs = (latency.modelMs * latency.samples + sourceLatency.modelMs * sourceLatency.samples) / nextSamples;
        latency.samples = nextSamples;
      }
      combined.spendOverTime[index].spendUsd += item.spendOverTime[index]?.spendUsd ?? 0;
      combined.feedbackRatio[index].accepted += item.feedbackRatio[index]?.accepted ?? 0;
      combined.feedbackRatio[index].dismissed += item.feedbackRatio[index]?.dismissed ?? 0;
    }
    for (let index = 0; index < combined.addressedRate.length; index += 1) {
      combined.addressedRate[index].addressed += item.addressedRate[index]?.addressed ?? 0;
      combined.addressedRate[index].eligible += item.addressedRate[index]?.eligible ?? 0;
    }
  }
  return finalizeAverages(combined);
}

export function emptyReviewAnalyticsSeries(from: string, to: string) {
  return finalizeAverages(emptySeries(from, to));
}
