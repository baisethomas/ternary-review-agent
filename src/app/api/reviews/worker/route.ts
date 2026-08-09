import { hasBearerToken } from "@/lib/api-auth";
import { getNextReviewAvailableAt, processReviewQueue } from "@/lib/review-queue-service";
import { dispatchReviewWorker } from "@/lib/review-worker-dispatcher";

export const maxDuration = 300;

function isAuthorized(request: Request) {
  return hasBearerToken(request, "CRON_SECRET") || hasBearerToken(request, "INTERNAL_API_TOKEN");
}

async function runWorker(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const jobs = await processReviewQueue();
  const nextAvailableAt = await getNextReviewAvailableAt();
  if (nextAvailableAt !== null) {
    const earliestDispatch = jobs.length === 0 ? Date.now() + 5_000 : Date.now();
    await dispatchReviewWorker(Math.max(nextAvailableAt, earliestDispatch));
  }
  return Response.json({ processed: jobs.map((job) => ({ id: job.id, status: job.status, attempts: job.attempts })) });
}

export const GET = runWorker;
export const POST = runWorker;
