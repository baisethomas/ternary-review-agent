import { describe, expect, it, vi } from "vitest";
import { createAnalyticsExportHandler } from "./analytics-export-route";

describe("analytics export endpoint", () => {
  it("does not expose analytics without a dashboard session", async () => {
    const pages = vi.fn();
    const handle = createAnalyticsExportHandler({ isAuthenticated: async () => false, pages });

    const response = await handle(new Request("https://ternary.test/api/analytics/export"));

    expect(response.status).toBe(401);
    expect(pages).not.toHaveBeenCalled();
  });

  it("passes every supported filter to the server-side export", async () => {
    const pages = vi.fn(async () => (async function* () { yield []; })());
    const handle = createAnalyticsExportHandler({ isAuthenticated: async () => true, pages });
    const response = await handle(new Request("https://ternary.test/api/analytics/export?organization=ternary&repository=ternary%2Fagent&author=Ada&from=2026-08-01&to=2026-08-09&rule=security-auth&model=gpt-review&outcome=approve"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("ternary-analytics-events.csv");
    expect(pages).toHaveBeenCalledWith({ organization: "ternary", repository: "ternary/agent", author: "Ada", from: "2026-08-01", to: "2026-08-09", rule: "security-auth", model: "gpt-review", outcome: "approve" });
  });
});
