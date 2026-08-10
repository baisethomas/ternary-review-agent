import { hasBearerToken } from "@/lib/api-auth";
import { enqueueAndTryDispatchReview } from "@/lib/review-queue-service";
import { isValidInvocationId, manualReviewIdempotencyKey } from "@/lib/review-submission";
import type { ReviewRequest } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!hasBearerToken(request, "INTERNAL_API_TOKEN")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json() as Partial<ReviewRequest>;
  if (!body.owner || !body.repo || !body.pullNumber || !body.installationId || !body.headSha || !body.cloneUrl) {
    return Response.json({ error: "owner, repo, pullNumber, installationId, headSha, and cloneUrl are required" }, { status: 400 });
  }
  const invocationId = request.headers.get("idempotency-key");
  if (!isValidInvocationId(invocationId)) return Response.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
  const review = body as ReviewRequest;
  const job = await enqueueAndTryDispatchReview(review, manualReviewIdempotencyKey(review, invocationId), invocationId);
  return Response.json({ accepted: true, jobId: job.id }, { status: 202 });
}
