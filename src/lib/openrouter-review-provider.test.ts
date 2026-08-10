import { afterEach, describe, expect, it, vi } from "vitest";
import { generateOpenRouterReview } from "./openrouter-review-provider";
import { NonRetryableReviewError } from "./review-errors";

const sandbox = {
  ok: true,
  commands: [{ command: "npm test", exitCode: 0, output: "passed" }],
  durationMs: 250,
  sandboxId: "sandbox-1",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter review provider", () => {
  it("returns the deterministic sandbox fallback when the API key is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(generateOpenRouterReview("diff", sandbox, "context")).resolves.toMatchObject({
      verdict: "comment",
      authoritativeFindings: false,
      summary: "Sandbox checks passed. AI review is disabled until OPENROUTER_API_KEY is configured.",
      sandbox,
    });
  });

  it("requests a strict structured review and records OpenRouter usage", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubEnv("OPENROUTER_MODEL", "openai/gpt-5.6-terra");
    const review = {
      verdict: "request_changes",
      summary: "One material issue.",
      findings: [{
        ruleId: "correctness-concurrency",
        findingKey: "correctness-concurrency-worker-lease",
        supersedesFindingKey: null,
        severity: "blocking",
        file: "src/worker.ts",
        line: 42,
        title: "Lease is not fenced",
        explanation: "A stale worker can publish results.",
        suggestedFix: "Check lease ownership before publishing.",
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "openai/gpt-5.6-terra-20260801",
      choices: [{ message: { content: JSON.stringify(review) } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0012 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateOpenRouterReview("diff body", sandbox, "repository context");

    expect(result).toMatchObject({
      ...review,
      sandbox,
      authoritativeFindings: true,
      ai: { model: "openai/gpt-5.6-terra-20260801", inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.0012 },
    });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers).toMatchObject({ Authorization: "Bearer router-key" });
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "openai/gpt-5.6-terra",
      messages: [
        { role: "system" },
        { role: "user", content: expect.stringContaining("diff body") },
      ],
      response_format: { type: "json_schema", json_schema: { name: "code_review", strict: true } },
      provider: { require_parameters: true },
    });
  });

  it("keeps transient OpenRouter failures retryable", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));

    await expect(generateOpenRouterReview("diff", sandbox, "context")).rejects.toMatchObject({
      message: expect.stringContaining("AI review failed (429)"),
    });
    await expect(generateOpenRouterReview("diff", sandbox, "context")).rejects.not.toBeInstanceOf(NonRetryableReviewError);
  });

  it("marks permanent OpenRouter failures as non-retryable", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));

    await expect(generateOpenRouterReview("diff", sandbox, "context")).rejects.toBeInstanceOf(NonRetryableReviewError);
  });
});
