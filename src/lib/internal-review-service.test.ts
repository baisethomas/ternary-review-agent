import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { submitInternalReview } from "./internal-review-service";

describe("internal review submission policy", () => {
  it("replaces caller-supplied settings with the server-resolved policy", async () => {
    const resolvedPolicy = {
      automaticReview: { opened: true, reopened: true, synchronize: true, readyForReview: true },
      minimumSeverity: "blocking" as const,
      model: "openai/gpt-5.6-terra",
      reviewCommands: [],
      excludedPaths: ["generated/**"],
    };
    const resolvePolicy = vi.fn(async () => resolvedPolicy);
    const enqueue = vi.fn(async () => ({ id: "job-1" }));
    const request = {
      owner: "ternary", repo: "agent", pullNumber: 8, installationId: 7, headSha: "head", cloneUrl: "https://github.com/ternary/agent.git",
      policy: { ...resolvedPolicy, model: "attacker/model" },
    };

    await expect(submitInternalReview(request, "request-1", { resolvePolicy, enqueue })).resolves.toEqual({ id: "job-1" });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ policy: resolvedPolicy }),
      "manual-review:ternary/agent#8:head:request-1",
      "request-1",
    );
  });
});
