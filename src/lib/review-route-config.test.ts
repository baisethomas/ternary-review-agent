import { describe, expect, it } from "vitest";
import { resolveReviewRouteConfig } from "./review-route-config";

describe("resolveReviewRouteConfig", () => {
  it("defaults shadow mode off and uses standard large-diff thresholds", () => {
    expect(resolveReviewRouteConfig({})).toEqual({
      shadowEnabled: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });

  it("enables shadow mode from REVIEW_ROUTE_SHADOW", () => {
    expect(resolveReviewRouteConfig({ REVIEW_ROUTE_SHADOW: "true" }).shadowEnabled).toBe(true);
    expect(resolveReviewRouteConfig({ REVIEW_ROUTE_SHADOW: "1" }).shadowEnabled).toBe(true);
  });

  it("ignores invalid large-diff overrides", () => {
    expect(resolveReviewRouteConfig({
      REVIEW_ROUTE_LARGE_DIFF_LINES: "nope",
      REVIEW_ROUTE_LARGE_DIFF_FILES: "-1",
    })).toEqual({
      shadowEnabled: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
  });
});
