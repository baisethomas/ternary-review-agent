import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRepository, isGitHubAccessMissing } from "./github";

describe("GitHub access errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a rate-limited 403 retryable instead of reporting revoked access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
    })));

    const error = await getRepository("ternary", "agent", "token").catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isGitHubAccessMissing(error)).toBe(false);
  });

  it.each([403, 404])("reports a confirmed %s access response as missing", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status })));

    const error = await getRepository("ternary", "agent", "token").catch((caught) => caught);

    expect(isGitHubAccessMissing(error)).toBe(true);
  });
});
