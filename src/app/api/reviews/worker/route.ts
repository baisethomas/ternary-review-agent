import { hasBearerToken } from "@/lib/api-auth";
import { getNextReviewWakeAt, processReviewQueue, pruneReviewEventHistory } from "@/lib/review-queue-service";
import { dispatchReviewWorker } from "@/lib/review-worker-dispatcher";
import { runReviewWorkerCycle } from "@/lib/review-worker-cycle";
import { redisEmptyCycleBackoff } from "@/lib/review-worker-empty-backoff";
import { guardedWorkerDispatch } from "@/lib/review-worker-dispatch-guard";
import { getInvocationStartedAt, withInvocationStartedAt } from "@/lib/review-invocation-budget";
import { REVIEW_WORKER_DRAIN_RESERVE_MS } from "@/lib/review-invocation-limits";
import { runOpsAlertCheck } from "@/lib/ops-alert-service";

/** Must match REVIEW_WORKER_MAX_DURATION_SECONDS in review-invocation-limits.ts (Next.js requires a literal; Hobby max 300). */
export const maxDuration = 300;

/** Keep enough time for OpenRouter abort + trailing QStash publish. */
const DRAIN_RESERVE_MS = REVIEW_WORKER_DRAIN_RESERVE_MS;

function isAuthorized(request: Request) {
  return hasBearerToken(request, "CRON_SECRET") || hasBearerToken(request, "INTERNAL_API_TOKEN");
}

function remainingInvocationMs() {
  const startedAt = getInvocationStartedAt() ?? Date.now();
  return maxDuration * 1_000 - (Date.now() - startedAt);
}

async function processAvailableJobs() {
  const processed = [];
  while (remainingInvocationMs() > DRAIN_RESERVE_MS) {
    const batch = await processReviewQueue(1);
    if (batch.length === 0) break;
    processed.push(...batch);
  }
  return processed;
}

async function maybeRunOpsAlerts(includeSpend: boolean) {
  try {
    await runOpsAlertCheck({ includeSpend });
  } catch (error) {
    console.error("Unable to run ops alert check", error);
  }
}

async function runWorker(request: Request, pruneHistory = false) {
  return withInvocationStartedAt(Date.now(), async () => {
    if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (pruneHistory) await pruneReviewEventHistory();
    const { jobs, dispatchError } = await runReviewWorkerCycle({
      processAvailableJobs,
      nextWakeAt: getNextReviewWakeAt,
      // Budget/cooldown only the trailing self-wake — webhook/manual enqueue stays unblocked.
      dispatch: (at) => guardedWorkerDispatch(dispatchReviewWorker, at),
      emptyCycleBackoff: redisEmptyCycleBackoff(),
    });
    // Daily cron (GET) also evaluates spend; every wake checks queue/failure pressure.
    await maybeRunOpsAlerts(pruneHistory);
    return Response.json({
      processed: jobs.map((job) => ({ id: job.id, status: job.status, attempts: job.attempts })),
      ...(dispatchError ? { dispatchError } : {}),
    });
  });
}

export function GET(request: Request) { return runWorker(request, true); }
export function POST(request: Request) { return runWorker(request); }
