import { createInstallationToken, finishCheckRun, getOrCreateCheckRun, getPullRequestDiff, syncFindingReviewComments, upsertPullRequestComment } from "./github";
import { announceDashboardChange } from "./dashboard-change-service";
import { isRetryableHttpStatus, NonRetryableReviewError, ReviewLeaseLostError } from "./review-errors";
import { runInSandbox } from "./sandbox";
import { getRepositoryReviewContext } from "./repository-context-service";
import type { ReviewLease } from "./review-queue";
import type { ReviewFinding, ReviewRequest, ReviewResult, SandboxResult } from "./types";
import { findingIdentity } from "./review-event-ledger";
import { formatFindingComment } from "./finding-comment";

const systemPrompt = `You are Ternary, a senior code review agent. Review only material problems introduced by this pull request. Prioritize correctness, security, concurrency, data loss, and missing tests. Do not report style preferences. Return strict JSON with: verdict (approve|request_changes|comment), summary, and findings. Each finding has a ruleId for its stable review-rule family (for example security-authorization or correctness-concurrency), plus a unique findingKey that combines that rule with the affected symbol and remains stable when line numbers or wording change. Set supersedesFindingKey only when this finding explicitly replaces a semantically equivalent finding key from an earlier review; otherwise set it to null. Each finding also has severity (blocking|warning|suggestion), file, optional line, title, explanation, and optional suggestedFix.`;

function fallbackReview(sandbox: SandboxResult): ReviewResult {
  return {
    verdict: sandbox.ok ? "comment" : "request_changes",
    summary: sandbox.ok ? "Sandbox checks passed. AI review is disabled until OPENAI_API_KEY is configured." : "One or more sandbox checks failed.",
    findings: sandbox.ok ? [] : [{ findingKey: "sandbox-checks-failed", severity: "blocking", file: "", title: "Sandbox checks failed", explanation: "Inspect the sandbox command output before merging." }],
    sandbox,
    authoritativeFindings: false,
  };
}

async function generateReview(diff: string, sandbox: SandboxResult, repositoryContext: string): Promise<ReviewResult> {
  if (!process.env.OPENAI_API_KEY) return fallbackReview(sandbox);
  const maxDiffChars = Number(process.env.MAX_DIFF_CHARS ?? 160_000);
  const input = `PR DIFF:\n${diff.slice(0, maxDiffChars)}\n\nREPOSITORY CONTEXT:\n${repositoryContext || "No matching repository context was available."}\n\nSANDBOX RESULT:\n${JSON.stringify(sandbox)}`;
  const model = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
  const startedAt = Date.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input,
      text: { format: { type: "json_schema", name: "code_review", strict: true, schema: reviewSchema } },
    }),
  });
  if (!response.ok) {
    const message = `AI review failed (${response.status}): ${await response.text()}`;
    const retryable = isRetryableHttpStatus(response.status);
    throw retryable ? new Error(message) : new NonRetryableReviewError(message);
  }
  const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
  if (!text) throw new NonRetryableReviewError("AI response did not include review output");
  try {
    const review = JSON.parse(text) as Omit<ReviewResult, "sandbox">;
    const findingKeys = review.findings.map((finding) => finding.findingKey?.toLowerCase() ?? null);
    const ruleIds = review.findings.map((finding) => finding.ruleId?.toLowerCase() ?? null);
    if (findingKeys.some((key) => !key) || new Set(findingKeys).size !== findingKeys.length || ruleIds.some((ruleId) => !ruleId)) {
      throw new NonRetryableReviewError("AI response included missing rule IDs or missing/duplicate finding keys");
    }
    const inputTokens = payload.usage?.input_tokens;
    const outputTokens = payload.usage?.output_tokens;
    const inputRate = process.env.OPENAI_INPUT_COST_PER_MILLION ? Number(process.env.OPENAI_INPUT_COST_PER_MILLION) : undefined;
    const outputRate = process.env.OPENAI_OUTPUT_COST_PER_MILLION ? Number(process.env.OPENAI_OUTPUT_COST_PER_MILLION) : undefined;
    const estimatedCostUsd = inputTokens !== undefined && outputTokens !== undefined && inputRate !== undefined && outputRate !== undefined && Number.isFinite(inputRate) && Number.isFinite(outputRate)
      ? (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
      : undefined;
    return {
      ...review,
      sandbox,
      authoritativeFindings: true,
      ai: { model, latencyMs: Date.now() - startedAt, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}) },
    };
  } catch (error) {
    if (error instanceof NonRetryableReviewError) throw error;
    throw new NonRetryableReviewError("AI response was not valid review JSON", { cause: error });
  }
}

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["ruleId", "findingKey", "supersedesFindingKey", "severity", "file", "line", "title", "explanation", "suggestedFix"],
        properties: {
          ruleId: { type: "string" },
          findingKey: { type: "string" },
          supersedesFindingKey: { type: ["string", "null"] },
          severity: { type: "string", enum: ["blocking", "warning", "suggestion"] },
          file: { type: "string" }, line: { type: ["number", "null"] }, title: { type: "string" },
          explanation: { type: "string" }, suggestedFix: { type: ["string", "null"] },
        },
      },
    },
  },
};

