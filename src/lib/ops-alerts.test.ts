import { describe, expect, it } from "vitest";
import { evaluateOpsAlerts } from "./ops-alerts";

describe("ops-alerts", () => {
  it("emits queue growth and sustained failure alerts at thresholds", () => {
    expect(evaluateOpsAlerts({ activeQueueDepth: 24, failedJobCount: 4 })).toEqual([]);
    expect(evaluateOpsAlerts({ activeQueueDepth: 25, failedJobCount: 5 })).toEqual([
      expect.objectContaining({ kind: "queue_growth", key: "queue_growth" }),
      expect.objectContaining({ kind: "sustained_failures", key: "sustained_failures" }),
    ]);
  });

  it("emits unusual spend alerts for approaching or exceeded budgets", () => {
    expect(evaluateOpsAlerts({
      activeQueueDepth: 0,
      failedJobCount: 0,
      spend: [
        { label: "ternary/agent", status: "ok", spentUsd: 1, monthlyCeilingUsd: 10 },
        { label: "ternary/agent", status: "exceeded", spentUsd: 12, monthlyCeilingUsd: 10 },
      ],
    })).toEqual([
      expect.objectContaining({
        kind: "unusual_spend",
        key: "unusual_spend:ternary/agent",
        details: expect.objectContaining({ status: "exceeded" }),
      }),
    ]);
  });
});
