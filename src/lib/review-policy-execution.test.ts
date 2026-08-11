import { describe, expect, it } from "vitest";
import { applyReviewPolicyToResult, filterReviewDiff } from "./review-policy-execution";
import { safeReviewPolicy } from "./review-policy";

describe("review policy execution", () => {
  it("removes excluded file sections from the model diff", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
diff --git a/generated/client.ts b/generated/client.ts
--- a/generated/client.ts
+++ b/generated/client.ts
@@ -1 +1 @@
-old client
+new client`;

    const filtered = filterReviewDiff(diff, ["generated/**"]);

    expect(filtered).toContain("src/app.ts");
    expect(filtered).not.toContain("generated/client.ts");
    expect(filtered).not.toContain("new client");
  });

  it("removes findings below the configured severity and derives the visible verdict", () => {
    const result = applyReviewPolicyToResult({
      verdict: "request_changes",
      summary: "One suggestion",
      findings: [{ ruleId: "tests-coverage", findingKey: "tests-coverage-parser", severity: "suggestion", file: "src/parser.ts", title: "Add coverage", explanation: "The new branch is untested." }],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
    }, { ...safeReviewPolicy, minimumSeverity: "warning" });

    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("approve");
    expect(result.summary).toContain("1 finding");
    expect(result.summary).toContain("warning severity threshold");
  });

  it("does not publish findings for an excluded path even when context mentions it", () => {
    const result = applyReviewPolicyToResult({
      verdict: "request_changes",
      summary: "Generated file issue",
      findings: [{ ruleId: "generated-file", findingKey: "generated-file-edit", severity: "blocking", file: "generated/client.ts", title: "Do not edit", explanation: "Generated output changed." }],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
    }, { ...safeReviewPolicy, excludedPaths: ["generated/**"] });

    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("approve");
  });
});
