import type { ReviewEvent } from "./review-event-ledger";

function csvCell(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function reviewEventsCsv(events: ReviewEvent[]) {
  const columns = ["event_id", "occurred_at", "event_type", "review_id", "installation_id", "repository", "pull_number", "head_sha", "payload"];
  const rows = events.map((event) => [
    event.eventId,
    event.occurredAt,
    event.type,
    event.reviewId,
    event.scope.installationId,
    `${event.scope.owner}/${event.scope.repo}`,
    event.pullNumber,
    event.headSha,
    event.payload,
  ].map(csvCell).join(","));
  return [columns.join(","), ...rows].join("\n");
}
