import { generateOpenRouterReview, type OpenRouterTimeoutOptions } from "./openrouter-review-provider";
import { buildReviewRoute } from "./review-route-selector";
import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewResult, SandboxResult } from "./types";

export type RoutedReviewDeps = {
  generateReview?: typeof generateOpenRouterReview;
};

export async function generateRoutedReview(
  diff: string,
  sandbox: SandboxResult,
  repositoryContext: string,
  policy: ResolvedReviewPolicy,
  timeoutOptions?: OpenRouterTimeoutOptions,
  deps: RoutedReviewDeps = {},
): Promise<ReviewResult> {
  const generateReview = deps.generateReview ?? generateOpenRouterReview;
  const route = buildReviewRoute(diff, sandbox, policy);
  const result = await generateReview(
    diff,
    sandbox,
    repositoryContext,
    { ...policy, model: route.reviewModel },
    timeoutOptions,
  );
  return { ...result, route };
}
