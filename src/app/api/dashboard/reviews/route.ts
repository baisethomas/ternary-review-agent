import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { PausedRepositoryReviewError, ReviewSubmissionConflictError, submitDashboardReview } from "@/lib/dashboard-review-service";
import { isValidInvocationId } from "@/lib/review-submission";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!await isDashboardAuthenticated()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json() as { owner?: string; repo?: string; pullNumber?: number; invocationId?: string };
  if (!body.owner || !body.repo || !Number.isInteger(body.pullNumber) || Number(body.pullNumber) < 1 || !isValidInvocationId(body.invocationId)) {
    return Response.json({ error: "owner, repo, pullNumber, and invocationId are required" }, { status: 400 });
  }
  try {
    const { review, job } = await submitDashboardReview(body.owner, body.repo, Number(body.pullNumber), body.invocationId);
    return Response.json({ accepted: true, headSha: review.headSha, jobId: job.id }, { status: 202 });
  } catch (error) {
    if (error instanceof ReviewSubmissionConflictError) return Response.json({ error: error.message }, { status: 409 });
    const message = error instanceof Error ? error.message : "Unable to start review";
    return Response.json({ error: message }, { status: error instanceof PausedRepositoryReviewError ? 409 : 400 });
  }
}
