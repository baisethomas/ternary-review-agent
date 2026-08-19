import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import { safeReviewPolicy } from "./review-policy";
import { generateRoutedReview } from "./review-route-service";
import { DEFAULT_CATCHALL_MODEL, DEFAULT_FALLBACK_MODEL } from "./review-route-config";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      expect.objectContaining({ remainingMs: expect.any(Number) }),
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
      expect.objectContaining({ remainingMs: expect.any(Number) }),
    );
    expect(result.route?.selectedRole).toBe("deep");
    expect(result.route?.reviewModel).toBe("anthropic/claude-opus-4.6");
    expect(result.route?.usedModel).toBe("anthropic/claude-opus-4.6");
  });

  it("falls back from a failing deep model to Flash without calling Terra", async () => {
    vi.stubEnv("REVIEW_ROUTE_MODE", "risk");
    vi.stubEnv("REVIEW_ROUTE_DEEP_MODEL", "moonshotai/kimi-k2.6");
    const generateReview = vi.fn()
      .mockRejectedValueOnce(new Error("AI review timed out after 150000ms"))
      .mockResolvedValue(providerResult);
    const diff = [
      "diff --git a/migrations/001.sql b/migrations/001.sql",
      "+++ b/migrations/001.sql",
      "+alter table users",
    ].join("\n");
    const result = await generateRoutedReview(diff, sandbox, "context", safeReviewPolicy, { remainingMs: 180_000 }, { generateReview });
    expect(generateReview.mock.calls.map((call) => call[3].model)).toEqual(["moonshotai/kimi-k2.6", DEFAULT_FALLBACK_MODEL]);
    expect(result.route?.usedModel).toBe(DEFAULT_FALLBACK_MODEL);
    expect(result.route?.modelAttempts).toEqual([
      { model: "moonshotai/kimi-k2.6", outcome: "failed", error: "AI review timed out after 150000ms" },
      { model: DEFAULT_FALLBACK_MODEL, outcome: "success" },
    ]);
    expect(result.route?.reason).toContain("Used ~deepseek/deepseek-v4-flash-latest after moonshotai/kimi-k2.6 failed.");
  });

  it("skips a duplicate Flash fallback and uses Terra after the primary Flash fails", async () => {
    const generateReview = vi.fn()
      .mockRejectedValueOnce(new NonRetryableReviewError("AI review failed (404): no endpoints"))
      .mockResolvedValue(providerResult);
    const result = await generateRoutedReview(
      "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change",
      sandbox,
      "context",
      { ...safeReviewPolicy, model: DEFAULT_FALLBACK_MODEL },
      { remainingMs: 120_000 },
      { generateReview },
    );
    expect(generateReview.mock.calls.map((call) => call[3].model)).toEqual([DEFAULT_FALLBACK_MODEL, DEFAULT_CATCHALL_MODEL]);
    expect(result.route?.usedModel).toBe(DEFAULT_CATCHALL_MODEL);
    expect(result.authoritativeFindings).toBe(true);
  });

  it("throws the last error after every model in the cascade fails", async () => {
    const generateReview = vi.fn()
      .mockRejectedValueOnce(new Error("timeout-1"))
      .mockRejectedValueOnce(new Error("timeout-2"))
      .mockRejectedValueOnce(new Error("timeout-3"));
    await expect(generateRoutedReview(
      "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+++ b/src/auth/login.ts\n+change",
      sandbox,
      "context",
      { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" },
      { remainingMs: 180_000 },
      { generateReview },
    )).rejects.toMatchObject({ message: expect.stringContaining("timeout-3") });
    expect(generateReview.mock.calls.map((call) => call[3].model)).toEqual([
      "openai/gpt-5.6-sol",
      DEFAULT_FALLBACK_MODEL,
      DEFAULT_CATCHALL_MODEL,
    ]);
  });

  it("keeps the cascade retryable when an earlier model timed out and Terra failed permanently", async () => {
    const generateReview = vi.fn()
      .mockRejectedValueOnce(new Error("AI review timed out after 150000ms"))
      .mockRejectedValueOnce(new Error("AI review timed out after 45000ms"))
      .mockRejectedValueOnce(new NonRetryableReviewError("AI review failed (404): no endpoints"));
    const error = await generateRoutedReview(
      "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+++ b/src/auth/login.ts\n+change",
      sandbox,
      "context",
      { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" },
      { remainingMs: 180_000 },
      { generateReview },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableReviewError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/timed out after 150000ms.*no endpoints/),
    });
  });

  it("stays non-retryable when every model in the cascade failed permanently", async () => {
    const generateReview = vi.fn()
      .mockRejectedValue(new NonRetryableReviewError("AI review failed (404): no endpoints"));
    await expect(generateRoutedReview(
      "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+++ b/src/auth/login.ts\n+change",
      sandbox,
      "context",
      { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" },
      { remainingMs: 180_000 },
      { generateReview },
    )).rejects.toBeInstanceOf(NonRetryableReviewError);
  });

  it("reserves later-model time so the primary cannot consume the whole budget", async () => {
    const generateReview = vi.fn().mockResolvedValue(providerResult);
    await generateRoutedReview(
      "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change",
      sandbox,
      "context",
      { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" },
      { remainingMs: 180_000 },
      { generateReview },
    );
    expect(generateReview.mock.calls[0][4]).toEqual({ remainingMs: 90_000 });
  });
});
