import type { ReviewFinding, ReviewResult, SandboxResult } from "./types";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";
import type { ResolvedReviewPolicy } from "./review-policy";

/** Stable label for Eval Runs; bump when the system prompt text changes materially. */
export const REVIEW_PROMPT_VERSION = "v1";

const systemPrompt = `You are Ternary, a senior code review agent. Review only material problems introduced by this pull request. Prioritize correctness, security, concurrency, data loss, and missing tests. Do not report style preferences. Return strict JSON with: verdict (approve|request_changes|comment), summary, and findings. Each finding has a ruleId for its stable review-rule family (for example security-authorization or correctness-concurrency), plus a unique findingKey that combines that rule with the affected symbol and remains stable when line numbers or wording change. Set supersedesFindingKey only when this finding explicitly replaces a semantically equivalent finding key from an earlier review; otherwise set it to null. Each finding also has severity (blocking|warning|suggestion), file, optional line, title, explanation, and optional suggestedFix.`;

/** System prompt text used by OpenRouter reviews (for Eval Run variant labeling). */
export function getReviewSystemPrompt() {
  return systemPrompt;
}

type JsonSchema =
  | { type: "string"; enum?: readonly string[] }
  | { type: "number" }
  | { type: readonly ("string" | "number" | "null")[] }
  | { type: "array"; items: JsonSchema }
  | { type: "object"; additionalProperties: false; required: readonly string[]; properties: Record<string, JsonSchema> };

type JsonPrimitive<T> = T extends "string" ? string : T extends "number" ? number : T extends "null" ? null : never;
type InferJsonSchema<S> =
  S extends { enum: readonly (infer E)[] } ? E
    : S extends { type: "string" } ? string
      : S extends { type: "number" } ? number
        : S extends { type: readonly (infer T)[] } ? JsonPrimitive<T>
          : S extends { type: "array"; items: infer I } ? InferJsonSchema<I>[]
            : S extends { type: "object"; properties: infer P } ? { [K in keyof P]: InferJsonSchema<P[K]> }
              : never;

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
} as const satisfies JsonSchema;

const retryableProviderErrorTypes = new Set([
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "server",
  "timeout",
  "unmapped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMatchesSchema<S extends JsonSchema>(value: unknown, schema: S, path = "review"): asserts value is InferJsonSchema<S> {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!allowedTypes.includes(actualType as never)) throw new Error(`${path} has invalid type`);
  if ("enum" in schema && schema.enum && !schema.enum.includes(value as string)) throw new Error(`${path} has invalid value`);
  if (schema.type === "number" && !Number.isFinite(value)) throw new Error(`${path} has invalid number`);
  if (schema.type === "array") {
    (value as unknown[]).forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new Error(`${path} has invalid object`);
    const allowedKeys = new Set(Object.keys(schema.properties));
    if (Object.keys(value).some((key) => !allowedKeys.has(key)) || schema.required.some((key) => !(key in value))) throw new Error(`${path} has invalid fields`);
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (key in value) assertMatchesSchema(value[key], propertySchema, `${path}.${key}`);
    }
  }
}

function parseReviewOutput(text: string): Omit<ReviewResult, "sandbox" | "ai" | "authoritativeFindings"> {
  const value: unknown = JSON.parse(text);
  assertMatchesSchema(value, reviewSchema);
  const findings: ReviewFinding[] = value.findings.map((finding) => ({
    ruleId: finding.ruleId,
    findingKey: finding.findingKey,
    ...(finding.supersedesFindingKey !== null ? { supersedesFindingKey: finding.supersedesFindingKey } : {}),
    severity: finding.severity,
    file: finding.file,
    ...(finding.line !== null ? { line: finding.line } : {}),
    title: finding.title,
    explanation: finding.explanation,
    ...(finding.suggestedFix !== null ? { suggestedFix: finding.suggestedFix } : {}),
  }));
  if (findings.some((finding) => !finding.ruleId!.trim() || !finding.findingKey!.trim())) throw new Error("finding identity is invalid");
  const findingKeys = findings.map((finding) => finding.findingKey!.toLowerCase());
  if (new Set(findingKeys).size !== findingKeys.length) throw new Error("finding keys are duplicated");
  return { verdict: value.verdict, summary: value.summary, findings };
}

function reviewParseFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `AI response was not valid review JSON: ${detail}`;
}

type OpenRouterError = { code?: number; message?: string; metadata?: { error_type?: string } };

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export const DEFAULT_OPENROUTER_TIMEOUT_MS = 240_000;
export const MAX_OPENROUTER_TIMEOUT_MS = 240_000;
export const MIN_OPENROUTER_TIMEOUT_MS = 1_000;
/** Matches the worker route `maxDuration` so provider aborts beat platform kills. */
export const WORKER_INVOCATION_BUDGET_MS = 300_000;
/** Leave headroom after the model call for GitHub publish / check-run finish. */
export const REVIEW_PUBLISH_RESERVE_MS = 30_000;

