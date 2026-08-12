import { describe, expect, it } from "vitest";
import { getInvocationStartedAt, withInvocationStartedAt } from "./review-invocation-budget";

describe("review invocation budget context", () => {
  it("exposes the bound start time only inside the scope", () => {
    expect(getInvocationStartedAt()).toBeUndefined();
    const inside = withInvocationStartedAt(42_000, () => getInvocationStartedAt());
    expect(inside).toBe(42_000);
    expect(getInvocationStartedAt()).toBeUndefined();
  });

  it("supports nested async work", async () => {
    const value = await withInvocationStartedAt(99_000, async () => {
      await Promise.resolve();
      return getInvocationStartedAt();
    });
    expect(value).toBe(99_000);
  });
});
