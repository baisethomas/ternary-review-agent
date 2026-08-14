import { describe, expect, it } from "vitest";
import { resolveReviewRouteConfig } from "./review-route-config";

describe("resolveReviewRouteConfig", () => {
  it("defaults to single-model routing with full sandbox checks", () => {
    expect(resolveReviewRouteConfig({})).toEqual({
      executionMode: "single",
      shadowEnabled: false,
      slimSandboxOnLowRisk: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });

  it("enables shadow mode and risk routing from env", () => {
    expect(resolveReviewRouteConfig({
      REVIEW_ROUTE_MODE: "risk",
      REVIEW_ROUTE_SHADOW: "true",
      REVIEW_ROUTE_SLIM_SANDBOX: "1",
      REVIEW_ROUTE_SCOUT_MODEL: "openai/gpt-5.6-sol",
      REVIEW_ROUTE_DEEP_MODEL: "anthropic/claude-opus-4.6",
    })).toEqual({
      executionMode: "risk",
      shadowEnabled: true,
      slimSandboxOnLowRisk: true,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
      scoutModel: "openai/gpt-5.6-sol",
      deepModel: "anthropic/claude-opus-4.6",
    });
  });

  it("ignores invalid large-diff overrides", () => {
    expect(resolveReviewRouteConfig({
      REVIEW_ROUTE_LARGE_DIFF_LINES: "nope",
      REVIEW_ROUTE_LARGE_DIFF_FILES: "-1",
    })).toEqual({
      executionMode: "single",
      shadowEnabled: false,
      slimSandboxOnLowRisk: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });
});
