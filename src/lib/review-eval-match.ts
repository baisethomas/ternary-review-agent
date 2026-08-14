import type { ExpectedEvalFinding, ExpectedNonFinding, EvalCase } from "./review-eval-case";
import type { ReviewFinding } from "./types";

export type MatchedEvalFinding = {
  expected: ExpectedEvalFinding;
  predicted: ReviewFinding;
  severityAgreed: boolean;
  locationAccurate: boolean;
};

export type EvalMatchResult = {
  truePositives: MatchedEvalFinding[];
  falseNegatives: ExpectedEvalFinding[];
  falsePositives: ReviewFinding[];
};

const DEFAULT_LINE_TOLERANCE = 3;

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function lineDistance(expected: ExpectedEvalFinding, predicted: ReviewFinding): number {
  if (expected.line === undefined) return 0;
  if (predicted.line === undefined) return Number.POSITIVE_INFINITY;
  return Math.abs(expected.line - predicted.line);
}

function withinLineTolerance(expected: ExpectedEvalFinding, predicted: ReviewFinding) {
  if (expected.line === undefined) return true;
  if (predicted.line === undefined) return false;
  return lineDistance(expected, predicted) <= (expected.lineTolerance ?? DEFAULT_LINE_TOLERANCE);
}

function softContains(haystack: string | undefined, needle: string | undefined) {
  if (!needle) return true;
  if (!haystack) return false;
  return normalize(haystack).includes(normalize(needle));
}

function remediationText(finding: ReviewFinding) {
  return [finding.suggestedFix, finding.explanation].filter(Boolean).join("\n");
}

/**
 * Semantic candidate match: file + rule/title soft filters.
 * Line proximity is scored later as locationAccuracy, not required for identity.
 */
export function isCandidateMatch(expected: ExpectedEvalFinding, predicted: ReviewFinding) {
  if (normalize(expected.file) !== normalize(predicted.file)) return false;
  if (!softContains(predicted.title, expected.titleContains)) return false;
  if (!softContains(remediationText(predicted), expected.remediationContains)) return false;
  const ruleIdMatched = normalize(expected.ruleId) === normalize(predicted.ruleId ?? "");
  // Exact ruleId, or titleContains bridge when the model invents a different rule family.
  if (!ruleIdMatched && !expected.titleContains) return false;
  return true;
}

function hitsNonFinding(predicted: ReviewFinding, nonFindings: ExpectedNonFinding[]) {
  return nonFindings.some((nonFinding) => {
    if (normalize(nonFinding.file) !== normalize(predicted.file)) return false;
    if (nonFinding.line !== undefined) {
      if (predicted.line === undefined) return false;
      if (Math.abs(nonFinding.line - predicted.line) > DEFAULT_LINE_TOLERANCE) return false;
    }
    if (!nonFinding.topicContains) return true;
    const topic = `${predicted.title}\n${predicted.explanation}`;
    return softContains(topic, nonFinding.topicContains);
  });
}

/**
 * Greedy bipartite match: for each expected finding, pick the closest unused
 * predicted candidate by line distance (then first remaining).
 */
export function matchEvalFindings(evalCase: EvalCase, predicted: ReviewFinding[]): EvalMatchResult {
  const unused = predicted.map((finding, index) => ({ finding, index }));
  const truePositives: MatchedEvalFinding[] = [];
  const falseNegatives: ExpectedEvalFinding[] = [];
  const scoreUnmatchedAsFp = evalCase.scoreUnmatchedAsFp !== false;

  for (const expected of evalCase.expectedFindings) {
    const candidates = unused
      .map((entry, unusedIndex) => ({ ...entry, unusedIndex, distance: lineDistance(expected, entry.finding) }))
      .filter((entry) => isCandidateMatch(expected, entry.finding))
      .sort((left, right) => left.distance - right.distance || left.index - right.index);

    const best = candidates[0];
    if (!best) {
      if (expected.required) falseNegatives.push(expected);
      continue;
    }

    unused.splice(best.unusedIndex, 1);
    truePositives.push({
      expected,
      predicted: best.finding,
      severityAgreed: expected.severity === best.finding.severity,
      locationAccurate: withinLineTolerance(expected, best.finding),
    });
  }

  const falsePositives = unused
    .map((entry) => entry.finding)
    .filter((finding) => scoreUnmatchedAsFp || hitsNonFinding(finding, evalCase.expectedNonFindings));

  return { truePositives, falseNegatives, falsePositives };
}
