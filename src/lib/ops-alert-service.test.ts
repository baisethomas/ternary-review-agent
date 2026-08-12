import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { InMemoryOpsAlertCooldownStore } from "./ops-alert-cooldown";
import { runOpsAlertCheck } from "./ops-alert-service";
import { InMemoryUsageBudgetStore } from "./usage-budget";
import type { ReviewJob } from "./review-queue";

function job(partial: Partial<ReviewJob> & Pick<ReviewJob, "id" | "status">): ReviewJob {
  return {
    owner: "ternary",
    repo: "agent",
    pullNumber: 1,
    installationId: 7,
    headSha: "head",
    cloneUrl: "https://github.com/ternary/agent.git",
    attempts: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    availableAt: 1,
    ...partial,
  };
}

describe("ops-alert-service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("fires cooldown-gated queue and failure alerts through the notifier", async () => {
    const notify = vi.fn(async () => undefined);
    const cooldown = new InMemoryOpsAlertCooldownStore();
    const result = await runOpsAlertCheck({
      listJobs: async () => [
        job({ id: "q1", status: "queued" }),
        job({ id: "q2", status: "queued" }),
        job({ id: "f1", status: "failed" }),
        job({ id: "f2", status: "failed" }),
      ],
      thresholds: { queueDepth: 2, failedJobCount: 2, cooldownMs: 60_000 },
      cooldown,
      notifier: { notify },
      now: () => 1_000,
    });

    expect(result.fired.map((alert) => alert.kind).sort()).toEqual(["queue_growth", "sustained_failures"]);
    expect(notify).toHaveBeenCalledOnce();

    const again = await runOpsAlertCheck({
      listJobs: async () => result.snapshot && [
        job({ id: "q1", status: "queued" }),
        job({ id: "q2", status: "queued" }),
        job({ id: "f1", status: "failed" }),
        job({ id: "f2", status: "failed" }),
      ],
      thresholds: { queueDepth: 2, failedJobCount: 2, cooldownMs: 60_000 },
      cooldown,
      notifier: { notify },
      now: () => 2_000,
    });
    expect(again.fired).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("includes unusual spend when requested", async () => {
    const budgets = new InMemoryUsageBudgetStore();
    await budgets.save({
      scope: { kind: "repository", installationId: 7, owner: "ternary", repo: "agent" },
      monthlyCeilingUsd: 1,
      updatedBy: "admin",
    });
    const notify = vi.fn(async () => undefined);
    const result = await runOpsAlertCheck({
      includeSpend: true,
      listJobs: async () => [],
      budgets,
      sumSpend: async () => 5,
      cooldown: new InMemoryOpsAlertCooldownStore(),
      notifier: { notify },
    });
    expect(result.fired).toEqual([
      expect.objectContaining({ kind: "unusual_spend", key: "unusual_spend:ternary/agent" }),
    ]);
  });

  it("releases cooldown claims when notification delivery fails", async () => {
    const cooldown = new InMemoryOpsAlertCooldownStore();
    const notify = vi.fn(async () => { throw new Error("webhook unavailable"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runOpsAlertCheck({
      listJobs: async () => [
        job({ id: "q1", status: "queued" }),
        job({ id: "q2", status: "queued" }),
      ],
      thresholds: { queueDepth: 2, failedJobCount: 99, cooldownMs: 60_000 },
      cooldown,
      notifier: { notify },
      now: () => 1_000,
    });
    expect(result.fired).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    await expect(cooldown.claim("queue_growth", 60_000, 1_500)).resolves.toBe(true);
  });
});
