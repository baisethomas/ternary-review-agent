import {
  createInstallationToken,
  getGitHubApp,
  getPullRequest,
  listAppInstallations,
  listInstallationRepositories,
  listOpenPullRequests,
  listTernaryCheckRuns,
  type GitHubCheckRun,
  type GitHubInstallation,
  type GitHubRepository,
} from "./github";
import type { ReviewFinding, ReviewRequest, ReviewResult } from "./types";
import { getWatchedRepositories, normalizeRepositoryName } from "./repository-watch";
import { selectReviewRepositories } from "./review-repository-selection";
import { listDashboardReviewJobs } from "./review-queue-service";
import { applyReviewJobState, findReviewJob, indexReviewJobs } from "./dashboard-review-state";

export type DashboardRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  account: string;
  manageUrl: string;
  watched: boolean;
};

export type DashboardCheck = {
  status: "not_reviewed" | "queued" | "reviewing" | "passed" | "reviewed" | "changes" | "failed";
  conclusion: GitHubCheckRun["conclusion"];
  title: string;
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  findings: ReviewFinding[];
  sandboxSteps: Array<{ command: string; passed: boolean }>;
  sandboxId: string | null;
  sandboxDurationSeconds: number | null;
};

export type DashboardPullRequest = {
  key: string;
  owner: string;
  repo: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  authorAvatar: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  files: number;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  check: DashboardCheck;
};

export type DashboardData = {
  appName: string;
  installUrl: string;
  account: string | null;
  installedRepositoryCount: number;
  repositories: DashboardRepository[];
  selectedRepository: DashboardRepository | null;
  pullRequests: DashboardPullRequest[];
  fetchedAt: string;
};

export type RepositoryDashboardData = {
  installUrl: string;
  installations: Array<{ id: number; account: string; manageUrl: string }>;
  repositories: DashboardRepository[];
  fetchedAt: string;
};

type InstallationRepository = {
  installation: GitHubInstallation;
  repository: GitHubRepository;
  token: string;
};

function installationManageUrl(installation: GitHubInstallation) {
  if (installation.html_url) return installation.html_url;
  return installation.target_type === "Organization"
    ? `https://github.com/organizations/${installation.account.login}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

function parseCheck(checkRun: GitHubCheckRun | undefined): DashboardCheck {
  if (!checkRun) {
    return {
      status: "not_reviewed",
      conclusion: null,
      title: "Not reviewed",
      summary: "Run Ternary to test and review this pull request.",
      startedAt: null,
      completedAt: null,
      detailsUrl: null,
      findings: [],
      sandboxSteps: [],
      sandboxId: null,
      sandboxDurationSeconds: null,
    };
  }

  const markdown = checkRun.output.summary ?? "Ternary is preparing the review.";
  let review: ReviewResult | null = null;
  try {
    review = checkRun.output.text ? JSON.parse(checkRun.output.text) as ReviewResult : null;
  } catch {
    review = null;
  }
  const sandboxSteps = review
    ? review.sandbox.commands.map((command) => ({ command: command.command, passed: command.exitCode === 0 }))
    : Array.from(markdown.matchAll(/- (✅|❌) `([^`]+)`/g)).map((match) => ({ command: match[2], passed: match[1] === "✅" }));
  const sandboxMatch = markdown.match(/Sandbox: `([^`]+)` · (\d+)s/);
  const legacyFindings = Array.from(markdown.matchAll(/### \d+\. (.+?)(?: — `([^`]+)`)?\n\n\*\*(blocking|warning|suggestion)\*\* · ([\s\S]*?)(?=\n\n### \d+\.|\n\n<details>)/g)).map((match) => {
    const [explanation, suggestedFix] = match[4].split("\n\n**Suggested fix:** ");
    const [file, line] = (match[2] ?? "").split(":");
    return { severity: match[3], title: match[1], file, line: line ? Number(line) : undefined, explanation, suggestedFix } as ReviewFinding;
  });
  const findings = review?.findings ?? legacyFindings;
  const status: DashboardCheck["status"] = checkRun.status !== "completed"
    ? "reviewing"
    : checkRun.output.title === "Review failed" || ["cancelled", "timed_out", "action_required"].includes(checkRun.conclusion ?? "")
      ? "failed"
      : checkRun.conclusion === "failure"
        ? "changes"
        : checkRun.conclusion === "success"
          ? "passed"
          : "reviewed";

  return {
    status,
    conclusion: checkRun.conclusion,
    title: checkRun.output.title ?? (status === "reviewing" ? "Reviewing" : "Review complete"),
    summary: review?.summary ?? markdown.replace(/^##[^\n]*\n+/, "").split(/\n\n(?:### \d+\.|No material findings\.|<details>)/)[0].trim(),
    startedAt: checkRun.started_at,
    completedAt: checkRun.completed_at,
    detailsUrl: checkRun.html_url,
    findings,
    sandboxSteps,
    sandboxId: review?.sandbox.sandboxId ?? sandboxMatch?.[1] ?? null,
    sandboxDurationSeconds: review ? Math.round(review.sandbox.durationMs / 1000) : sandboxMatch ? Number(sandboxMatch[2]) : null,
  };
}

