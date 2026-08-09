import "server-only";

export function hasBearerToken(request: Request, environmentVariable: "INTERNAL_API_TOKEN" | "CRON_SECRET") {
  const expected = process.env[environmentVariable];
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}
