export type ReviewRouteRole = "router" | "scout" | "deep";

export type ReviewRouteExecutionMode = "single" | "risk";

export type ReviewRouteConfig = {
  executionMode: ReviewRouteExecutionMode;
  shadowEnabled: boolean;
  slimSandboxOnLowRisk: boolean;
  largeDiffLineThreshold: number;
  largeDiffFileThreshold: number;
  scoutModel?: string;
  deepModel?: string;
};

export function resolveReviewRouteConfig(env: Record<string, string | undefined> = process.env): ReviewRouteConfig {
  const shadowRaw = env.REVIEW_ROUTE_SHADOW?.trim().toLowerCase();
  const slimRaw = env.REVIEW_ROUTE_SLIM_SANDBOX?.trim().toLowerCase();
  const modeRaw = env.REVIEW_ROUTE_MODE?.trim().toLowerCase();
  const scoutModel = env.REVIEW_ROUTE_SCOUT_MODEL?.trim();
  const deepModel = env.REVIEW_ROUTE_DEEP_MODEL?.trim();
  return {
    executionMode: modeRaw === "risk" ? "risk" : "single",
    shadowEnabled: shadowRaw === "1" || shadowRaw === "true" || shadowRaw === "yes",
    slimSandboxOnLowRisk: slimRaw === "1" || slimRaw === "true" || slimRaw === "yes",
    largeDiffLineThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_LINES, 400),
    largeDiffFileThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_FILES, 40),
    ...(scoutModel ? { scoutModel } : {}),
    ...(deepModel ? { deepModel } : {}),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
