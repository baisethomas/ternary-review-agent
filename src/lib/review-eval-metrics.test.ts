import { describe, expect, it } from "vitest";
import type { EvalMatchResult } from "./review-eval-match";
import {
  aggregateEvalMetrics,
  evaluateThresholds,
  parseEvalThresholds,
  scoreEvalCase,
} from "./review-eval-metrics";

function match(partial: Partial<EvalMatchResult> = {}): EvalMatchResult {
  return {
    truePositives: [],
    falseNegatives: [],
    falsePositives: [],
    ...partial,
  };
}

describe("review-eval-metrics", () => {
  it("scores precision, recall, severity agreement, and location accuracy", () => {
    const scored = scoreEvalCase(match({
      truePositives: [{
        expected: { ruleId: "r", severity: "blocking", file: "a.ts", line: 10, required: true },
        predicted: { severity: "blocking", file: "a.ts", line: 11, title: "t", explanation: "e", ruleId: "r" },
        severityAgreed: true,
        locationAccurate: true,
      }, {
        expected: { ruleId: "r2", severity: "warning", file: "b.ts", line: 5, required: true },
        predicted: { severity: "suggestion", file: "b.ts", line: 20, title: "t", explanation: "e", ruleId: "r2" },
        severityAgreed: false,
        locationAccurate: false,
      }],
      falseNegatives: [{ ruleId: "r3", severity: "blocking", file: "c.ts", required: true }],
      falsePositives: [{ severity: "suggestion", file: "d.ts", title: "noise", explanation: "n" }],
    }), {
      ai: { model: "test/model", latencyMs: 100, inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 },
    });

    expect(scored).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 2 / 3,
      recall: 2 / 3,
      blockingRecall: 0.5,
      severityAgreement: 0.5,
      locationAccuracy: 0.5,
      model: "test/model",
      estimatedCostUsd: 0.01,
    });
  });

  it("aggregates suite metrics and evaluates thresholds", () => {
    const suite = aggregateEvalMetrics([
      scoreEvalCase(match({
        truePositives: [{
          expected: { ruleId: "r", severity: "blocking", file: "a.ts", line: 1, required: true },
          predicted: { severity: "blocking", file: "a.ts", line: 1, title: "t", explanation: "e" },
          severityAgreed: true,
          locationAccurate: true,
        }],
      }), { ai: { model: "m", latencyMs: 50, inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.02 } }),
      scoreEvalCase(match({
        falseNegatives: [{ ruleId: "r", severity: "blocking", file: "b.ts", required: true }],
      })),
    ]);

    expect(suite).toMatchObject({
      caseCount: 2,
      truePositives: 1,
      falseNegatives: 1,
      blockingRecall: 0.5,
      recall: 0.5,
      totalLatencyMs: 50,
      totalEstimatedCostUsd: 0.02,
    });

    const thresholds = parseEvalThresholds({
      blockingRecallMin: 0.8,
      precisionMin: 0.5,
      severityAgreementMin: 0.7,
      locationAccuracyMin: 0.7,
    });
    expect(evaluateThresholds(suite, thresholds)).toEqual(expect.arrayContaining([
      expect.stringContaining("blockingRecall"),
    ]));
    expect(evaluateThresholds({ ...suite, blockingRecall: 1, precision: 1, severityAgreement: 1, locationAccuracy: 1 }, thresholds)).toEqual([]);
  });
});
