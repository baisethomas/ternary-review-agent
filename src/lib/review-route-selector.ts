import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewRouteConfig, ReviewRouteRole } from "./review-route-config";
import { resolveReviewRouteConfig } from "./review-route-config";
import type { ReviewRoutePreparation, ReviewRiskLevel } from "./review-route-preparation";
import { prepareReviewRoute } from "./review-route-preparation";
import type { SandboxResult } from "./types";

export type ReviewRouteShadow = {
  recommendedRisk: ReviewRiskLevel;
  recommendedStages: ReviewRouteRole[];
  reason: string;
};

export type ReviewRoute = {
  mode: "single";
  reviewModel: string;
  reason: string;
  preparation: ReviewRoutePreparation;
  shadow?: ReviewRouteShadow;
};

function defaultReviewModel(policy: ResolvedReviewPolicy) {
  return policy.model || process.env.OPENROUTER_MODEL || "~deepseek/deepseek-v4-flash-latest";
}

function recommendShadowStages(risk: ReviewRiskLevel): ReviewRouteRole[] {
  if (risk === "low") return ["router"];
  if (risk === "standard") return ["router", "scout", "deep"];
  return ["router", "scout", "deep"];
}

function shadowReason(preparation: ReviewRoutePreparation, stages: ReviewRouteRole[]) {
  const signalSummary = preparation.riskSignals.length
    ? preparation.riskSignals.join(", ")
    : "no deterministic risk signals";
  return `Shadow route for ${preparation.riskFloor} risk (${signalSummary}); staged selector would run ${stages.join(" → ")} but slice 1 keeps single-model execution.`;
}

export function selectReviewRoute(
  preparation: ReviewRoutePreparation,
  policy: ResolvedReviewPolicy,
  config: ReviewRouteConfig = resolveReviewRouteConfig(),
): ReviewRoute {
  const reviewModel = defaultReviewModel(policy);
  const route: ReviewRoute = {
    mode: "single",
    reviewModel,
    reason: "TER-25 slice 1 preserves today's single-model review path.",
    preparation,
  };
  if (!config.shadowEnabled) return route;
  const recommendedStages = recommendShadowStages(preparation.riskFloor);
  route.shadow = {
    recommendedRisk: preparation.riskFloor,
    recommendedStages,
    reason: shadowReason(preparation, recommendedStages),
  };
  return route;
}

export function buildReviewRoute(diff: string, sandbox: SandboxResult, policy: ResolvedReviewPolicy, config?: ReviewRouteConfig) {
  const resolvedConfig = config ?? resolveReviewRouteConfig();
  const preparation = prepareReviewRoute(diff, sandbox, resolvedConfig);
  return selectReviewRoute(preparation, policy, resolvedConfig);
}
