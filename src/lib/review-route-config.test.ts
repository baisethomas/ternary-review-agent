import { describe, expect, it } from "vitest";
import { resolveReviewRouteConfig } from "./review-route-config";

describe("resolveReviewRouteConfig", () => {
  it("defaults to single-model routing and skips sandbox build", () => {
    expect(resolveReviewRouteConfig({})).toEqual({
      executionMode: "single",
      shadowEnabled: false,
      fullSandboxBuild: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });

  it("enables shadow mode, risk routing, and full sandbox build from env", () => {
    expect(resolveReviewRouteConfig({
      REVIEW_ROUTE_MODE: "risk",
      REVIEW_ROUTE_SHADOW: "true",
      REVIEW_ROUTE_FULL_SANDBOX: "1",
      REVIEW_ROUTE_SCOUT_MODEL: "openai/gpt-5.6-sol",
      REVIEW_ROUTE_DEEP_MODEL: "anthropic/claude-opus-4.6",
      REVIEW_ROUTE_FALLBACK_MODEL: "~deepseek/deepseek-v4-flash-latest",
      REVIEW_ROUTE_CATCHALL_MODEL: "openai/gpt-5.6-terra",
    })).toEqual({
      executionMode: "risk",
      shadowEnabled: true,
      fullSandboxBuild: true,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
      scoutModel: "openai/gpt-5.6-sol",
      deepModel: "anthropic/claude-opus-4.6",
      fallbackModel: "~deepseek/deepseek-v4-flash-latest",
      catchallModel: "openai/gpt-5.6-terra",
    });
  });

  it("treats legacy REVIEW_ROUTE_SLIM_SANDBOX=0 as a request for full sandbox checks", () => {
    expect(resolveReviewRouteConfig({ REVIEW_ROUTE_SLIM_SANDBOX: "0" }).fullSandboxBuild).toBe(true);
  });

  it("ignores invalid large-diff overrides", () => {
    expect(resolveReviewRouteConfig({
      REVIEW_ROUTE_LARGE_DIFF_LINES: "nope",
      REVIEW_ROUTE_LARGE_DIFF_FILES: "-1",
    })).toEqual({
      executionMode: "single",
      shadowEnabled: false,
      fullSandboxBuild: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });
});
