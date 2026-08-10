import type { DashboardCheck } from "./dashboard-data";
import type { ReviewJob } from "./review-queue";

function reviewJobKey(job: Pick<ReviewJob, "owner" | "repo" | "pullNumber" | "headSha">) {
  return `${job.owner.toLowerCase()}/${job.repo.toLowerCase()}#${job.pullNumber}:${job.headSha}`;
}

export function indexReviewJobs(jobs: readonly ReviewJob[]) {
  const index = new Map<string, ReviewJob>();
  for (const job of jobs) {
    const key = reviewJobKey(job);
    const current = index.get(key);
    if (!current || job.updatedAt > current.updatedAt) index.set(key, job);
  }
  return index;
}

export function findReviewJob(index: ReadonlyMap<string, ReviewJob>, owner: string, repo: string, pullNumber: number, headSha: string) {
  return index.get(`${owner.toLowerCase()}/${repo.toLowerCase()}#${pullNumber}:${headSha}`);
}

export function applyReviewJobState(check: DashboardCheck, job: ReviewJob | undefined): DashboardCheck {
  if (!job) return check;
  const checkStartedAt = check.startedAt ? Date.parse(check.startedAt) : 0;
  if (checkStartedAt > job.updatedAt) return check;
  const freshAttempt: DashboardCheck = {
    ...check,
    conclusion: null,
    completedAt: null,
    detailsUrl: null,
    findings: [],
    sandboxSteps: [],
    sandboxId: null,
    sandboxDurationSeconds: null,
  };
  if (job.status === "queued" || job.status === "retrying") {
    return { ...freshAttempt, status: "queued", title: job.status === "retrying" ? "Review retry scheduled" : "Review queued", summary: job.lastError ?? "Ternary has accepted this review and will start it shortly.", startedAt: null };
  }
  if (job.status === "running") {
    return { ...freshAttempt, status: "reviewing", title: "Reviewing", summary: "Ternary is running the sandbox and code review.", startedAt: new Date(job.startedAt ?? job.updatedAt).toISOString() };
  }
  if (job.status === "failed") {
    return { ...freshAttempt, status: "failed", title: "Review failed", summary: job.lastError ?? "The review could not be completed.", startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null, completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null };
  }
  return check;
}
