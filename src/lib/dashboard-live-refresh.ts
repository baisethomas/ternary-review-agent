export type DashboardLiveStatus = "live" | "reconnecting";

export type DashboardLiveRefreshDecision = {
  refresh: boolean;
  status: DashboardLiveStatus;
  delayMs: number;
};

const liveDelayMs = 3_000;
const maximumRetryDelayMs = 30_000;
const reconciliationIntervalMs = 30_000;

export class DashboardLiveRefreshState {
  private failures = 0;

  constructor(private cursor = 0, private lastReconciledAt = Date.now()) {}

  observe(cursor: number): DashboardLiveRefreshDecision {
    const refresh = cursor > this.cursor;
    this.cursor = Math.max(this.cursor, cursor);
    this.failures = 0;
    return { refresh, status: "live", delayMs: liveDelayMs };
  }

  failed(): DashboardLiveRefreshDecision {
    const delayMs = Math.min(liveDelayMs * 2 ** this.failures, maximumRetryDelayMs);
    this.failures += 1;
    return { refresh: false, status: "reconnecting", delayMs };
  }

  disconnected(): DashboardLiveRefreshDecision {
    return { refresh: false, status: "reconnecting", delayMs: maximumRetryDelayMs };
  }

  shouldReconcile(now = Date.now()) {
    if (now - this.lastReconciledAt < reconciliationIntervalMs) return false;
    this.lastReconciledAt = now;
    return true;
  }
}
