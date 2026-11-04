import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { finishCheckRun, getRepository, TERNARY_RERUN_ACTION } from "./github";
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

describe("finishCheckRun", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("completes the check with a Re-run Ternary requested_action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await finishCheckRun("ternary", "agent", 99, "token", "failure", "Sandbox infrastructure failure", "infra summary");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      conclusion: string;
      output: { title: string };
      actions: Array<{ identifier: string; label: string }>;
    };
    expect(body.conclusion).toBe("failure");
    expect(body.output.title).toBe("Sandbox infrastructure failure");
    expect(body.actions).toEqual([TERNARY_RERUN_ACTION]);
    expect(TERNARY_RERUN_ACTION.label.length).toBeLessThanOrEqual(20);
    expect(TERNARY_RERUN_ACTION.description.length).toBeLessThanOrEqual(40);
    expect(TERNARY_RERUN_ACTION.identifier.length).toBeLessThanOrEqual(20);
  });
});
