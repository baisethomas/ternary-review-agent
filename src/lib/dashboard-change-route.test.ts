import { describe, expect, it, vi } from "vitest";
import { createDashboardChangesHandler } from "./dashboard-change-route";

describe("dashboard change endpoint", () => {
  it("does not expose the cursor without an authenticated dashboard session", async () => {
    const readCursor = vi.fn(async () => 42);
    const handle = createDashboardChangesHandler({ isAuthenticated: async () => false, readCursor });

    const response = await handle();

    expect(response.status).toBe(401);
    expect(readCursor).not.toHaveBeenCalled();
  });

  it("returns an uncached monotonic cursor to an authenticated dashboard", async () => {
    const handle = createDashboardChangesHandler({ isAuthenticated: async () => true, readCursor: async () => 42 });

    const response = await handle();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.json()).toEqual({ cursor: 42 });
  });
});
