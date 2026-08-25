import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installations: vi.fn(),
  token: vi.fn(),
  repositories: vi.fn(),
  pullRequest: vi.fn(),
  app: vi.fn(),
  watched: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./github", () => ({
  createInstallationToken: mocks.token,
  getGitHubApp: mocks.app,
  getPullRequest: mocks.pullRequest,
  listAppInstallations: mocks.installations,
  listInstallationRepositories: mocks.repositories,
  listOpenPullRequests: vi.fn(),
  listTernaryCheckRuns: vi.fn(),
}));
vi.mock("./repository-watch", () => ({ getWatchedRepositories: mocks.watched, normalizeRepositoryName: (value: string) => value.toLowerCase() }));
vi.mock("./review-queue-service", () => ({ listDashboardReviewJobs: vi.fn() }));

import { getRepositoryDashboardData, resolveReviewRequest } from "./dashboard-data";

describe("dashboard review request resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installations.mockResolvedValue([{ id: 7, html_url: "", target_type: "Organization", account: { login: "Ternary", avatar_url: "", type: "Organization" } }]);
    mocks.token.mockResolvedValue("token");
    mocks.repositories.mockResolvedValue({ repositories: [{ id: 1, name: "Agent", full_name: "Ternary/Agent", private: true, html_url: "", clone_url: "https://example.test/agent.git", default_branch: "main", owner: { login: "Ternary" } }] });
    mocks.app.mockResolvedValue({ name: "Ternary", html_url: "https://github.com/apps/ternary" });
    mocks.watched.mockResolvedValue(new Set());
  });

  it("keeps the review available when GitHub no longer has an author account", async () => {
    mocks.pullRequest.mockResolvedValue({ head: { sha: "head", ref: "feature" }, user: null });

    await expect(resolveReviewRequest("Ternary", "Agent", 8)).resolves.toMatchObject({
      owner: "Ternary",
      repo: "Agent",
      pullNumber: 8,
      headSha: "head",
      author: undefined,
    });
  });
});

describe("dashboard repository catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installations.mockResolvedValue([{ id: 7, html_url: "", target_type: "Organization", account: { login: "Ternary", avatar_url: "", type: "Organization" } }]);
    mocks.token.mockResolvedValue("token");
    mocks.repositories.mockResolvedValue({ repositories: [{ id: 1, name: "Agent", full_name: "Ternary/Agent", private: true, html_url: "", clone_url: "https://example.test/agent.git", default_branch: "main", owner: { login: "Ternary" } }] });
    mocks.app.mockResolvedValue({ name: "Ternary", html_url: "https://github.com/apps/ternary" });
  });

  it("renders repositories as unwatched instead of crashing when watched-repository lookup fails", async () => {
    mocks.watched.mockRejectedValue(new Error("UpstashError: max requests limit exceeded"));

    const data = await getRepositoryDashboardData();

    expect(data.repositories).toHaveLength(1);
    expect(data.repositories.every((repository) => repository.watched === false)).toBe(true);
  });
});
