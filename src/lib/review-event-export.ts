import type { ReviewEvent } from "./review-event-ledger";

function csvCell(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export const reviewEventsCsvHeader = ["event_id", "occurred_at", "event_type", "review_id", "installation_id", "repository", "pull_number", "head_sha", "payload"].join(",");

export function reviewEventCsvRow(event: ReviewEvent) {
  return [
    event.eventId,
    event.occurredAt,
    event.type,
    event.reviewId,
    event.scope.installationId,
    `${event.scope.owner}/${event.scope.repo}`,
    event.pullNumber,
    event.headSha,
    event.payload,
  ].map(csvCell).join(",");
}

export function reviewEventsCsv(events: ReviewEvent[]) {
  return [reviewEventsCsvHeader, ...events.map(reviewEventCsvRow)].join("\n");
}

export function reviewEventsCsvStream(pages: AsyncIterable<ReviewEvent[]>) {
  const encoder = new TextEncoder();
  const iterator = pages[Symbol.asyncIterator]();
  let headerPending = true;
  let currentPage: ReviewEvent[] = [];
  let currentIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (headerPending) {
        headerPending = false;
        controller.enqueue(encoder.encode(`${reviewEventsCsvHeader}\n`));
        return;
      }
      while (currentIndex >= currentPage.length) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        currentPage = next.value;
        currentIndex = 0;
      }
      controller.enqueue(encoder.encode(`${reviewEventCsvRow(currentPage[currentIndex])}\n`));
      currentIndex += 1;
    },
    async cancel() { await iterator.return?.(); },
  });
}
