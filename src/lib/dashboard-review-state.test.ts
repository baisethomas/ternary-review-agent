import { describe, expect, it } from "vitest";
import { applyReviewJobState, indexReviewJobs } from "./dashboard-review-state";
import type { DashboardCheck } from "./dashboard-data";
import type { ReviewJob } from "./review-queue";

const emptyCheck: DashboardCheck = {
  status: "not_reviewed",
  conclusion: null,
  title: "Not reviewed",
  summary: "No review",
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  findings: [],
  sandboxSteps: [],
  sandboxId: null,
  sandboxDurationSeconds: null,
};

function job(status: ReviewJob["status"], updatedAt = 200): ReviewJob {
  return {
    id: "job-1",
    owner: "ternary",
    repo: "agent",
    pullNumber: 8,
    installationId: 7,
    headSha: "head",
    cloneUrl: "https://example.com/repo.git",
    status,
    attempts: 1,
    maxAttempts: 3,
    createdAt: 100,
    updatedAt,
    availableAt: 100,
  };
}

describe("dashboard review job state", () => {
  it("shows persisted queued and running states", () => {
    expect(applyReviewJobState(emptyCheck, job("queued")).status).toBe("queued");
    expect(applyReviewJobState(emptyCheck, job("retrying")).status).toBe("queued");
    expect(applyReviewJobState(emptyCheck, job("running")).status).toBe("reviewing");
  });

  it("shows a persisted terminal failure", () => {
    const result = applyReviewJobState(emptyCheck, { ...job("failed"), lastError: "Sandbox unavailable" });
    expect(result).toMatchObject({ status: "failed", title: "Review failed", summary: "Sandbox unavailable" });
  });

  it("clears results from an older attempt when a re-review starts", () => {
    const previous = { ...emptyCheck, status: "passed" as const, findings: [{ severity: "warning" as const, file: "old.ts", title: "Old finding", explanation: "Old" }], sandboxSteps: [{ command: "npm test", passed: true }], sandboxId: "old-sandbox", sandboxDurationSeconds: 20 };
    expect(applyReviewJobState(previous, job("queued"))).toMatchObject({ status: "queued", findings: [], sandboxSteps: [], sandboxId: null, sandboxDurationSeconds: null, conclusion: null });
  });

  it("does not let an older queue record replace a newer GitHub check", () => {
    const completed = { ...emptyCheck, status: "passed" as const, startedAt: new Date(300).toISOString() };
    expect(applyReviewJobState(completed, job("queued", 200))).toBe(completed);
  });

  it("indexes an active job even when more than one hundred newer jobs exist", () => {
    const active = job("queued", 200);
    const newer = Array.from({ length: 101 }, (_, index) => ({ ...job("completed", 300 + index), id: `newer-${index}`, pullNumber: 100 + index }));
    expect(indexReviewJobs([...newer, active]).get("ternary/agent#8:head")).toEqual(active);
  });
});
