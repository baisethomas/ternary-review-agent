import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { createAnalyticsExportHandler } from "@/lib/analytics-export-route";
import { analyticsEventPages } from "@/lib/review-analytics-service";

export const GET = createAnalyticsExportHandler({ isAuthenticated: isDashboardAuthenticated, pages: analyticsEventPages });
