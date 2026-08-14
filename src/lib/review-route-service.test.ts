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

describe("generateRoutedReview", () => {
  it("delegates to the OpenRouter provider and attaches route telemetry", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const result = await generateRoutedReview("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, "context", {
      ...safeReviewPolicy,
      model: "openai/gpt-5.6-sol",
    });
    expect(result.route?.mode).toBe("single");
    expect(result.route?.reviewModel).toBe("openai/gpt-5.6-sol");
    expect(result.route?.preparation.filesChanged).toBe(1);
    expect(result.authoritativeFindings).toBe(false);
  });
});
