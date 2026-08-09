import { describe, expect, it } from "vitest";
import { ReviewInvocationTracker } from "./review-invocation";

describe("ReviewInvocationTracker", () => {
  it("reuses an invocation after a lost response and rotates it after confirmation", () => {
    let sequence = 0;
    const tracker = new ReviewInvocationTracker(() => `invocation-${++sequence}`);

    expect(tracker.current("repo#1:sha")).toBe("invocation-1");
    expect(tracker.current("repo#1:sha")).toBe("invocation-1");

    tracker.confirm("repo#1:sha");
    expect(tracker.current("repo#1:sha")).toBe("invocation-2");
  });

  it("tracks different reviews independently", () => {
    let sequence = 0;
    const tracker = new ReviewInvocationTracker(() => `invocation-${++sequence}`);

    expect(tracker.current("repo#1:sha-a")).toBe("invocation-1");
    expect(tracker.current("repo#2:sha-b")).toBe("invocation-2");
    expect(tracker.current("repo#1:sha-a")).toBe("invocation-1");
  });
});
