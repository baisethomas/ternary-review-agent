import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./review-event-ledger-service", () => ({ recordFindingFeedbackEvent: vi.fn() }));
import { ingestGitHubFindingFeedback } from "./github-finding-feedback";

const request = { owner: "ternary", repo: "agent", pullNumber: 8, installationId: 7, headSha: "head", cloneUrl: "https://example.test/agent.git" };
function dependencies(permission = "write") {
  return {
    createToken: vi.fn(async () => "token"), permission: vi.fn(async () => permission) as never,
    getComment: vi.fn(async () => ({ id: 10, body: "Finding\n\n<!-- ternary-finding:ternary/agent#8:finding:auth -->", user: { login: "ternary-review-agent[bot]", type: "Bot" } })),
    getApp: vi.fn(async () => ({ slug: "ternary-review-agent" })) as never,
    listReactions: vi.fn(async () => []) as never, record: vi.fn(async () => undefined) as never,
  };
}

describe("GitHub finding feedback", () => {
  it("records a reply against its root finding and preserves the human reason", async () => {
    const deps = dependencies();
    await expect(ingestGitHubFindingFeedback({ request, deliveryId: "delivery-1", actor: "maintainer", kind: "reply", rootCommentId: 10, reason: "This is intentional" }, deps)).resolves.toMatchObject({ accepted: true });
    expect(deps.record).toHaveBeenCalledWith(request, expect.objectContaining({ feedbackId: "delivery-1", findingId: "ternary/agent#8:finding:auth", actor: "maintainer", reason: "This is intentional" }));
  });

  it("rejects feedback from readers before mutating the ledger", async () => {
    const deps = dependencies("read");
    await expect(ingestGitHubFindingFeedback({ request, deliveryId: "delivery-2", actor: "reader", kind: "dismissed", rootCommentId: 10 }, deps)).resolves.toMatchObject({ accepted: false });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("is harmless when a rewritten comment no longer contains a finding marker", async () => {
    const deps = dependencies();
    deps.getComment.mockResolvedValueOnce({ id: 10, body: "ordinary comment", user: { login: "ternary-review-agent[bot]", type: "Bot" } });
    await expect(ingestGitHubFindingFeedback({ request, deliveryId: "delivery-3", actor: "maintainer", kind: "reply", rootCommentId: 10 }, deps)).resolves.toMatchObject({ accepted: false });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("rejects a canonical marker copied from another pull request", async () => {
    const deps = dependencies();
    deps.getComment.mockResolvedValueOnce({ id: 10, body: "Finding\n\n<!-- ternary-finding:ternary/agent#9:finding:auth -->", user: { login: "ternary-review-agent[bot]", type: "Bot" } });
    await expect(ingestGitHubFindingFeedback({
      request, deliveryId: "delivery-copied", actor: "maintainer", kind: "reply",
      rootCommentId: 10,
    }, deps)).resolves.toMatchObject({ accepted: false, reason: "Finding belongs to another pull request" });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("rejects a canonical marker copied into a human-owned root comment", async () => {
    const deps = dependencies();
    deps.getComment.mockResolvedValueOnce({ id: 10, body: "<!-- ternary-finding:ternary/agent#8:finding:auth -->", user: { login: "maintainer", type: "User" } });

    await expect(ingestGitHubFindingFeedback({ request, deliveryId: "delivery-human", actor: "maintainer", kind: "reply", rootCommentId: 10 }, deps))
      .resolves.toMatchObject({ accepted: false, reason: "Root comment is not owned by Ternary" });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("uses GitHub's current reactions when creation arrives after deletion", async () => {
    const deps = dependencies();

    await ingestGitHubFindingFeedback({
      request, deliveryId: "delivery-delete", actor: "maintainer", kind: "reaction", rootCommentId: 10,
      signal: { id: "github-reaction:11", type: "dismissal_reaction", active: false },
    }, deps);
    await ingestGitHubFindingFeedback({
      request, deliveryId: "delivery-delayed-create", actor: "maintainer", kind: "reaction", rootCommentId: 10,
      signal: { id: "github-reaction:11", type: "dismissal_reaction", active: true },
    }, deps);

    expect(deps.record).toHaveBeenNthCalledWith(1, request, expect.objectContaining({ signal: expect.objectContaining({ active: false }) }));
    expect(deps.record).toHaveBeenNthCalledWith(2, request, expect.objectContaining({ signal: expect.objectContaining({ active: false }) }));
  });
});
