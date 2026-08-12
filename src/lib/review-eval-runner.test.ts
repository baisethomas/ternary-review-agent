import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseReviewEvalArgs, runReviewEvalSuite } from "./review-eval-runner";
import type { ReviewResult } from "./types";

describe("review-eval-runner", () => {
  it("loads cases, scores mocked predictions, and writes a report", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const root = await mkdtemp(join(tmpdir(), "ternary-eval-"));
    const casesDir = join(root, "cases");
    const caseDir = join(casesDir, "off-by-one-bounds");
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, "case.json"), JSON.stringify({
      id: "off-by-one-bounds",
      title: "Bounds",
      tags: ["correctness"],
      expectedFindings: [{
        ruleId: "correctness-bounds",
        severity: "blocking",
        file: "src/lib/sum.ts",
        line: 4,
        titleContains: "bound",
        required: true,
      }],
      expectedNonFindings: [],
    }));
    await writeFile(join(caseDir, "diff.patch"), "diff --git a/src/lib/sum.ts b/src/lib/sum.ts\n");
    const thresholdsPath = join(root, "thresholds.json");
    await writeFile(thresholdsPath, JSON.stringify({
      blockingRecallMin: 0.8,
      precisionMin: 0.5,
      severityAgreementMin: 0.7,
      locationAccuracyMin: 0.7,
    }));
    const resultsDir = join(root, "results");

    const generateReview = vi.fn(async (): Promise<ReviewResult> => ({
      verdict: "request_changes",
      summary: "Off-by-one",
      findings: [{
        ruleId: "correctness-bounds",
        findingKey: "correctness-bounds:sum",
        severity: "blocking",
        file: "src/lib/sum.ts",
        line: 4,
        title: "Loop bound reads past array",
        explanation: "Use < length",
      }],
      sandbox: { ok: true, commands: [], durationMs: 1, sandboxId: "eval" },
      ai: { model: "test/model", latencyMs: 12, inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.001 },
    }));

    const report = await runReviewEvalSuite({
      casesDir,
      thresholdsPath,
      resultsDir,
      gate: true,
      model: "test/model",
      generateReview,
      now: () => new Date("2026-08-12T20:00:00.000Z"),
    });

    expect(generateReview).toHaveBeenCalledOnce();
    expect(report.suite).toMatchObject({ caseCount: 1, truePositives: 1, blockingRecall: 1, precision: 1 });
    expect(report.gateFailures).toEqual([]);
    expect(report.promptVersion).toBeTruthy();
  });

  it("parses CLI flags", () => {
    expect(parseReviewEvalArgs(["--gate", "--model", "m", "--context-mode", "empty"])).toEqual({
      gate: true,
      model: "m",
      contextMode: "empty",
    });
  });

  it("refuses to score without OPENROUTER_API_KEY", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(runReviewEvalSuite({
      casesDir: "/tmp",
      thresholdsPath: "/tmp/thresholds.json",
      resultsDir: "/tmp/results",
    })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
