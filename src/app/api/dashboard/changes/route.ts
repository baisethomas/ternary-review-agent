import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardChangeCursor } from "@/lib/dashboard-change-service";
import { createDashboardChangesHandler } from "@/lib/dashboard-change-route";

export const GET = createDashboardChangesHandler({
  isAuthenticated: isDashboardAuthenticated,
  readCursor: getDashboardChangeCursor,
});
