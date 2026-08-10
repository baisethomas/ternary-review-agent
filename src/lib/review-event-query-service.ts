import "server-only";
import { getInstalledRepository } from "./dashboard-data";
import { reviewEventLedger } from "./review-event-ledger-service";
import type { ReviewEventQuery } from "./review-event-ledger";

export class RepositoryReviewEventsAccessError extends Error {
  constructor(repository: string) {
    super(`GitHub access to ${repository} could not be verified`);
    this.name = "RepositoryReviewEventsAccessError";
  }
}

async function authorizedScope(repository: string) {
  const installed = await getInstalledRepository(repository);
  if (!installed) throw new RepositoryReviewEventsAccessError(repository);
  return {
    installationId: installed.installation.id,
    owner: installed.repository.owner.login,
    repo: installed.repository.name,
  };
}

export async function listRepositoryReviewEvents(repository: string, query: ReviewEventQuery = {}) {
  return reviewEventLedger().list(await authorizedScope(repository), query);
}

export async function allRepositoryReviewEvents(repository: string, reviewId?: string) {
  const scope = await authorizedScope(repository);
  const events = [];
  let after: string | undefined;
  do {
    const page = await reviewEventLedger().list(scope, { after, limit: 250, reviewId });
    events.push(...page.events);
    after = page.nextCursor ?? undefined;
  } while (after);
  return events;
}
