import { describe, expect, it } from "vitest";
import { safeReviewPolicy } from "./review-policy";
import { prepareReviewRoute } from "./review-route-preparation";
import { selectReviewRoute } from "./review-route-selector";
import type { SandboxResult } from "./types";

const sandbox: SandboxResult = {
  ok: true,
  commands: [],
  durationMs: 500,
  sandboxId: "sandbox-1",
};

describe("selectReviewRoute", () => {
  it("keeps single-model execution using the resolved policy model", () => {
    const preparation = prepareReviewRoute("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change", sandbox, {
      shadowEnabled: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
    const route = selectReviewRoute(preparation, { ...safeReviewPolicy, model: "openai/gpt-5.6-sol" }, {
      shadowEnabled: false,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
    expect(route.mode).toBe("single");
    expect(route.reviewModel).toBe("openai/gpt-5.6-sol");
    expect(route.shadow).toBeUndefined();
  });

  it("attaches shadow recommendations without changing the active route", () => {
    const preparation = prepareReviewRoute([
      'diff --git a/migrations/001.sql b/migrations/001.sql',
      "+++ b/migrations/001.sql",
      "+alter table users",
    ].join("\n"), sandbox, {
      shadowEnabled: true,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
    const route = selectReviewRoute(preparation, safeReviewPolicy, {
      shadowEnabled: true,
      largeDiffLineThreshold: 400,
      largeDiffFileThreshold: 40,
    });
    expect(route.mode).toBe("single");
    expect(route.shadow?.recommendedRisk).toBe("high");
    expect(route.shadow?.recommendedStages).toEqual(["router", "scout", "deep"]);
  });
});
