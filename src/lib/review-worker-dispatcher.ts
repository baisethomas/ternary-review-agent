import "server-only";
import { dispatchInternalTask } from "./internal-task-dispatcher";

export async function dispatchReviewWorker(availableAt = Date.now()) {
  return dispatchInternalTask("/api/reviews/worker", { source: "ternary-review-queue" }, "ternary-review-worker", availableAt);
}
