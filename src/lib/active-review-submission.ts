import type { ReviewJob } from "./review-queue";
import type { ReviewRequest } from "./types";

export class ReviewSubmissionConflictError extends Error {
  constructor() {
    super("Another submission is still preparing this review. Please retry.");
    this.name = "ReviewSubmissionConflictError";
  }
}

export type ActiveReviewSubmissionDependencies = {
  claim(review: ReviewRequest, owner: string): Promise<string>;
  attach(review: ReviewRequest, owner: string, jobOwner: string): Promise<boolean>;
  release(review: ReviewRequest, owner: string): Promise<boolean>;
  takeover(review: ReviewRequest, expectedOwner: string, owner: string): Promise<boolean>;
  getJob(id: string): Promise<ReviewJob | null>;
};

const claimOwner = (submissionId: string) => `claim:${submissionId}`;
export const activeReviewJobOwner = (jobId: string) => `job:${jobId}`;

export async function releaseTerminalActiveReviews(
  jobs: readonly ReviewJob[],
  release: ActiveReviewSubmissionDependencies["release"],
) {
  await Promise.all(jobs.filter((job) => job.status === "failed" || job.status === "completed").map((job) => release(job, activeReviewJobOwner(job.id))));
}

export async function submitActiveReview(
  review: ReviewRequest,
  submissionId: string,
  enqueue: () => Promise<ReviewJob>,
  dependencies: ActiveReviewSubmissionDependencies,
  start: (job: ReviewJob) => Promise<unknown> = async () => undefined,
) {
  const owner = claimOwner(submissionId);
  const currentOwner = await dependencies.claim(review, owner);
  if (currentOwner !== owner) {
    if (!currentOwner.startsWith("job:")) throw new ReviewSubmissionConflictError();
    const existingId = currentOwner.slice(4);
    const existing = existingId ? await dependencies.getJob(existingId) : null;
    if (existing && ["queued", "retrying", "running"].includes(existing.status)) {
      if (existing.status !== "running") await start(existing);
      return existing;
    }
    if (!await dependencies.takeover(review, currentOwner, owner)) throw new ReviewSubmissionConflictError();
  }
  let attached = false;
  try {
    const job = await enqueue();
    if (job.status === "completed" || job.status === "failed") {
      await dependencies.release(review, owner);
      return job;
    }
    if (!await dependencies.attach(review, owner, activeReviewJobOwner(job.id))) {
      throw new Error("Review submission ownership was lost before the queued job could be attached.");
    }
    attached = true;
    await start(job);
    return job;
  } catch (error) {
    if (!attached) await dependencies.release(review, owner).catch((releaseError) => console.error("Unable to release failed review claim", releaseError));
    throw error;
  }
}
