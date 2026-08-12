import { describe, expect, it } from "vitest";
import {
  evaluateUsageBudgetVisibility,
  InMemoryUsageBudgetStore,
  resolveUsageBudget,
} from "./usage-budget";

describe("usage-budget", () => {
  it("resolves repository override over organization ceiling", async () => {
    const store = new InMemoryUsageBudgetStore();
    await store.save({
      scope: { kind: "organization", installationId: 7 },
      monthlyCeilingUsd: 50,
      updatedBy: "admin",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    await store.save({
      scope: { kind: "repository", installationId: 7, owner: "Ternary", repo: "Agent" },
      monthlyCeilingUsd: 10,
      updatedBy: "admin",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });

    await expect(resolveUsageBudget(store, { installationId: 7, owner: "ternary", repo: "agent" }))
      .resolves.toMatchObject({ source: "repository", budget: { monthlyCeilingUsd: 10 } });
    await expect(resolveUsageBudget(store, { installationId: 7, owner: "ternary", repo: "other" }))
      .resolves.toMatchObject({ source: "organization", budget: { monthlyCeilingUsd: 50 } });
  });

  it("evaluates visibility statuses without enforcing", () => {
    const scope = { kind: "organization" as const, installationId: 7 };
    expect(evaluateUsageBudgetVisibility({ scope, source: "organization", monthlyCeilingUsd: 100, spentUsd: 20 }))
      .toMatchObject({ status: "ok", remainingUsd: 80, utilization: 0.2, enforcement: "visibility" });
    expect(evaluateUsageBudgetVisibility({ scope, source: "organization", monthlyCeilingUsd: 100, spentUsd: 85 }))
      .toMatchObject({ status: "approaching", remainingUsd: 15 });
    expect(evaluateUsageBudgetVisibility({ scope, source: "organization", monthlyCeilingUsd: 100, spentUsd: 120 }))
      .toMatchObject({ status: "exceeded", remainingUsd: 0, utilization: 1.2 });
  });
});
