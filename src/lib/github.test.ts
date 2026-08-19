import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRepository } from "./github";
import { isRetryableReviewError } from "./review-errors";

describe("GitHub fetch timeouts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("attaches an abort signal to every GitHub API call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getRepository("ternary", "agent", "token");

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rewraps a timeout abort as a retryable error naming the timed-out call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation timed out", "TimeoutError")));

    const error = await getRepository("ternary", "agent", "token").catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("timed out after");
    expect(isRetryableReviewError(error)).toBe(true);
  });
});
