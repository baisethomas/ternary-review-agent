import { after } from "next/server";
import { verifyWebhookSignature } from "@/lib/github";
import { runReview } from "@/lib/reviewer";
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

  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  if (!reviewActions.has(payload.action) || payload.pull_request.draft || !payload.installation?.id) {
    return Response.json({ accepted: false, reason: "Pull request does not require a review" });
  }
  const review: ReviewRequest = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    installationId: payload.installation.id,
    headSha: payload.pull_request.head.sha,
    cloneUrl: payload.repository.clone_url,
  };
  after(() => runReview(review).catch((error) => console.error("Ternary review failed", error)));
  return Response.json({ accepted: true, delivery: request.headers.get("x-github-delivery") }, { status: 202 });
}
