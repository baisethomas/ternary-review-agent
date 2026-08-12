import "server-only";
import { dispatchInternalTask } from "./internal-task-dispatcher";

export async function dispatchReviewWorker(availableAt = Date.now()) {
  // One retry only — worker wakes are frequent; QStash retry storms amplify quota burn.
  return dispatchInternalTask(
    "/api/reviews/worker",
    { source: "ternary-review-queue" },
    "ternary-review-worker",
    availableAt,
    { retries: 1 },
  );
}
