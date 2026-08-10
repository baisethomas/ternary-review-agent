import { hasBearerToken } from "@/lib/api-auth";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { reviewEventsCsv } from "@/lib/review-event-export";
import { allRepositoryReviewEvents, listRepositoryReviewEvents, RepositoryReviewEventsAccessError } from "@/lib/review-event-query-service";

export async function GET(request: Request) {
  if (!hasBearerToken(request, "INTERNAL_API_TOKEN") && !await isDashboardAuthenticated()) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const repository = url.searchParams.get("repository");
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) return Response.json({ error: "A valid repository is required" }, { status: 400 });
  const reviewId = url.searchParams.get("reviewId") ?? undefined;
  try {
    if (url.searchParams.get("format") === "csv") {
      const csv = reviewEventsCsv(await allRepositoryReviewEvents(repository, reviewId));
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${repository.replace("/", "-")}-review-events.csv"` } });
    }
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) return Response.json({ error: "limit must be between 1 and 250" }, { status: 400 });
    return Response.json(await listRepositoryReviewEvents(repository, { after: url.searchParams.get("after") ?? undefined, limit, reviewId }));
  } catch (error) {
    if (error instanceof RepositoryReviewEventsAccessError) return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
}
