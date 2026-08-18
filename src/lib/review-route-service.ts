import {
  generateOpenRouterReview,
  MIN_OPENROUTER_TIMEOUT_MS,
  resolveConfiguredOpenRouterTimeoutMs,
  type OpenRouterTimeoutOptions,
} from "./openrouter-review-provider";
import { isRetryableReviewError, NonRetryableReviewError } from "./review-errors";
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

function throwCascadeFailure(errors: unknown[]): never {
  if (errors.length === 0) {
    throw new Error("AI review failed after exhausting the model cascade");
  }
  const message = `AI review failed after exhausting the model cascade: ${errors.map(attemptErrorMessage).join(" → ")}`;
  const cause = errors[errors.length - 1];
  if (errors.every((error) => !isRetryableReviewError(error))) {
    throw new NonRetryableReviewError(message, cause instanceof Error ? { cause } : undefined);
  }
  throw new Error(message, cause instanceof Error ? { cause } : undefined);
}

function throwIfBudgetExhausted(remainingMs: number, errors: unknown[]) {
  if (remainingMs >= MIN_OPENROUTER_TIMEOUT_MS) return;
  if (errors.length) throwCascadeFailure(errors);
  throw new Error(`AI review skipped: only ${remainingMs}ms left in the invocation budget`);
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
  const errors: unknown[] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index]!;
    const remaining = deadline - Date.now();
    throwIfBudgetExhausted(remaining, errors);
    const remainingAttempts = chain.length - index;
    const attemptBudget = timeoutForModelAttempt(remaining, remainingAttempts);
    throwIfBudgetExhausted(attemptBudget, errors);
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
      errors.push(error);
      attempts.push({ model, outcome: "failed", error: attemptErrorMessage(error) });
    }
  }

  throwCascadeFailure(errors);
}
