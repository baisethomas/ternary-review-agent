export type ReviewRouteRole = "router" | "scout" | "deep";

export type ReviewRouteConfig = {
  shadowEnabled: boolean;
  largeDiffLineThreshold: number;
  largeDiffFileThreshold: number;
};

export function resolveReviewRouteConfig(env: Record<string, string | undefined> = process.env): ReviewRouteConfig {
  const shadowRaw = env.REVIEW_ROUTE_SHADOW?.trim().toLowerCase();
  return {
    shadowEnabled: shadowRaw === "1" || shadowRaw === "true" || shadowRaw === "yes",
    largeDiffLineThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_LINES, 400),
    largeDiffFileThreshold: parsePositiveInt(env.REVIEW_ROUTE_LARGE_DIFF_FILES, 40),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
