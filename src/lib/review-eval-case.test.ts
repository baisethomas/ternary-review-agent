import { describe, expect, it } from "vitest";
import { defaultEvalSandbox, parseEvalCase, parseEvalSandbox } from "./review-eval-case";

describe("review-eval-case", () => {
  it("parses a valid Eval Case label document", () => {
    expect(parseEvalCase({
      id: "silent-hook",
      title: "Hook never runs",
      tags: ["security"],
      scoreUnmatchedAsFp: true,
      expectedFindings: [{
        ruleId: "correctness-hooks",
        severity: "blocking",
        file: "hooks/guard.sh",
        line: 12,
        lineTolerance: 2,
        titleContains: "stdin",
        remediationContains: "JSON",
        required: true,
      }],
      expectedNonFindings: [{ file: "README.md", topicContains: "typo" }],
    })).toMatchObject({
      id: "silent-hook",
      scoreUnmatchedAsFp: true,
      expectedFindings: [{ ruleId: "correctness-hooks", required: true, line: 12 }],
      expectedNonFindings: [{ file: "README.md" }],
    });
  });

  it("rejects invalid severity and missing required fields", () => {
    expect(() => parseEvalCase({ id: "x", title: "t", tags: [], expectedFindings: [{ ruleId: "r", severity: "critical", file: "a.ts", required: true }], expectedNonFindings: [] }))
      .toThrow(/severity/);
    expect(() => parseEvalCase({ title: "t", tags: [], expectedFindings: [], expectedNonFindings: [] }))
      .toThrow(/id/);
  });

  it("parses sandbox fixtures and provides a default", () => {
    expect(defaultEvalSandbox()).toMatchObject({ ok: true, sandboxId: "eval-fixture" });
    expect(parseEvalSandbox({
      ok: false,
      durationMs: 10,
      sandboxId: "s1",
      commands: [{ command: "npm test", exitCode: 1, output: "fail" }],
    })).toMatchObject({ ok: false, commands: [{ exitCode: 1 }] });
  });
});
