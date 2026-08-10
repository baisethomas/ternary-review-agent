import { reviewEventsCsvStream } from "./review-event-export";
import type { ReviewAnalyticsFilters } from "./review-analytics";
import type { ReviewEvent } from "./review-event-ledger";

export type AnalyticsExportDependencies = {
  isAuthenticated: () => Promise<boolean>;
  pages: (filters: ReviewAnalyticsFilters) => Promise<AsyncIterable<ReviewEvent[]>>;
};

function filtersFromUrl(url: URL): ReviewAnalyticsFilters {
  const outcome = url.searchParams.get("outcome");
  return {
    organization: url.searchParams.get("organization") || undefined,
    repository: url.searchParams.get("repository") || undefined,
    author: url.searchParams.get("author") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    rule: url.searchParams.get("rule") || undefined,
    model: url.searchParams.get("model") || undefined,
    outcome: outcome === "approve" || outcome === "request_changes" || outcome === "comment" || outcome === "failed" ? outcome : undefined,
  };
}

export function createAnalyticsExportHandler(dependencies: AnalyticsExportDependencies) {
  return async (request: Request) => {
    if (!await dependencies.isAuthenticated()) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const pages = await dependencies.pages(filtersFromUrl(new URL(request.url)));
    return new Response(reviewEventsCsvStream(pages), {
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=ternary-analytics-events.csv",
      },
    });
  };
}
