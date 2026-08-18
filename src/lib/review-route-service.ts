import {
  generateOpenRouterReview,
  MIN_OPENROUTER_TIMEOUT_MS,
  resolveConfiguredOpenRouterTimeoutMs,
  type OpenRouterTimeoutOptions,
} from "./openrouter-review-provider";
import { timeoutForModelAttempt } from "./review-invocation-limits";
import { resolveReviewRouteConfig } from "./review-route-config";
import { buildReviewModelChain, buildReviewRoute, type ReviewModelAttempt } from "./review-route-selector";
import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewResult, SandboxResult } from "./types";

export type RoutedReviewDeps = {
  generateReview?: typeof generateOpenRouterReview;
};

function attemptErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function generateRoutedReview(
  diff: string,
  sandbox: SandboxResult,
  repositoryContext: string,
  policy: ResolvedReviewPolicy,
  timeoutOptions?: OpenRouterTimeoutOptions,
  deps: RoutedReviewDeps = {},
): Promise<ReviewResult> {
  const generateReview = deps.generateReview ?? generateOpenRouterReview;
  const config = resolveReviewRouteConfig();
  const route = buildReviewRoute(diff, sandbox, policy, config);
  const chain = buildReviewModelChain(route.reviewModel, config);
  const startedAt = Date.now();
  const initialRemaining = timeoutOptions?.remainingMs ?? resolveConfiguredOpenRouterTimeoutMs();
  const deadline = startedAt + initialRemaining;
  const attempts: ReviewModelAttempt[] = [];
  let lastError: unknown;

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index]!;
    const remaining = deadline - Date.now();
    if (remaining < MIN_OPENROUTER_TIMEOUT_MS) {
      throw lastError ?? new Error(`AI review skipped: only ${remaining}ms left in the invocation budget`);
    }
    const remainingAttempts = chain.length - index;
    const attemptBudget = timeoutForModelAttempt(remaining, remainingAttempts);
    if (attemptBudget < MIN_OPENROUTER_TIMEOUT_MS) {
      throw lastError ?? new Error(`AI review skipped: only ${attemptBudget}ms left in the invocation budget`);
    }
    try {
      const result = await generateReview(
        diff,
        sandbox,
        repositoryContext,
        { ...policy, model },
        { remainingMs: attemptBudget },
      );
      attempts.push({ model, outcome: "success" });
      const failedModels = attempts.filter((attempt) => attempt.outcome === "failed").map((attempt) => attempt.model);
      const reason = failedModels.length
        ? `${route.reason} Used ${model} after ${failedModels.join(" → ")} failed.`
        : route.reason;
      return { ...result, route: { ...route, reason, usedModel: model, modelAttempts: attempts } };
    } catch (error) {
      lastError = error;
      attempts.push({ model, outcome: "failed", error: attemptErrorMessage(error) });
    }
  }

  throw lastError ?? new Error("AI review failed after exhausting the model cascade");
}
