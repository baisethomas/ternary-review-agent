import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewRouteConfig, ReviewRouteExecutionMode, ReviewRouteRole } from "./review-route-config";
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
  mode: ReviewRouteExecutionMode;
  reviewModel: string;
  selectedRole: ReviewRouteRole;
  reason: string;
  preparation: ReviewRoutePreparation;
  shadow?: ReviewRouteShadow;
};

function defaultReviewModel(policy: ResolvedReviewPolicy) {
  return policy.model || process.env.OPENROUTER_MODEL || "~deepseek/deepseek-v4-flash-latest";
}

function roleForRisk(risk: ReviewRiskLevel): ReviewRouteRole {
  return risk === "high" ? "deep" : "scout";
}

function modelForRole(role: ReviewRouteRole, config: ReviewRouteConfig, policy: ResolvedReviewPolicy) {
  const fallback = defaultReviewModel(policy);
  if (role === "deep") return config.deepModel ?? fallback;
  if (role === "scout") return config.scoutModel ?? fallback;
  return fallback;
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
  return `Shadow route for ${preparation.riskFloor} risk (${signalSummary}); staged selector would run ${stages.join(" → ")} next.`;
}

function routeReason(mode: ReviewRouteExecutionMode, role: ReviewRouteRole, preparation: ReviewRoutePreparation) {
  if (mode === "risk") {
    return `Risk routing selected the ${role} model for ${preparation.riskFloor} risk based on stage-0 preparation.`;
  }
  return "Single-model routing preserves the configured review policy model.";
}

export function selectReviewRoute(
  preparation: ReviewRoutePreparation,
  policy: ResolvedReviewPolicy,
  config: ReviewRouteConfig = resolveReviewRouteConfig(),
): ReviewRoute {
  const selectedRole = config.executionMode === "risk" ? roleForRisk(preparation.riskFloor) : "scout";
  const reviewModel = config.executionMode === "risk"
    ? modelForRole(selectedRole, config, policy)
    : defaultReviewModel(policy);
  const route: ReviewRoute = {
    mode: config.executionMode,
    reviewModel,
    selectedRole,
    reason: routeReason(config.executionMode, selectedRole, preparation),
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

export function shouldSkipSandboxBuild(_preparation: ReviewRoutePreparation, config: ReviewRouteConfig = resolveReviewRouteConfig()) {
  return !config.fullSandboxBuild;
}

/** @deprecated Use shouldSkipSandboxBuild */
export function shouldSlimSandbox(preparation: ReviewRoutePreparation, config?: ReviewRouteConfig) {
  return shouldSkipSandboxBuild(preparation, config);
}
