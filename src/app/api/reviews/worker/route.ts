import { hasBearerToken } from "@/lib/api-auth";
import { getNextReviewWakeAt, processReviewQueue } from "@/lib/review-queue-service";
import { dispatchReviewWorker } from "@/lib/review-worker-dispatcher";
import { runReviewWorkerCycle } from "@/lib/review-worker-cycle";

export const maxDuration = 300;

function isAuthorized(request: Request) {
  return hasBearerToken(request, "CRON_SECRET") || hasBearerToken(request, "INTERNAL_API_TOKEN");
}

async function runWorker(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const jobs = await runReviewWorkerCycle({
    process: () => processReviewQueue(),
    nextWakeAt: getNextReviewWakeAt,
    dispatch: dispatchReviewWorker,
  });
  return Response.json({ processed: jobs.map((job) => ({ id: job.id, status: job.status, attempts: job.attempts })) });
}

export const GET = runWorker;
export const POST = runWorker;
