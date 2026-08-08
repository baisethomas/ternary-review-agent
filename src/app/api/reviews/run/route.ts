import { runReview } from "@/lib/reviewer";
import type { ReviewRequest } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!process.env.INTERNAL_API_TOKEN || authorization !== `Bearer ${process.env.INTERNAL_API_TOKEN}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json() as Partial<ReviewRequest>;
  if (!body.owner || !body.repo || !body.pullNumber || !body.installationId || !body.headSha || !body.cloneUrl) {
    return Response.json({ error: "owner, repo, pullNumber, installationId, headSha, and cloneUrl are required" }, { status: 400 });
  }
  const result = await runReview(body as ReviewRequest);
  return Response.json(result);
}
