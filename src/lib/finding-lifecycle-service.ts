import "server-only";
import { projectFindingLifecycles } from "./finding-lifecycle";
import { reviewEventLedger } from "./review-event-ledger-service";
import type { ReviewEventLedger } from "./review-event-ledger";
import type { RepositoryScope } from "./repository-index";

export async function loadFindingLifecycles(scope: RepositoryScope, pullNumber: number, currentHeadSha: string, ledger: ReviewEventLedger = reviewEventLedger()) {
  const events = [];
  let after: string | undefined;
  do {
    const page = await ledger.list(scope, { after, pullNumber, limit: 250 });
    events.push(...page.events);
    after = page.nextCursor ?? undefined;
  } while (after);
  return projectFindingLifecycles(events, currentHeadSha);
}
