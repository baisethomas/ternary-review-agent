import { describe, expect, it } from "vitest";
import { prepareReviewRoute } from "./review-route-preparation";
import type { SandboxResult } from "./types";

const okSandbox: SandboxResult = {
  ok: true,
  commands: [],
  durationMs: 1000,
  sandboxId: "sandbox-1",
};

const failedSandbox: SandboxResult = {
  ok: false,
  commands: [{ command: "test", exitCode: 1, output: "failed" }],
  durationMs: 1000,
  sandboxId: "sandbox-2",
};

const config = {
  shadowEnabled: false,
  largeDiffLineThreshold: 100,
  largeDiffFileThreshold: 10,
};

describe("prepareReviewRoute", () => {
  it("counts changed files/lines and languages from a unified diff", () => {
    const diff = [
      'diff --git a/src/lib/foo.ts b/src/lib/foo.ts',
      "--- a/src/lib/foo.ts",
      "+++ b/src/lib/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      'diff --git a/README.md b/README.md',
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "+docs",
    ].join("\n");
    const preparation = prepareReviewRoute(diff, okSandbox, config);
    expect(preparation.filesChanged).toBe(2);
    expect(preparation.linesAdded).toBe(2);
    expect(preparation.linesRemoved).toBe(1);
    expect(preparation.languages).toEqual(["markdown", "typescript"]);
    expect(preparation.riskFloor).toBe("low");
  });

  it("raises the risk floor for auth/api paths and sandbox failures", () => {
    const authDiff = [
      'diff --git a/src/app/api/notes/route.ts b/src/app/api/notes/route.ts',
      "--- a/src/app/api/notes/route.ts",
      "+++ b/src/app/api/notes/route.ts",
      "@@ -1 +1 @@",
      "+change",
    ].join("\n");
    const authPrep = prepareReviewRoute(authDiff, okSandbox, config);
    expect(authPrep.riskFloor).toBe("high");
    expect(authPrep.riskSignals).toEqual(expect.arrayContaining(["api-route"]));

    const failedPrep = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+x", failedSandbox, config);
    expect(failedPrep.riskFloor).toBe("high");
    expect(failedPrep.sandboxFailed).toBe(true);
    expect(failedPrep.riskSignals[0]).toBe("sandbox-failed");
  });

  it("flags large diffs using configured thresholds", () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      "--- a/a.ts",
      "+++ b/a.ts",
      ...Array.from({ length: 12 }, (_, index) => `+line${index}`),
    ].join("\n");
    const preparation = prepareReviewRoute(diff, okSandbox, {
      shadowEnabled: false,
      largeDiffLineThreshold: 10,
      largeDiffFileThreshold: 40,
    });
    expect(preparation.riskSignals).toContain("large-diff-lines");
    expect(preparation.riskFloor).toBe("standard");
  });
});
