import { hasBearerToken } from "@/lib/api-auth";
import { getNextReviewWakeAt, processReviewQueue, pruneReviewEventHistory } from "@/lib/review-queue-service";
import { dispatchReviewWorker } from "@/lib/review-worker-dispatcher";
import { runReviewWorkerCycle } from "@/lib/review-worker-cycle";
import { redisEmptyCycleBackoff } from "@/lib/review-worker-empty-backoff";

export const maxDuration = 300;

function isAuthorized(request: Request) {
  return hasBearerToken(request, "CRON_SECRET") || hasBearerToken(request, "INTERNAL_API_TOKEN");
}

async function runWorker(request: Request, pruneHistory = false) {
  if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (pruneHistory) await pruneReviewEventHistory();
  const { jobs, dispatchError } = await runReviewWorkerCycle({
    processAvailableJobs: () => processReviewQueue(),
    nextWakeAt: getNextReviewWakeAt,
    dispatch: dispatchReviewWorker,
    emptyCycleBackoff: redisEmptyCycleBackoff(),
  });
  return Response.json({
    processed: jobs.map((job) => ({ id: job.id, status: job.status, attempts: job.attempts })),
    ...(dispatchError ? { dispatchError } : {}),
  });
}

export function GET(request: Request) { return runWorker(request, true); }
export function POST(request: Request) { return runWorker(request); }
