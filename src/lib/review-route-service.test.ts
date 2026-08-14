import { describe, expect, it, vi } from "vitest";
import { safeReviewPolicy } from "./review-policy";
import { generateRoutedReview } from "./review-route-service";
import type { SandboxResult } from "./types";

const sandbox: SandboxResult = {
  ok: true,
  commands: [],
  durationMs: 500,
  sandboxId: "sandbox-1",
};

const providerResult = {
  verdict: "approve" as const,
  summary: "Looks good",
  findings: [],
  sandbox,
  authoritativeFindings: true,
};

describe("generateRoutedReview", () => {
  it("forwards the routed model to the provider and attaches route telemetry", async () => {
    const generateReview = vi.fn().mockResolvedValue(providerResult);
    const diff = "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change";
    const result = await generateRoutedReview(
      diff,
      sandbox,
      "context",
      { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" },
      undefined,
      { generateReview },
    );
    expect(generateReview).toHaveBeenCalledWith(
      diff,
      sandbox,
      "context",
      expect.objectContaining({ model: "openai/gpt-5.6-sol" }),
      undefined,
    );
    expect(result.route?.mode).toBe("single");
    expect(result.route?.selectedRole).toBe("scout");
    expect(result.route?.reviewModel).toBe("openai/gpt-5.6-sol");
    expect(result.route?.preparation.filesChanged).toBe(1);
    expect(result.authoritativeFindings).toBe(true);
  });

  it("selects the deep model for high-risk diffs when risk routing is enabled", async () => {
    vi.stubEnv("REVIEW_ROUTE_MODE", "risk");
    vi.stubEnv("REVIEW_ROUTE_SCOUT_MODEL", "openai/gpt-5.6-sol");
    vi.stubEnv("REVIEW_ROUTE_DEEP_MODEL", "anthropic/claude-opus-4.6");
    const generateReview = vi.fn().mockResolvedValue(providerResult);
    const diff = [
      "diff --git a/migrations/001.sql b/migrations/001.sql",
      "+++ b/migrations/001.sql",
      "+alter table users",
    ].join("\n");
    const result = await generateRoutedReview(
      diff,
      sandbox,
      "context",
      safeReviewPolicy,
      undefined,
      { generateReview },
    );
    expect(generateReview).toHaveBeenCalledWith(
      diff,
      sandbox,
      "context",
      expect.objectContaining({ model: "anthropic/claude-opus-4.6" }),
      undefined,
    );
    expect(result.route?.selectedRole).toBe("deep");
    expect(result.route?.reviewModel).toBe("anthropic/claude-opus-4.6");
    vi.unstubAllEnvs();
  });
});
