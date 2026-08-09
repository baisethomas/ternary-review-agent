import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { resolveReviewRequest } from "@/lib/dashboard-data";
import { enqueueAndDispatchReview } from "@/lib/review-queue-service";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!await isDashboardAuthenticated()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json() as { owner?: string; repo?: string; pullNumber?: number };
  if (!body.owner || !body.repo || !Number.isInteger(body.pullNumber) || Number(body.pullNumber) < 1) {
    return Response.json({ error: "owner, repo, and pullNumber are required" }, { status: 400 });
  }
  try {
    const review = await resolveReviewRequest(body.owner, body.repo, Number(body.pullNumber));
    const job = await enqueueAndDispatchReview(review);
    return Response.json({ accepted: true, headSha: review.headSha, jobId: job.id }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start review";
    return Response.json({ error: message }, { status: 400 });
  }
}
