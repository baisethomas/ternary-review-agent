import { generateOpenRouterReview, type OpenRouterTimeoutOptions } from "./openrouter-review-provider";
import { buildReviewRoute } from "./review-route-selector";
import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewResult, SandboxResult } from "./types";

export async function generateRoutedReview(
  diff: string,
  sandbox: SandboxResult,
  repositoryContext: string,
  policy: ResolvedReviewPolicy,
  timeoutOptions?: OpenRouterTimeoutOptions,
): Promise<ReviewResult> {
  const route = buildReviewRoute(diff, sandbox, policy);
  const result = await generateOpenRouterReview(
    diff,
    sandbox,
    repositoryContext,
    { ...policy, model: route.reviewModel },
    timeoutOptions,
  );
  return { ...result, route };
}
