import type { EvalMatchResult } from "./review-eval-match";
import type { ReviewResult } from "./types";

export type EvalCaseMetrics = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  blockingTruePositives: number;
  blockingFalseNegatives: number;
  precision: number;
  recall: number;
  blockingRecall: number;
  severityAgreement: number;
  locationAccuracy: number;
  locationPairs: number;
  severityAgreed: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  model?: string;
};

export type EvalSuiteMetrics = {
  caseCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  blockingRecall: number;
  severityAgreement: number;
  locationAccuracy: number;
  totalLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
};

export type EvalThresholds = {
  blockingRecallMin: number;
  precisionMin: number;
  severityAgreementMin: number;
  locationAccuracyMin: number;
};

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}

/** Score one Eval Case from a match result and optional AI telemetry. */
export function scoreEvalCase(match: EvalMatchResult, result?: Pick<ReviewResult, "ai">): EvalCaseMetrics {
  const truePositives = match.truePositives.length;
  const falsePositives = match.falsePositives.length;
  const falseNegatives = match.falseNegatives.length;
  const blockingTruePositives = match.truePositives.filter((entry) => entry.expected.severity === "blocking").length;
  const blockingFalseNegatives = match.falseNegatives.filter((entry) => entry.severity === "blocking").length;
  const severityAgreed = match.truePositives.filter((entry) => entry.severityAgreed).length;
  const locationPairs = match.truePositives.filter((entry) => entry.expected.line !== undefined && entry.predicted.line !== undefined);
  const locationAccurate = locationPairs.filter((entry) => entry.locationAccurate).length;

  const metrics: EvalCaseMetrics = {
    truePositives,
    falsePositives,
    falseNegatives,
    blockingTruePositives,
    blockingFalseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    blockingRecall: ratio(blockingTruePositives, blockingTruePositives + blockingFalseNegatives),
    severityAgreement: ratio(severityAgreed, truePositives),
    locationAccuracy: ratio(locationAccurate, locationPairs.length),
    locationPairs: locationPairs.length,
    severityAgreed,
  };

  if (result?.ai) {
    metrics.latencyMs = result.ai.latencyMs;
    metrics.model = result.ai.model;
    if (result.ai.inputTokens !== undefined) metrics.inputTokens = result.ai.inputTokens;
    if (result.ai.outputTokens !== undefined) metrics.outputTokens = result.ai.outputTokens;
    if (result.ai.estimatedCostUsd !== undefined) metrics.estimatedCostUsd = result.ai.estimatedCostUsd;
  }

  return metrics;
}

/** Aggregate per-case metrics into suite rollups (micro-average counts). */
export function aggregateEvalMetrics(cases: EvalCaseMetrics[]): EvalSuiteMetrics {
  const truePositives = cases.reduce((sum, entry) => sum + entry.truePositives, 0);
  const falsePositives = cases.reduce((sum, entry) => sum + entry.falsePositives, 0);
  const falseNegatives = cases.reduce((sum, entry) => sum + entry.falseNegatives, 0);
  const blockingTruePositives = cases.reduce((sum, entry) => sum + entry.blockingTruePositives, 0);
  const blockingFalseNegatives = cases.reduce((sum, entry) => sum + entry.blockingFalseNegatives, 0);
  const severityAgreed = cases.reduce((sum, entry) => sum + entry.severityAgreed, 0);
  const locationAccurate = cases.reduce((sum, entry) => sum + entry.locationAccuracy * entry.locationPairs, 0);
  const locationPairs = cases.reduce((sum, entry) => sum + entry.locationPairs, 0);

  return {
    caseCount: cases.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    blockingRecall: ratio(blockingTruePositives, blockingTruePositives + blockingFalseNegatives),
    severityAgreement: ratio(severityAgreed, truePositives),
    locationAccuracy: ratio(locationAccurate, locationPairs),
    totalLatencyMs: cases.reduce((sum, entry) => sum + (entry.latencyMs ?? 0), 0),
    totalInputTokens: cases.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
    totalOutputTokens: cases.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
    totalEstimatedCostUsd: cases.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0),
  };
}

export function parseEvalThresholds(value: unknown): EvalThresholds {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("thresholds must be an object");
  const record = value as Record<string, unknown>;
  for (const key of ["blockingRecallMin", "precisionMin", "severityAgreementMin", "locationAccuracyMin"] as const) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new Error(`${key} must be a finite number`);
  }
  return {
    blockingRecallMin: record.blockingRecallMin as number,
    precisionMin: record.precisionMin as number,
    severityAgreementMin: record.severityAgreementMin as number,
    locationAccuracyMin: record.locationAccuracyMin as number,
  };
}

/** Return threshold failures for a suite rollup; empty means pass. */
export function evaluateThresholds(suite: EvalSuiteMetrics, thresholds: EvalThresholds): string[] {
  const failures: string[] = [];
  if (suite.blockingRecall < thresholds.blockingRecallMin) {
    failures.push(`blockingRecall ${suite.blockingRecall.toFixed(3)} < ${thresholds.blockingRecallMin}`);
  }
  if (suite.precision < thresholds.precisionMin) {
    failures.push(`precision ${suite.precision.toFixed(3)} < ${thresholds.precisionMin}`);
  }
  if (suite.severityAgreement < thresholds.severityAgreementMin) {
    failures.push(`severityAgreement ${suite.severityAgreement.toFixed(3)} < ${thresholds.severityAgreementMin}`);
  }
  if (suite.locationAccuracy < thresholds.locationAccuracyMin) {
    failures.push(`locationAccuracy ${suite.locationAccuracy.toFixed(3)} < ${thresholds.locationAccuracyMin}`);
  }
  return failures;
}
