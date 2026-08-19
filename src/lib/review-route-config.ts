export type ReviewRouteRole = "router" | "scout" | "deep";

export type ReviewRouteExecutionMode = "single" | "risk";

/** Scout / first fallback. Supports strict json_schema + require_parameters. */
export const DEFAULT_FALLBACK_MODEL = "~deepseek/deepseek-v4-flash-latest";
/** Last-resort model after the routed model and Flash have failed. */
export const DEFAULT_CATCHALL_MODEL = "openai/gpt-5.6-terra";

export type ReviewRouteConfig = {
  executionMode: ReviewRouteExecutionMode;
  shadowEnabled: boolean;
  /** When true, run the full sandbox plan including build. Default skips build (Vercel CI already builds PRs). */
  fullSandboxBuild: boolean;
  largeDiffLineThreshold: number;
  largeDiffFileThreshold: number;
  scoutModel?: string;
  deepModel?: string;
  fallbackModel?: string;
  catchallModel?: string;
};

export function resolveReviewRouteConfig(env: Record<string, string | undefined> = process.env): ReviewRouteConfig {
  const shadowRaw = env.REVIEW_ROUTE_SHADOW?.trim().toLowerCase();
  const fullRaw = env.REVIEW_ROUTE_FULL_SANDBOX?.trim().toLowerCase();
  const slimRaw = env.REVIEW_ROUTE_SLIM_SANDBOX?.trim().toLowerCase();
  const modeRaw = env.REVIEW_ROUTE_MODE?.trim().toLowerCase();
  const scoutModel = env.REVIEW_ROUTE_SCOUT_MODEL?.trim();
  const deepModel = env.REVIEW_ROUTE_DEEP_MODEL?.trim();
  const fallbackModel = env.REVIEW_ROUTE_FALLBACK_MODEL?.trim();
  const catchallModel = env.REVIEW_ROUTE_CATCHALL_MODEL?.trim();
  let fullSandboxBuild = fullRaw === "1" || fullRaw === "true" || fullRaw === "yes";
  if (slimRaw === "0" || slimRaw === "false" || slimRaw === "no") fullSandboxBuild = true;
  return {
    executionMode: modeRaw === "risk" ? "risk" : "single",
    shadowEnabled: shadowRaw === "1" || shadowRaw === "true" || shadowRaw === "yes",
    fullSandboxBuild,
    largeDiffLineThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_LINES, 400),
    largeDiffFileThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_FILES, 40),
    ...(scoutModel ? { scoutModel } : {}),
    ...(deepModel ? { deepModel } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(catchallModel ? { catchallModel } : {}),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
