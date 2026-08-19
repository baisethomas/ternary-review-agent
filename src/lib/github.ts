import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";
import { findingIdFromComment } from "./finding-comment";

const githubApi = "https://api.github.com";

/** Bound every GitHub call so a hung request cannot consume the worker invocation. */
export const GITHUB_FETCH_TIMEOUT_MS = 15_000;
/** Diff downloads can be large; give them a longer bound. */
export const GITHUB_DIFF_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit, label: string, timeoutMs = GITHUB_FETCH_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      // Plain Error: timeouts are retryable.
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

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
  const error = retryable ? new Error(message) : new NonRetryableReviewError(message);
  return Object.assign(error, {
    status: response.status,
    accessMissing: response.status === 404 || (response.status === 403 && !rateLimited),
  });
}

export function isGitHubAccessMissing(error: unknown) {
  return error instanceof Error && "accessMissing" in error && error.accessMissing === true;
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
  const response = await fetchWithTimeout(`${githubApi}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ternary-review-agent",
      ...init.headers,
    },
  }, `GitHub API ${path}`);
  if (!response.ok) {
    throw await githubResponseError(response);
  }
  return response.json() as Promise<T>;
}

async function githubGraphql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const response = await fetchWithTimeout(`${githubApi}/graphql`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ternary-review-agent",
    },
    body: JSON.stringify({ query, variables }),
  }, "GitHub GraphQL API");
  if (!response.ok) throw await githubResponseError(response, "GitHub GraphQL API");
  const result = await response.json() as { data?: T; errors?: Array<{ message: string; type?: string }> };
  if (result.errors?.length || !result.data) throw new GitHubGraphqlError(result.errors ?? []);
  return result.data;
}

class GitHubGraphqlError extends Error {
  constructor(readonly errors: Array<{ message: string; type?: string }>) {
    super(`GitHub GraphQL API: ${errors.map((error) => error.message).join("; ") || "missing data"}`);
    this.name = "GitHubGraphqlError";
  }
}

function isGitHubGraphqlForbidden(error: unknown) {
  return error instanceof GitHubGraphqlError && error.errors.length > 0 && error.errors.every((item) =>
    item.type === "FORBIDDEN" || item.message === "Resource not accessible by integration"
  );
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
  user: { login: string; avatar_url: string } | null;
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

export function getBranch(owner: string, repo: string, branch: string, token: string) {
  return githubFetch<{ name: string; commit: { sha: string } }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
    token,
  );
}

export function getRepository(owner: string, repo: string, token: string) {
  return githubFetch<GitHubRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
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
  const response = await fetchWithTimeout(`${githubApi}/repos/${owner}/${repo}/pulls/${pullNumber}`, {
    headers: {
      Accept: "application/vnd.github.diff",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ternary-review-agent",
    },
  }, "PR diff fetch", GITHUB_DIFF_TIMEOUT_MS);
  if (!response.ok) throw await githubResponseError(response, "Unable to fetch PR diff");
  return response.text();
}

export async function getRepositoryTree(owner: string, repo: string, commitSha: string, token: string) {
  return githubFetch<{ truncated: boolean; tree: Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }> }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    token,
  );
}

export async function getRepositoryBlob(owner: string, repo: string, blobSha: string, token: string) {
  const blob = await githubFetch<{ encoding: "base64"; content: string; size: number }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`,
    token,
  );
  if (blob.encoding !== "base64") throw new NonRetryableReviewError(`Unsupported GitHub blob encoding: ${blob.encoding}`);
  return Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8");
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

function reviewCommentMarker(externalId: string) {
  return `<!-- ternary-review-job:${externalId} -->`;
}

export function tagReviewComment(body: string, externalId: string) {
  const marker = reviewCommentMarker(externalId);
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

export async function upsertPullRequestComment(owner: string, repo: string, pullNumber: number, token: string, body: string, externalId?: string) {
  if (!externalId) return postPullRequestComment(owner, repo, pullNumber, token, body);
  const marker = reviewCommentMarker(externalId);
  const taggedBody = tagReviewComment(body, externalId);
  for (let page = 1; ; page += 1) {
    const comments = await githubFetch<Array<{ id: number; body: string | null }>>(
      `/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    const existing = comments.find((comment) => comment.body?.includes(marker));
    if (existing) {
      return githubFetch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body: taggedBody }),
      });
    }
    if (comments.length < 100) break;
  }
  return postPullRequestComment(owner, repo, pullNumber, token, taggedBody);
}

export type GitHubReviewComment = {
  id: number;
  body: string | null;
  path?: string;
  line?: number | null;
  subject_type?: "line" | "file";
  in_reply_to_id?: number;
  user?: { login: string; type?: string } | null;
};
type GitHubReviewThread = { id: string; isResolved: boolean; commentIds: number[] };
type GitHubReviewThreadsConnection = { nodes: Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ databaseId: number }> } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type GitHubReviewThreadsPage = {
  repository: { pullRequest: { reviewThreads: GitHubReviewThreadsConnection } | null };
};

export function getPullRequestReviewComment(owner: string, repo: string, commentId: number, token: string) {
  return githubFetch<GitHubReviewComment>(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, token);
}

export async function listPullRequestReviewCommentReactions(owner: string, repo: string, commentId: number, token: string) {
  const reactions: Array<{ id: number; content: string }> = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch<Array<{ id: number; content: string }>>(`/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions?per_page=100&page=${page}`, token);
    reactions.push(...batch);
    if (batch.length < 100) return reactions;
  }
}

export async function listPullRequestReviewComments(owner: string, repo: string, pullNumber: number, token: string) {
  const comments: GitHubReviewComment[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubFetch<GitHubReviewComment[]>(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100&page=${page}`, token);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function listPullRequestReviewThreads(owner: string, repo: string, pullNumber: number, token: string) {
  const threads: GitHubReviewThread[] = [];
  let after: string | null = null;
  try {
    do {
      const data: GitHubReviewThreadsPage = await githubGraphql<GitHubReviewThreadsPage>(`
        query TernaryReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes { id isResolved comments(first: 100) { nodes { databaseId } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `, { owner, repo, number: pullNumber, after }, token);
      const connection: GitHubReviewThreadsConnection | undefined = data.repository.pullRequest?.reviewThreads;
      if (!connection) return threads;
      threads.push(...connection.nodes.map((thread) => ({ id: thread.id, isResolved: thread.isResolved, commentIds: thread.comments.nodes.map((comment) => comment.databaseId) })));
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return threads;
  } catch (error) {
    if (isGitHubGraphqlForbidden(error)) return [];
    throw error;
  }
}

async function unresolvePullRequestReviewThread(threadId: string, token: string) {
  try {
    return await githubGraphql(`mutation TernaryUnresolveReviewThread($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`, { threadId }, token);
  } catch (error) {
    if (isGitHubGraphqlForbidden(error)) return null;
    throw error;
  }
}

async function resolvePullRequestReviewThread(threadId: string, token: string) {
  try {
    return await githubGraphql(`mutation TernaryResolveReviewThread($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`, { threadId }, token);
  } catch (error) {
    if (isGitHubGraphqlForbidden(error)) return null;
    throw error;
  }
}

function ownedReviewComment(comment: GitHubReviewComment, botLogin: string) {
  return !comment.in_reply_to_id
    && comment.user?.type === "Bot"
    && comment.user.login.toLowerCase() === botLogin.toLowerCase();
}

function ownedFindingComment(comment: GitHubReviewComment, findingId: string, botLogin: string) {
  return ownedReviewComment(comment, botLogin) && findingIdFromComment(comment.body) === findingId;
}

function sameFindingLocation(comment: GitHubReviewComment, finding: { path: string; line?: number }) {
  return comment.path === finding.path
    && (finding.line ? comment.line === finding.line : comment.subject_type === "file");
}

async function createFindingReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  token: string,
  finding: { body: string; path: string; line?: number },
  currentHeadIsExpected: () => Promise<boolean>,
) {
  const path = `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  const shared = { body: finding.body, commit_id: headSha, path: finding.path };
  try {
    if (!await currentHeadIsExpected()) return null;
    return await githubFetch<GitHubReviewComment>(path, token, { method: "POST", body: JSON.stringify(finding.line ? { ...shared, line: finding.line, side: "RIGHT" } : { ...shared, subject_type: "file" }) });
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error) || error.status !== 422) throw error;
    if (!finding.line) return null;
    try {
      if (!await currentHeadIsExpected()) return null;
      return await githubFetch<GitHubReviewComment>(path, token, { method: "POST", body: JSON.stringify({ ...shared, subject_type: "file" }) });
    } catch (fallbackError) {
      if (fallbackError instanceof Error && "status" in fallbackError && fallbackError.status === 422) return null;
      throw fallbackError;
    }
  }
}

async function resolveObsoleteFindingThreads(
  currentCommentId: number | undefined,
  matchingComments: readonly GitHubReviewComment[],
  reviewThreads: readonly GitHubReviewThread[],
  token: string,
  currentHeadIsExpected: () => Promise<boolean>,
) {
  for (const comment of matchingComments) {
    if (comment.id === currentCommentId) continue;
    const thread = reviewThreads.find((candidate) => candidate.commentIds.includes(comment.id));
    if (thread && !thread.isResolved) {
      if (!await currentHeadIsExpected()) return;
      await resolvePullRequestReviewThread(thread.id, token);
    }
  }
}

async function upsertFindingReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  token: string,
  finding: { findingId: string; body: string; path: string; line?: number },
  existingComments: readonly GitHubReviewComment[],
  reviewThreads: readonly GitHubReviewThread[],
  botLogin: string,
  currentHeadIsExpected: () => Promise<boolean>,
) {
  const matching = existingComments.filter((comment) => ownedFindingComment(comment, finding.findingId, botLogin));
  const existingAtLocation = matching.find((comment) => sameFindingLocation(comment, finding));
  if (existingAtLocation) {
    if (!await currentHeadIsExpected()) return null;
    const updated = await githubFetch(`/repos/${owner}/${repo}/pulls/comments/${existingAtLocation.id}`, token, { method: "PATCH", body: JSON.stringify({ body: finding.body }) });
    const thread = reviewThreads.find((candidate) => candidate.commentIds.includes(existingAtLocation.id));
    if (thread?.isResolved) {
      if (!await currentHeadIsExpected()) return updated;
      await unresolvePullRequestReviewThread(thread.id, token);
    }
    await resolveObsoleteFindingThreads(existingAtLocation.id, matching, reviewThreads, token, currentHeadIsExpected);
    return updated;
  }
  if (matching.length) {
    const created = await createFindingReviewComment(owner, repo, pullNumber, headSha, token, finding, currentHeadIsExpected);
    if (created) {
      await resolveObsoleteFindingThreads(created.id, matching, reviewThreads, token, currentHeadIsExpected);
      return created;
    }
    if (!await currentHeadIsExpected()) return null;
    const fallback = matching.find((comment) => reviewThreads.some((thread) => thread.commentIds.includes(comment.id) && !thread.isResolved)) ?? matching[0];
    const updated = await githubFetch(`/repos/${owner}/${repo}/pulls/comments/${fallback.id}`, token, { method: "PATCH", body: JSON.stringify({ body: finding.body }) });
    const fallbackThread = reviewThreads.find((candidate) => candidate.commentIds.includes(fallback.id));
    if (fallbackThread?.isResolved) {
      if (!await currentHeadIsExpected()) return updated;
      await unresolvePullRequestReviewThread(fallbackThread.id, token);
    }
    await resolveObsoleteFindingThreads(fallback.id, matching, reviewThreads, token, currentHeadIsExpected);
    return updated;
  }
  return createFindingReviewComment(owner, repo, pullNumber, headSha, token, finding, currentHeadIsExpected);
}

export async function syncFindingReviewComments(
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  token: string,
  findings: Array<{ findingId: string; body: string; path: string; line?: number }>,
  options: { botLogin?: string; getCurrentHead?: () => Promise<string>; deadlineAt?: number } = {},
) {
  const pastDeadline = () => options.deadlineAt !== undefined && Date.now() > options.deadlineAt;
  const getCurrentHead = options.getCurrentHead ?? (async () => (await getPullRequest(owner, repo, pullNumber, token)).head.sha);
  const currentHeadIsExpected = async () => await getCurrentHead() === headSha;
  if (!await currentHeadIsExpected()) return;
  const existing = await listPullRequestReviewComments(owner, repo, pullNumber, token);
  const hasMarkerCandidate = existing.some((comment) => findingIdFromComment(comment.body));
  const botLogin = options.botLogin ?? (hasMarkerCandidate ? `${(await getGitHubApp()).slug}[bot]` : "");
  const ownedMarkedComments = botLogin
    ? existing.flatMap((comment) => {
        const findingId = findingIdFromComment(comment.body);
        return findingId && ownedReviewComment(comment, botLogin) ? [{ comment, findingId }] : [];
      })
    : [];
  const reviewThreads = ownedMarkedComments.length ? await listPullRequestReviewThreads(owner, repo, pullNumber, token) : [];
  if (!await currentHeadIsExpected()) return;
  const currentFindingIds = new Set(findings.map((finding) => finding.findingId));
  for (const { comment, findingId } of ownedMarkedComments) {
    if (currentFindingIds.has(findingId)) continue;
    const thread = reviewThreads.find((candidate) => candidate.commentIds.includes(comment.id));
    if (thread && !thread.isResolved) {
      if (!await currentHeadIsExpected()) return;
      await resolvePullRequestReviewThread(thread.id, token);
    }
  }
  for (const finding of findings) {
    if (pastDeadline()) {
      console.warn(`Finding comment sync for ${owner}/${repo}#${pullNumber} stopped at the publish deadline; remaining findings stay in the review summary comment.`);
      return;
    }
    if (!await currentHeadIsExpected()) return;
    await upsertFindingReviewComment(owner, repo, pullNumber, headSha, token, finding, existing, reviewThreads, botLogin, currentHeadIsExpected);
  }
}

export async function repositoryPermission(owner: string, repo: string, username: string, token: string) {
  const result = await githubFetch<{ permission: "admin" | "maintain" | "write" | "triage" | "read" | "none" }>(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`, token);
  return result.permission;
}