function formatReview(result: ReviewResult) {
  const icon = result.verdict === "approve" ? "✅" : result.verdict === "request_changes" ? "⛔" : "💬";
  const sandboxLines = result.sandbox.commands.map((command) => `- ${command.exitCode === 0 ? "✅" : "❌"} \`${command.command}\``).join("\n");
  const findingLines = result.findings.length ? result.findings.map((finding, index) => {
    const location = finding.file ? ` — \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
    const fix = finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : "";
    return `### ${index + 1}. ${finding.title}${location}\n\n**${finding.severity}** · ${finding.explanation}${fix}`;
  }).join("\n\n") : "No material findings.";
  return `## ${icon} Ternary review\n\n${result.summary}\n\n${findingLines}\n\n<details><summary>Sandbox checks</summary>\n\n${sandboxLines}\n\nSandbox: \`${result.sandbox.sandboxId}\` · ${Math.round(result.sandbox.durationMs / 1000)}s\n</details>\n\n---\n<sub>Generated by your internal Ternary review agent.</sub>`;
}

export async function runReview(request: ReviewRequest & { id?: string }, lease?: ReviewLease) {
  const token = await createInstallationToken(request.installationId);
  await lease?.assertActive();
  const check = await getOrCreateCheckRun(request.owner, request.repo, request.headSha, token, request.id);
  await announceDashboardChange();
  try {
    const [diff, sandbox] = await Promise.all([
      getPullRequestDiff(request.owner, request.repo, request.pullNumber, token),
      runInSandbox(request, token),
    ]);
    const repositoryContext = await getRepositoryReviewContext(request, token, diff);
    const result = await generateReview(diff, sandbox, repositoryContext.text);
    const marker = request.id ? `\n\n<!-- ternary-review-job:${request.id} -->` : "";
    const markdown = `${formatReview(result)}${marker}`;
    await lease?.assertActive();
    await upsertPullRequestComment(request.owner, request.repo, request.pullNumber, token, markdown, request.id);
    await lease?.assertActive();
    if (result.authoritativeFindings !== false) {
      await syncFindingReviewComments(request.owner, request.repo, request.pullNumber, request.headSha, token, result.findings.filter((finding) => finding.file).map((finding) => {
        const findingId = findingIdentity(request, finding);
        return { findingId, body: formatFindingComment(finding, findingId), path: finding.file, line: finding.line };
      }));
    }
    await lease?.assertActive();
    await finishCheckRun(request.owner, request.repo, check.id, token, result.verdict === "approve" ? "success" : result.verdict === "request_changes" ? "failure" : "neutral", "Review complete", markdown, JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof ReviewLeaseLostError) throw error;
    const message = error instanceof Error ? error.message : "Unknown review failure";
    await lease?.assertActive();
    await finishCheckRun(request.owner, request.repo, check.id, token, "failure", "Review failed", message);
    throw error;
  } finally {
    await announceDashboardChange();
  }
}

export function countBlockingFindings(findings: ReviewFinding[]) {
  return findings.filter((finding) => finding.severity === "blocking").length;
}
