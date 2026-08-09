import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";

const githubApi = "https://api.github.com";

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new NonRetryableReviewError(`Missing required environment variable: ${name}`);
  return value;
}

async function githubResponseError(response: Response, label = "GitHub API") {
  const message = `${label} ${response.status}: ${await response.text()}`;
  const rateLimited = response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
  const retryable = rateLimited || isRetryableHttpStatus(response.status);
  return retryable ? new Error(message) : new NonRetryableReviewError(message);
}

export function verifyWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", requireEnv("GITHUB_WEBHOOK_SECRET")).update(rawBody).digest("hex");
  const received = signature.slice("sha256=".length);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function createAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: requireEnv("GITHUB_APP_ID") }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const configuredKey = requireEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
  const privateKey = configuredKey.startsWith("-----BEGIN")
    ? configuredKey
    : Buffer.from(configuredKey, "base64").toString("utf8");
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function githubFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${githubApi}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ternary-review-agent",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw await githubResponseError(response);
  }
  return response.json() as Promise<T>;
}

export type GitHubApp = {
  slug: string;
  html_url: string;
  name: string;
};

export type GitHubInstallation = {
  id: number;
  html_url: string;
  target_type: "User" | "Organization";
  account: { login: string; avatar_url: string; type: string };
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: { login: string };
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string };
  base: { ref: string };
};

export type GitHubCheckRun = {
  id: number;
  external_id: string | null;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
};

export function getGitHubApp() {
  return githubFetch<GitHubApp>("/app", createAppJwt());
}

export async function listAppInstallations() {
  const installations: GitHubInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch<GitHubInstallation[]>(`/app/installations?per_page=100&page=${page}`, createAppJwt());
    installations.push(...batch);
    if (batch.length < 100) return installations;
  }
}

export async function listInstallationRepositories(token: string) {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch<{ total_count: number; repositories: GitHubRepository[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
    repositories.push(...batch.repositories);
    if (repositories.length >= batch.total_count || batch.repositories.length < 100) {
      return { total_count: batch.total_count, repositories };
    }
  }
}

export async function listOpenPullRequests(owner: string, repo: string, token: string) {
  const pullRequests: Array<Omit<GitHubPullRequest, "additions" | "deletions" | "changed_files">> = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch<Array<Omit<GitHubPullRequest, "additions" | "deletions" | "changed_files">>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
      token,
    );
    pullRequests.push(...batch);
    if (batch.length < 100) return pullRequests;
  }
}

export function getPullRequest(owner: string, repo: string, pullNumber: number, token: string) {
  return githubFetch<GitHubPullRequest>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    token,
  );
}

export function listTernaryCheckRuns(owner: string, repo: string, headSha: string, token: string) {
  return githubFetch<{ total_count: number; check_runs: GitHubCheckRun[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent("Ternary review")}&per_page=20`,
    token,
  );
}

export async function createInstallationToken(installationId: number) {
  const result = await githubFetch<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    createAppJwt(),
    { method: "POST" },
  );
  return result.token;
}

export async function getPullRequestDiff(owner: string, repo: string, pullNumber: number, token: string) {
  const response = await fetch(`${githubApi}/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    headers: {
      Accept: "application/vnd.github.diff",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ternary-review-agent",
    },
  });
  if (!response.ok) throw await githubResponseError(response, "Unable to fetch PR diff");
  return response.text();
}

export async function createCheckRun(owner: string, repo: string, headSha: string, token: string) {
  return createCheckRunForJob(owner, repo, headSha, token);
}

async function createCheckRunForJob(owner: string, repo: string, headSha: string, token: string, externalId?: string) {
  return githubFetch<{ id: number }>(`/repos/${owner}/${repo}/check-runs`, token, {
    method: "POST",
    body: JSON.stringify({ name: "Ternary review", head_sha: headSha, status: "in_progress", external_id: externalId }),
  });
}

export async function getOrCreateCheckRun(owner: string, repo: string, headSha: string, token: string, externalId?: string) {
  if (externalId) {
    const existing = await listTernaryCheckRuns(owner, repo, headSha, token);
    const match = existing.check_runs.find((check) => check.external_id === externalId);
    if (match) return { id: match.id };
  }
  return createCheckRunForJob(owner, repo, headSha, token, externalId);
}

export async function finishCheckRun(owner: string, repo: string, checkId: number, token: string, conclusion: "success" | "failure" | "neutral", title: string, summary: string, details?: string) {
  return githubFetch(`/repos/${owner}/${repo}/check-runs/${checkId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed", conclusion, completed_at: new Date().toISOString(), output: { title, summary: summary.slice(0, 65000), text: details?.slice(0, 65000) } }),
  });
}

export async function postPullRequestComment(owner: string, repo: string, pullNumber: number, token: string, body: string) {
  return githubFetch(`/repos/${owner}/${repo}/issues/${pullNumber}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function upsertPullRequestComment(owner: string, repo: string, pullNumber: number, token: string, body: string, externalId?: string) {
  if (!externalId) return postPullRequestComment(owner, repo, pullNumber, token, body);
  const marker = `<!-- ternary-review-job:${externalId} -->`;
  for (let page = 1; ; page += 1) {
    const comments = await githubFetch<Array<{ id: number; body: string | null }>>(
      `/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    const existing = comments.find((comment) => comment.body?.includes(marker));
    if (existing) {
      return githubFetch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
    }
    if (comments.length < 100) break;
  }
  return postPullRequestComment(owner, repo, pullNumber, token, body);
}
