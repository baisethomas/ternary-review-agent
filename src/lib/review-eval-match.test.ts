import { describe, expect, it } from "vitest";
import type { EvalCase } from "./review-eval-case";
import { isCandidateMatch, matchEvalFindings } from "./review-eval-match";
import type { ReviewFinding } from "./types";

const baseCase: EvalCase = {
  id: "demo",
  title: "Demo",
  tags: [],
  expectedFindings: [{
    ruleId: "correctness-hooks",
    severity: "blocking",
    file: "hooks/guard.sh",
    line: 10,
    titleContains: "stdin",
    required: true,
  }],
  expectedNonFindings: [{ file: "README.md", topicContains: "style" }],
};

function finding(partial: Partial<ReviewFinding> & Pick<ReviewFinding, "severity" | "file" | "title" | "explanation">): ReviewFinding {
  return {
    ruleId: "correctness-hooks",
    findingKey: "correctness-hooks:guard",
    ...partial,
  };
}

describe("review-eval-match", () => {
  it("matches semantically and scores location separately", () => {
    const predicted = finding({
      severity: "blocking",
      file: "hooks/guard.sh",
      line: 12,
      title: "Hook ignores stdin payload",
      explanation: "Reads env instead of stdin",
    });
    expect(isCandidateMatch(baseCase.expectedFindings[0], predicted)).toBe(true);
    const match = matchEvalFindings(baseCase, [predicted]);
    expect(match.truePositives).toHaveLength(1);
    expect(match.falseNegatives).toHaveLength(0);
    expect(match.truePositives[0].severityAgreed).toBe(true);
    expect(match.truePositives[0].locationAccurate).toBe(true);
  });

  it("keeps a semantic match when the line is far off, and marks location inaccurate", () => {
    const match = matchEvalFindings(baseCase, [
      finding({
        severity: "blocking",
        file: "hooks/guard.sh",
        line: 99,
        title: "Hook ignores stdin payload",
        explanation: "Reads env instead of stdin",
      }),
    ]);
    expect(match.truePositives).toHaveLength(1);
    expect(match.truePositives[0].locationAccurate).toBe(false);
    expect(match.falseNegatives).toHaveLength(0);
  });

  it("allows titleContains to bridge mismatched ruleIds", () => {
    const predicted = finding({
      ruleId: "hooks-stdin",
      severity: "blocking",
      file: "hooks/guard.sh",
      line: 10,
      title: "Hook ignores stdin payload",
      explanation: "Reads env instead of stdin",
    });
    expect(isCandidateMatch(baseCase.expectedFindings[0], predicted)).toBe(true);
  });

  it("records required misses as false negatives and non-finding hits as false positives", () => {
    const match = matchEvalFindings(baseCase, [
      finding({
        severity: "suggestion",
        file: "README.md",
        line: 1,
        title: "Fix style in docs",
        explanation: "Prefer shorter sentences",
        ruleId: "style-docs",
      }),
    ]);
    expect(match.truePositives).toHaveLength(0);
    expect(match.falseNegatives).toHaveLength(1);
    expect(match.falsePositives).toHaveLength(1);
  });

  it("counts unmatched predictions as false positives by default", () => {
    const predicted = finding({
      severity: "warning",
      file: "other.ts",
      line: 1,
      title: "Unrelated",
      explanation: "noise",
      ruleId: "other",
    });
    expect(matchEvalFindings(baseCase, [predicted]).falsePositives).toHaveLength(1);
    expect(matchEvalFindings({ ...baseCase, scoreUnmatchedAsFp: false }, [predicted]).falsePositives).toHaveLength(0);
  });

  it("picks the closest line when multiple candidates match", () => {
    const match = matchEvalFindings(baseCase, [
      finding({ severity: "blocking", file: "hooks/guard.sh", line: 20, title: "Hook ignores stdin", explanation: "a" }),
      finding({ severity: "blocking", file: "hooks/guard.sh", line: 11, title: "Hook ignores stdin", explanation: "b", findingKey: "correctness-hooks:guard-b" }),
    ]);
    expect(match.truePositives[0].predicted.line).toBe(11);
    expect(match.falsePositives).toHaveLength(1);
  });
});