export type OpenRouterTimeoutOptions = {
  /** Milliseconds remaining before the worker invocation deadline. */
  remainingMs?: number;
};

export function resolveConfiguredOpenRouterTimeoutMs(raw = process.env.OPENROUTER_TIMEOUT_MS) {
  const parsed = raw === undefined || raw === "" ? DEFAULT_OPENROUTER_TIMEOUT_MS : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_OPENROUTER_TIMEOUT_MS;
  const rounded = Math.floor(parsed);
  if (rounded < MIN_OPENROUTER_TIMEOUT_MS) return DEFAULT_OPENROUTER_TIMEOUT_MS;
  return Math.min(rounded, MAX_OPENROUTER_TIMEOUT_MS);
}

export function resolveOpenRouterTimeoutMs(
  raw = process.env.OPENROUTER_TIMEOUT_MS,
  options: OpenRouterTimeoutOptions = {},
) {
  const configured = resolveConfiguredOpenRouterTimeoutMs(raw);
  if (options.remainingMs === undefined) return configured;
  const remaining = Math.floor(options.remainingMs);
  if (!Number.isFinite(remaining)) return configured;
  if (remaining < MIN_OPENROUTER_TIMEOUT_MS) {
    throw new Error(`AI review skipped: only ${remaining}ms left in the invocation budget`);
  }
  return Math.min(configured, remaining);
}

export function remainingInvocationBudgetMs(
  startedAt: number,
  now = Date.now(),
  budgetMs = WORKER_INVOCATION_BUDGET_MS,
  reserveMs = REVIEW_PUBLISH_RESERVE_MS,
) {
  return startedAt + budgetMs - reserveMs - now;
}

function throwProviderError(error: OpenRouterError | undefined, finishReason?: string) {
  if (!error && finishReason !== "error") return;
  const errorType = error?.metadata?.error_type;
  const message = `AI review provider failed${errorType ? ` (${errorType})` : ""}: ${error?.message ?? "generation ended with an error"}`;
  const retryable = finishReason === "error" && !error
    || (errorType !== undefined && retryableProviderErrorTypes.has(errorType))
    || (error?.code !== undefined && isRetryableHttpStatus(error.code));
  throw retryable ? new Error(message) : new NonRetryableReviewError(message);
}

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
  policy?: ResolvedReviewPolicy,
  timeoutOptions?: OpenRouterTimeoutOptions,
): Promise<ReviewResult> {
  if (!process.env.OPENROUTER_API_KEY) return fallbackReview(sandbox);
  const maxDiffChars = Number(process.env.MAX_DIFF_CHARS ?? 160_000);
  const input = `PR DIFF:\n${diff.slice(0, maxDiffChars)}\n\nREPOSITORY CONTEXT:\n${repositoryContext || "No matching repository context was available."}\n\nSANDBOX RESULT:\n${JSON.stringify(sandbox)}`;
  const model = policy?.model ?? process.env.OPENROUTER_MODEL ?? "~deepseek/deepseek-v4-flash-latest";
  const startedAt = Date.now();
  const timeoutMs = resolveOpenRouterTimeoutMs(process.env.OPENROUTER_TIMEOUT_MS, timeoutOptions);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = `AI review failed (${response.status}): ${await response.text()}`;
      throw isRetryableHttpStatus(response.status) ? new Error(message) : new NonRetryableReviewError(message);
    }
    const payload = await response.json() as {
      model?: string;
      error?: OpenRouterError;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string; error?: OpenRouterError }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const choice = payload.choices?.[0];
    throwProviderError(choice?.error ?? payload.error, choice?.finish_reason);
    const text = choice?.message?.content;
    if (!text) throw new NonRetryableReviewError("AI response did not include review output");
    try {
      const review = parseReviewOutput(text);
      const inputTokens = payload.usage?.prompt_tokens;
      const outputTokens = payload.usage?.completion_tokens;
      const estimatedCostUsd = payload.usage?.cost;
      return {
        ...review,
        sandbox,
        authoritativeFindings: true,
        ai: {
          model: payload.model ?? model,
          latencyMs: Date.now() - startedAt,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        },
      };
    } catch (error) {
      if (error instanceof NonRetryableReviewError) throw error;
      // Provider/schema parse misses are often transient; retry instead of failing the job immediately.
      throw new Error(reviewParseFailureMessage(error), { cause: error });
    }
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) throw new Error(`AI review timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
