/**
 * Workspace Review analysis wrapper (docs/workspace-review-spec.md §3, §6).
 *
 * A narrow, source-agnostic seam around the model call: it needs no GitHub
 * API, no publisher, no queue, and no persistence. Per the Hobby-plan fixed
 * decision it performs exactly ONE model attempt — the PR pipeline's
 * DeepSeek→OpenAI cascade in `review-route-service.ts` stays PR-queue-only —
 * with a deterministic deadline that aborts the in-flight request.
 */

import { MIN_OPENROUTER_TIMEOUT_MS } from "./openrouter-review-provider";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";
import { reviewSeverities } from "./review-policy";
import {
  buildWorkspaceReviewInput,
  getWorkspaceSystemPrompt,
  parseWorkspaceReviewOutput,
  WORKSPACE_MAX_FINDINGS,
  workspaceReviewSchema,
} from "./workspace-review-prompts";
import {
  assertCheckEvidenceInvariants,
  workspaceVerdict,
  type WorkspaceAnalysisInput,
  type WorkspaceReviewResult,
} from "./workspace-review-types";

/** Server-owned output-token budget (spec §4.4); the client can never raise it. */
export const WORKSPACE_MAX_OUTPUT_TOKENS = 4_096;

export class WorkspaceReviewTimeoutError extends NonRetryableReviewError {
  constructor(timeoutMs: number) {
    super(`Workspace review timed out after ${timeoutMs}ms`);
    this.name = "WorkspaceReviewTimeoutError";
  }
}

export type WorkspaceModelResponse = {
  text: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number };
};

export type WorkspaceModelRequestArgs = {
  model: string;
  systemPrompt: string;
  input: string;
  schema: unknown;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type WorkspaceModelRequest = (request: WorkspaceModelRequestArgs) => Promise<WorkspaceModelResponse>;

export type WorkspaceAnalysisDeps = {
  requestModel?: WorkspaceModelRequest;
  now?: () => number;
};

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Default OpenRouter transport: one request, strict schema, no fallback chain. */
export const requestOpenRouterWorkspaceModel: WorkspaceModelRequest = async (request) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new NonRetryableReviewError("Workspace review requires OPENROUTER_API_KEY");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_schema", json_schema: { name: "workspace_review", strict: true, schema: request.schema } },
      provider: { require_parameters: true },
    }),
    signal: request.signal,
  });
  if (!response.ok) {
    const message = `Workspace review model call failed (${response.status}): ${await response.text()}`;
    throw isRetryableHttpStatus(response.status) ? new Error(message) : new NonRetryableReviewError(message);
  }
  const payload = await response.json() as {
    model?: string;
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null }; error?: { message?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const choice = payload.choices?.[0];
  const providerError = choice?.error ?? payload.error;
  if (providerError) throw new NonRetryableReviewError(`Workspace review model call failed: ${providerError.message ?? "generation ended with an error"}`);
  const text = choice?.message?.content;
  if (!text) throw new NonRetryableReviewError("Workspace review model response did not include output");
  return {
    text,
    ...(payload.model ? { model: payload.model } : {}),
    usage: {
      ...(payload.usage?.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {}),
      ...(payload.usage?.completion_tokens !== undefined ? { outputTokens: payload.usage.completion_tokens } : {}),
      ...(payload.usage?.cost !== undefined ? { estimatedCostUsd: payload.usage.cost } : {}),
    },
  };
};

/**
 * Run one advisory Workspace Review: build the versioned prompt for the review
 * kind, make a single deadline-bounded model attempt, validate the structured
 * output, apply the policy threshold and finding cap, and derive the verdict.
 */
export async function analyzeWorkspaceReview(
  input: WorkspaceAnalysisInput,
  deps: WorkspaceAnalysisDeps = {},
): Promise<WorkspaceReviewResult> {
  if (input.reviewKind !== input.changeSet.kind) {
    throw new NonRetryableReviewError(`Workspace review kind "${input.reviewKind}" does not match the captured change set kind "${input.changeSet.kind}"`);
  }
  for (const evidence of input.evidence) assertCheckEvidenceInvariants(evidence);

  const requestModel = deps.requestModel ?? requestOpenRouterWorkspaceModel;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = Math.floor(input.deadlineAt - startedAt);
  if (timeoutMs < MIN_OPENROUTER_TIMEOUT_MS) throw new WorkspaceReviewTimeoutError(Math.max(0, timeoutMs));

  const systemPrompt = getWorkspaceSystemPrompt(input.reviewKind);
  const modelInput = buildWorkspaceReviewInput(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: WorkspaceModelResponse;
  try {
    response = await requestModel({
      model: input.policy.model,
      systemPrompt,
      input: modelInput,
      schema: workspaceReviewSchema,
      maxOutputTokens: WORKSPACE_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) throw new WorkspaceReviewTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let review: ReturnType<typeof parseWorkspaceReviewOutput>;
  try {
    review = parseWorkspaceReviewOutput(response.text);
  } catch (error) {
    // Single attempt by design: a malformed response fails the review instead of cascading.
    const detail = error instanceof Error ? error.message : String(error);
    throw new NonRetryableReviewError(`Workspace review response was not valid review JSON: ${detail}`, error instanceof Error ? { cause: error } : undefined);
  }

  const minimum = reviewSeverities.indexOf(input.policy.minimumSeverity);
  const maxFindings = input.policy.maxFindings ?? WORKSPACE_MAX_FINDINGS;
  const findings = review.findings
    .filter((finding) => reviewSeverities.indexOf(finding.severity) >= minimum)
    .slice(0, maxFindings);
  const hiddenCount = review.findings.length - findings.length;

  return {
    verdict: workspaceVerdict(findings),
    summary: hiddenCount
      ? `${review.summary}\n\nPolicy omitted ${hiddenCount} finding${hiddenCount === 1 ? "" : "s"} based on the ${input.policy.minimumSeverity} severity threshold and the ${maxFindings}-finding report cap.`
      : review.summary,
    findings,
    evidence: input.evidence,
    ai: {
      model: response.model ?? input.policy.model,
      latencyMs: now() - startedAt,
      ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
      ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
      ...(response.usage?.estimatedCostUsd !== undefined ? { estimatedCostUsd: response.usage.estimatedCostUsd } : {}),
    },
  };
}
