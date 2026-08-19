import { describe, expect, it } from "vitest";
import { safeReviewPolicy } from "./review-policy";
import { prepareReviewRoute } from "./review-route-preparation";
import { selectReviewRoute, shouldSkipSandboxBuild, buildReviewModelChain } from "./review-route-selector";
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
  fullSandboxBuild: false,
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

describe("buildReviewModelChain", () => {
  it("deduplicates Flash when it is already the primary model", () => {
    expect(buildReviewModelChain("~deepseek/deepseek-v4-flash-latest", {
      ...baseConfig,
      fallbackModel: "~deepseek/deepseek-v4-flash-latest",
      catchallModel: "openai/gpt-5.6-terra",
    })).toEqual(["~deepseek/deepseek-v4-flash-latest", "openai/gpt-5.6-terra"]);
  });

  it("keeps deep → Flash → Terra when the primary is a different model", () => {
    expect(buildReviewModelChain("moonshotai/kimi-k2.6", baseConfig)).toEqual([
      "moonshotai/kimi-k2.6",
      "~deepseek/deepseek-v4-flash-latest",
      "openai/gpt-5.6-terra",
    ]);
  });
});

describe("shouldSkipSandboxBuild", () => {
  it("skips build by default and runs it only when full sandbox is requested", () => {
    const prep = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, baseConfig);
    expect(shouldSkipSandboxBuild(prep, baseConfig)).toBe(true);
    expect(shouldSkipSandboxBuild(prep, { ...baseConfig, fullSandboxBuild: true })).toBe(false);
  });
});
