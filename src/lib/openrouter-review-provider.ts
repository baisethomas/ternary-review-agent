import type { ReviewResult, SandboxResult } from "./types";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";

const systemPrompt = `You are Ternary, a senior code review agent. Review only material problems introduced by this pull request. Prioritize correctness, security, concurrency, data loss, and missing tests. Do not report style preferences. Return strict JSON with: verdict (approve|request_changes|comment), summary, and findings. Each finding has a ruleId for its stable review-rule family (for example security-authorization or correctness-concurrency), plus a unique findingKey that combines that rule with the affected symbol and remains stable when line numbers or wording change. Set supersedesFindingKey only when this finding explicitly replaces a semantically equivalent finding key from an earlier review; otherwise set it to null. Each finding also has severity (blocking|warning|suggestion), file, optional line, title, explanation, and optional suggestedFix.`;

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["ruleId", "findingKey", "supersedesFindingKey", "severity", "file", "line", "title", "explanation", "suggestedFix"],
        properties: {
          ruleId: { type: "string" },
          findingKey: { type: "string" },
          supersedesFindingKey: { type: ["string", "null"] },
          severity: { type: "string", enum: ["blocking", "warning", "suggestion"] },
          file: { type: "string" }, line: { type: ["number", "null"] }, title: { type: "string" },
          explanation: { type: "string" }, suggestedFix: { type: ["string", "null"] },
        },
      },
    },
  },
};

function fallbackReview(sandbox: SandboxResult): ReviewResult {
  return {
    verdict: sandbox.ok ? "comment" : "request_changes",
    summary: sandbox.ok
      ? "Sandbox checks passed. AI review is disabled until OPENROUTER_API_KEY is configured."
      : "One or more sandbox checks failed.",
    findings: sandbox.ok
      ? []
      : [{ findingKey: "sandbox-checks-failed", severity: "blocking", file: "", title: "Sandbox checks failed", explanation: "Inspect the sandbox command output before merging." }],
    sandbox,
    authoritativeFindings: false,
  };
}

export async function generateOpenRouterReview(
  diff: string,
  sandbox: SandboxResult,
  repositoryContext: string,
): Promise<ReviewResult> {
  if (!process.env.OPENROUTER_API_KEY) return fallbackReview(sandbox);
  const maxDiffChars = Number(process.env.MAX_DIFF_CHARS ?? 160_000);
  const input = `PR DIFF:\n${diff.slice(0, maxDiffChars)}\n\nREPOSITORY CONTEXT:\n${repositoryContext || "No matching repository context was available."}\n\nSANDBOX RESULT:\n${JSON.stringify(sandbox)}`;
  const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-terra";
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      response_format: { type: "json_schema", json_schema: { name: "code_review", strict: true, schema: reviewSchema } },
      provider: { require_parameters: true },
    }),
  });
  if (!response.ok) {
    const message = `AI review failed (${response.status}): ${await response.text()}`;
    throw isRetryableHttpStatus(response.status) ? new Error(message) : new NonRetryableReviewError(message);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new NonRetryableReviewError("AI response did not include review output");
  try {
    const review = JSON.parse(text) as Omit<ReviewResult, "sandbox">;
    const findingKeys = review.findings.map((finding) => finding.findingKey?.toLowerCase() ?? null);
    const ruleIds = review.findings.map((finding) => finding.ruleId?.toLowerCase() ?? null);
    if (findingKeys.some((key) => !key) || new Set(findingKeys).size !== findingKeys.length || ruleIds.some((ruleId) => !ruleId)) {
      throw new NonRetryableReviewError("AI response included missing rule IDs or missing/duplicate finding keys");
    }
    const inputTokens = payload.usage?.prompt_tokens;
    const outputTokens = payload.usage?.completion_tokens;
    const estimatedCostUsd = payload.usage?.cost;
    return {
      ...review,
      sandbox,
      authoritativeFindings: true,
      ai: {
        model,
        latencyMs: Date.now() - startedAt,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      },
    };
  } catch (error) {
    if (error instanceof NonRetryableReviewError) throw error;
    throw new NonRetryableReviewError("AI response was not valid review JSON", { cause: error });
  }
}
