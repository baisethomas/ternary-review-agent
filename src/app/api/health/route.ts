export function GET() {
  return Response.json({
    ok: true,
    service: "ternary-review-agent",
    configured: {
      github: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY && process.env.GITHUB_WEBHOOK_SECRET),
      ai: Boolean(process.env.OPENAI_API_KEY),
      sandbox: Boolean(process.env.VERCEL_OIDC_TOKEN || (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID)),
    },
  });
}
