import { describe, expect, it } from "vitest";
import { safeReviewPolicy } from "./review-policy";
import { prepareReviewRoute } from "./review-route-preparation";
import { selectReviewRoute, shouldSlimSandbox } from "./review-route-selector";
import type { SandboxResult } from "./types";

const sandbox: SandboxResult = {
  ok: true,
  commands: [],
  durationMs: 500,
  sandboxId: "sandbox-1",
};

const baseConfig = {
  executionMode: "single" as const,
  shadowEnabled: false,
  slimSandboxOnLowRisk: false,
  largeDiffLineThreshold: 400,
  largeDiffFileThreshold: 40,
};

describe("selectReviewRoute", () => {
  it("keeps single-model execution using the resolved policy model", () => {
    const preparation = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, baseConfig);
    const route = selectReviewRoute(preparation, { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" }, baseConfig);
    expect(route.mode).toBe("single");
    expect(route.selectedRole).toBe("scout");
    expect(route.reviewModel).toBe("openai/gpt-5.6-sol");
    expect(route.shadow).toBeUndefined();
  });

  it("selects scout/deep models by risk floor when risk routing is enabled", () => {
    const lowPrep = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, baseConfig);
    const lowRoute = selectReviewRoute(lowPrep, safeReviewPolicy, {
      ...baseConfig,
      executionMode: "risk",
      scoutModel: "openai/gpt-5.6-sol",
      deepModel: "anthropic/claude-opus-4.6",
    });
    expect(lowRoute.mode).toBe("risk");
    expect(lowRoute.selectedRole).toBe("scout");
    expect(lowRoute.reviewModel).toBe("openai/gpt-5.6-sol");

    const highPrep = prepareReviewRoute([
      'diff --git a/migrations/001.sql b/migrations/001.sql',
      "+++ b/migrations/001.sql",
      "+alter table users",
    ].join("\n"), sandbox, baseConfig);
    const highRoute = selectReviewRoute(highPrep, safeReviewPolicy, {
      ...baseConfig,
      executionMode: "risk",
      scoutModel: "openai/gpt-5.6-sol",
      deepModel: "anthropic/claude-opus-4.6",
    });
    expect(highRoute.selectedRole).toBe("deep");
    expect(highRoute.reviewModel).toBe("anthropic/claude-opus-4.6");
  });

  it("attaches shadow recommendations without changing the active route", () => {
    const preparation = prepareReviewRoute([
      'diff --git a/migrations/001.sql b/migrations/001.sql',
      "+++ b/migrations/001.sql",
      "+alter table users",
    ].join("\n"), sandbox, { ...baseConfig, shadowEnabled: true });
    const route = selectReviewRoute(preparation, safeReviewPolicy, { ...baseConfig, shadowEnabled: true });
    expect(route.mode).toBe("single");
    expect(route.shadow?.recommendedRisk).toBe("high");
    expect(route.shadow?.recommendedStages).toEqual(["router", "scout", "deep"]);
  });
});

describe("shouldSlimSandbox", () => {
  it("only skips build for low-risk reviews when slim sandbox is enabled in risk mode", () => {
    const lowPrep = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, baseConfig);
    expect(shouldSlimSandbox(lowPrep, { ...baseConfig, executionMode: "risk", slimSandboxOnLowRisk: true })).toBe(true);
    expect(shouldSlimSandbox(lowPrep, baseConfig)).toBe(false);
  });
});
