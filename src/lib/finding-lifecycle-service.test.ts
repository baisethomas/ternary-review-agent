import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./review-event-ledger-service", () => ({ reviewEventLedger: vi.fn() }));
import { loadFindingLifecycles } from "./finding-lifecycle-service";
import type { ReviewEvent, ReviewEventLedger } from "./review-event-ledger";

describe("finding lifecycle service", () => {
  it("pages only the selected pull request and reconciles its latest head", async () => {
    const completed: ReviewEvent = { eventId: "completed", idempotencyKey: "completed", reviewId: "ternary/agent#8:old", type: "review.completed", occurredAt: "2026-08-01T00:00:00Z", scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "old", payload: { jobId: "job", attempt: 1, verdict: "request_changes", summary: "Finding", findings: [{ findingId: "finding-auth", findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Check" }], sandbox: { sandboxId: "sandbox", durationMs: 1, commands: [] } } };
    const list = vi.fn().mockResolvedValueOnce({ events: [completed], nextCursor: "1" }).mockResolvedValueOnce({ events: [], nextCursor: null });
    const ledger = { list } as unknown as ReviewEventLedger;

    await expect(loadFindingLifecycles(completed.scope, 8, "new", ledger)).resolves.toMatchObject([{ findingId: "finding-auth", state: "stale" }]);
    expect(list).toHaveBeenNthCalledWith(1, completed.scope, { after: undefined, pullNumber: 8, limit: 250 });
    expect(list).toHaveBeenNthCalledWith(2, completed.scope, { after: "1", pullNumber: 8, limit: 250 });
  });
});
