import { verifyWebhookSignature } from "@/lib/github";
import { isRepositoryWatched } from "@/lib/repository-watch";
import { enqueueAndDispatchReview } from "@/lib/review-queue-service";
import type { ReviewRequest } from "@/lib/types";

export const maxDuration = 300;

type PullRequestWebhook = {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string }; clone_url: string };
  pull_request: { number: number; draft: boolean; head: { sha: string } };
};

const reviewActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  if (request.headers.get("x-github-event") !== "pull_request") {
    return Response.json({ accepted: false, reason: "Event ignored" });
  }
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) return Response.json({ error: "Missing GitHub delivery ID" }, { status: 400 });

  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  if (!reviewActions.has(payload.action) || payload.pull_request.draft || !payload.installation?.id) {
    return Response.json({ accepted: false, reason: "Pull request does not require a review" });
  }
  const fullName = `${payload.repository.owner.login}/${payload.repository.name}`;
  if (!await isRepositoryWatched(fullName)) {
    return Response.json({ accepted: false, reason: "Repository is paused in Ternary" }, { status: 202 });
  }
  const review: ReviewRequest = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    installationId: payload.installation.id,
    headSha: payload.pull_request.head.sha,
    cloneUrl: payload.repository.clone_url,
  };
  const job = await enqueueAndDispatchReview(review, `github-delivery:${deliveryId}`);
  return Response.json({ accepted: true, delivery: deliveryId, jobId: job.id }, { status: 202 });
}
