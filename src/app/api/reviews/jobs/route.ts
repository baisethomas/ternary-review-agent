import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { hasBearerToken } from "@/lib/api-auth";
import { listReviewJobs } from "@/lib/review-queue-service";

export async function GET(request: Request) {
  const tokenAuthorized = hasBearerToken(request, "INTERNAL_API_TOKEN");
  if (!tokenAuthorized && !await isDashboardAuthenticated()) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobs = await listReviewJobs();
  return Response.json({ jobs });
}
