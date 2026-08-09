import { describe, expect, it } from "vitest";
import { DashboardLiveRefreshState } from "./dashboard-live-refresh";

describe("dashboard live refresh state", () => {
  it("starts from the server-rendered cursor and refreshes only for a newer cursor", () => {
    const state = new DashboardLiveRefreshState(12);

    expect(state.observe(12)).toEqual({ refresh: false, status: "live", delayMs: 3_000 });
    expect(state.observe(11)).toEqual({ refresh: false, status: "live", delayMs: 3_000 });
    expect(state.observe(13)).toEqual({ refresh: true, status: "live", delayMs: 3_000 });
  });

  it("backs off after disconnection and recovers without replaying a stale cursor", () => {
    const state = new DashboardLiveRefreshState();
    state.observe(20);

    expect(state.failed()).toEqual({ refresh: false, status: "reconnecting", delayMs: 3_000 });
    expect(state.failed()).toEqual({ refresh: false, status: "reconnecting", delayMs: 6_000 });
    expect(state.failed()).toEqual({ refresh: false, status: "reconnecting", delayMs: 12_000 });
    expect(state.failed()).toEqual({ refresh: false, status: "reconnecting", delayMs: 24_000 });
    expect(state.failed()).toEqual({ refresh: false, status: "reconnecting", delayMs: 30_000 });
    expect(state.observe(20)).toEqual({ refresh: false, status: "live", delayMs: 3_000 });
    expect(state.observe(21)).toEqual({ refresh: true, status: "live", delayMs: 3_000 });
  });

  it("reports a browser disconnection immediately", () => {
    expect(new DashboardLiveRefreshState().disconnected()).toMatchObject({ status: "reconnecting", refresh: false });
  });

  it("periodically reconciles even when a change announcement was missed", () => {
    const state = new DashboardLiveRefreshState(4, 1_000);
    expect(state.shouldReconcile(30_999)).toBe(false);
    expect(state.shouldReconcile(31_000)).toBe(true);
    expect(state.shouldReconcile(31_001)).toBe(false);
  });
});