async function getInstallationRepositories(providedInstallations?: GitHubInstallation[]): Promise<InstallationRepository[]> {
  const installations = providedInstallations ?? await listAppInstallations();
  const groups = await Promise.all(installations.map(async (installation) => {
    const token = await createInstallationToken(installation.id);
    const result = await listInstallationRepositories(token);
    return result.repositories.map((repository) => ({ installation, repository, token }));
  }));
  return groups.flat();
}

async function getRepositoryCatalog() {
  const appPromise = getGitHubApp();
  const watchedPromise = getWatchedRepositories();
  const installations = await listAppInstallations();
  const [app, installedRepositories, watchedRepositories] = await Promise.all([appPromise, getInstallationRepositories(installations), watchedPromise]);
  const repositories = installedRepositories.map(({ installation, repository }) => ({
    id: repository.id,
    installationId: installation.id,
    fullName: repository.full_name,
    name: repository.name,
    owner: repository.owner.login,
    private: repository.private,
    htmlUrl: repository.html_url,
    defaultBranch: repository.default_branch,
    account: installation.account.login,
    manageUrl: installationManageUrl(installation),
    watched: watchedRepositories.has(normalizeRepositoryName(repository.full_name)),
  })).sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { app, installations, installedRepositories, repositories };
}

export async function getInstalledRepository(fullName: string) {
  const installedRepositories = await getInstallationRepositories();
  const normalized = normalizeRepositoryName(fullName);
  return installedRepositories.find(({ repository }) => normalizeRepositoryName(repository.full_name) === normalized) ?? null;
}

export async function isInstalledRepository(fullName: string) {
  return Boolean(await getInstalledRepository(fullName));
}

export async function getRepositoryDashboardData(): Promise<RepositoryDashboardData> {
  const { app, installations, repositories } = await getRepositoryCatalog();
  return {
    installUrl: `${app.html_url}/installations/new`,
    installations: installations.map((installation) => ({
      id: installation.id,
      account: installation.account.login,
      manageUrl: installationManageUrl(installation),
    })),
    repositories,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getDashboardData(requestedRepository?: string): Promise<DashboardData> {
  const [catalog, reviewJobs] = await Promise.all([getRepositoryCatalog(), listDashboardReviewJobs().catch(() => [])]);
  const { app, installedRepositories, repositories } = catalog;
  const reviewJobIndex = indexReviewJobs(reviewJobs);
  const reviewSelection = selectReviewRepositories(repositories, requestedRepository);
  const selectedRepository = reviewSelection.selectedRepository;
  const selectedRecord = selectedRepository
    ? installedRepositories.find(({ repository }) => repository.full_name === selectedRepository.fullName)
    : undefined;

  let pullRequests: DashboardPullRequest[] = [];
  if (selectedRecord && selectedRepository) {
    const openPullRequests = await listOpenPullRequests(selectedRepository.owner, selectedRepository.name, selectedRecord.token);
    pullRequests = await Promise.all(openPullRequests.map(async (pull) => {
      const [details, checks] = await Promise.all([
        getPullRequest(selectedRepository.owner, selectedRepository.name, pull.number, selectedRecord.token),
        listTernaryCheckRuns(selectedRepository.owner, selectedRepository.name, pull.head.sha, selectedRecord.token),
      ]);
      const latestCheck = checks.check_runs.sort((a, b) => Date.parse(b.started_at ?? "") - Date.parse(a.started_at ?? ""))[0];
      const queueJob = findReviewJob(reviewJobIndex, selectedRepository.owner, selectedRepository.name, pull.number, pull.head.sha);
      return {
        key: `${selectedRepository.fullName}#${pull.number}`,
        owner: selectedRepository.owner,
        repo: selectedRepository.name,
        repository: selectedRepository.fullName,
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        draft: pull.draft,
        author: pull.user?.login ?? "Deleted user",
        authorAvatar: pull.user?.avatar_url ?? "",
        updatedAt: pull.updated_at,
        additions: details.additions,
        deletions: details.deletions,
        files: details.changed_files,
        headBranch: pull.head.ref,
        baseBranch: pull.base.ref,
        headSha: pull.head.sha,
        check: applyReviewJobState(parseCheck(latestCheck), queueJob),
      } satisfies DashboardPullRequest;
    }));
  }

  return {
    appName: app.name,
    installUrl: `${app.html_url}/installations/new`,
    account: selectedRepository?.account ?? repositories[0]?.account ?? null,
    installedRepositoryCount: repositories.length,
    repositories: reviewSelection.repositories,
    selectedRepository,
    pullRequests,
    fetchedAt: new Date().toISOString(),
  };
}

export async function resolveReviewRequest(owner: string, repo: string, pullNumber: number): Promise<ReviewRequest> {
  const installedRepositories = await getInstallationRepositories();
  const match = installedRepositories.find(({ repository }) =>
    repository.owner.login.toLowerCase() === owner.toLowerCase() && repository.name.toLowerCase() === repo.toLowerCase());
  if (!match) throw new Error("Repository is not installed for this GitHub App");
  const pull = await getPullRequest(match.repository.owner.login, match.repository.name, pullNumber, match.token);
  return {
    owner: match.repository.owner.login,
    repo: match.repository.name,
    pullNumber,
    installationId: match.installation.id,
    headSha: pull.head.sha,
    cloneUrl: match.repository.clone_url,
    author: pull.user?.login,
  };
}
