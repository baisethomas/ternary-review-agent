/**
 * Workspace Review analysis wrapper (docs/workspace-review-spec.md §3, §6).
 *
 * A narrow, source-agnostic seam around the model call: it needs no GitHub
 * API, no publisher, no queue, and no persistence. Per the Hobby-plan fixed
 * decision it performs exactly ONE model attempt — the PR pipeline's
 * DeepSeek→OpenAI cascade in `review-route-service.ts` stays PR-queue-only —
 * with a deterministic deadline that aborts the in-flight request.
 */

import { MIN_OPENROUTER_TIMEOUT_MS } from "./openrouter-review-provider";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";
import { reviewSeverities } from "./review-policy";
import { redactSecrets } from "./secret-redaction";
import {
  buildWorkspaceReviewInput,
  getWorkspaceSystemPrompt,
  parseWorkspaceReviewOutput,
  WORKSPACE_MAX_FINDINGS,
  workspaceReviewSchema,
} from "./workspace-review-prompts";
import {
  assertCheckEvidenceInvariants,
  workspaceVerdict,
  type CheckEvidence,
  type CommandEvidence,
  type WorkspaceAnalysisInput,
  type WorkspaceChangeSet,
  type WorkspaceFinding,
  type WorkspaceReviewResult,
} from "./workspace-review-types";

/** Server-owned output-token budget (spec §4.4); the client can never raise it. */
export const WORKSPACE_MAX_OUTPUT_TOKENS = 4_096;

export class WorkspaceReviewTimeoutError extends NonRetryableReviewError {
  constructor(timeoutMs: number) {
    super(`Workspace review timed out after ${timeoutMs}ms`);
    this.name = "WorkspaceReviewTimeoutError";
  }
}

/**
 * Fail-closed rejection of sandbox-origin evidence (spec §3.2: "In the alpha,
 * all Workspace Review evidence is `origin: local` or absent; the sandbox
 * pipeline is not invoked for Workspace Reviews"). The wrapper refuses this
 * evidence outright rather than downgrading it to local — the
 * `checkEvidenceFromSandboxResult` adapter stays available for the future
 * GitHub-path convergence, but the alpha wrapper never accepts its output.
 */
export class WorkspaceSandboxEvidenceRejectedError extends NonRetryableReviewError {
  constructor(label: string) {
    super(
      `Workspace review evidence "${label}" has origin "sandbox"; the alpha only accepts local (client-reported) evidence (docs/workspace-review-spec.md §3.2)`,
    );
    this.name = "WorkspaceSandboxEvidenceRejectedError";
  }
}

export type WorkspaceModelResponse = {
  text: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number };
};

export type WorkspaceModelRequestArgs = {
  model: string;
  systemPrompt: string;
  input: string;
  schema: unknown;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type WorkspaceModelRequest = (request: WorkspaceModelRequestArgs) => Promise<WorkspaceModelResponse>;

export type WorkspaceAnalysisDeps = {
  requestModel?: WorkspaceModelRequest;
  now?: () => number;
};

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Field-map exhaustiveness checks (one per type below): each literal must
 * satisfy `Record<keyof T, true>`, listing every field on the type. If
 * `CheckEvidence`, `CommandEvidence`, or `WorkspaceChangeSet` gains or loses
 * a field, the corresponding literal stops satisfying its `Record` type and
 * the build fails right here — forcing a conscious decision about whether
 * the new field carries user-controlled text that needs redaction, instead
 * of it silently reaching the prompt unredacted. This is what makes the
 * redaction below exhaustive-by-construction rather than field-by-field
 * patching: every field is accounted for, even the ones that are
 * deliberately left unredacted (enums, counts, hashes, already-normalized
 * paths).
 */
const CHECK_EVIDENCE_FIELDS = {
  origin: true, // enum, not user-controlled text
  trust: true, // enum, not user-controlled text
  status: true, // enum, not user-controlled text
  label: true, // user-controlled text — redacted
  commands: true, // CommandEvidence[] — redacted via redactCommandEvidence
  truncation: true, // { skippedCommands: string[] } — command names, redacted
  redaction: true, // { redactedSpans: number } — count only, not text
  unavailableReason: true, // user-controlled text — redacted
} satisfies Record<keyof CheckEvidence, true>;
void CHECK_EVIDENCE_FIELDS;

const COMMAND_EVIDENCE_FIELDS = {
  command: true, // user-controlled text — redacted
  exitCode: true, // number, not text
  output: true, // user-controlled text — redacted
} satisfies Record<keyof CommandEvidence, true>;
void COMMAND_EVIDENCE_FIELDS;

const WORKSPACE_CHANGE_SET_FIELDS = {
  kind: true, // enum, not user-controlled text
  workspaceLabel: true, // user-controlled text — redacted
  vcs: true, // enum, not user-controlled text
  baseState: true, // git SHA / literal "unborn" — not free text
  branch: true, // user-controlled text — redacted
  changeset: true, // ChangesetEntry[] — patch/content redacted; path/from already normalized (spec §8.3)
  snapshot: true, // SnapshotEntry[] — content redacted; path already normalized (spec §8.3)
} satisfies Record<keyof WorkspaceChangeSet, true>;
void WORKSPACE_CHANGE_SET_FIELDS;

function redactCommandEvidence(command: CommandEvidence, redact: (value: string) => string): CommandEvidence {
  return { ...command, command: redact(command.command), output: redact(command.output) };
}

/** Redact every user-controlled string field on one evidence entry, per `CHECK_EVIDENCE_FIELDS` above. */
function redactCheckEvidence(check: CheckEvidence, redact: (value: string) => string): CheckEvidence {
  return {
    ...check,
    label: redact(check.label),
    commands: check.commands.map((command) => redactCommandEvidence(command, redact)),
    ...(check.truncation
      ? { truncation: { skippedCommands: check.truncation.skippedCommands.map(redact) } }
      : {}),
    ...(check.unavailableReason !== undefined ? { unavailableReason: redact(check.unavailableReason) } : {}),
  };
}

/**
 * Defense-in-depth redaction (spec §4.3): apply `redactSecrets` to every
 * user-controlled text field embedded into the prompt, exactly once, before
 * prompt construction. This is a second net only — the collector is the
 * primary control (spec §1.3) — so this never fails the review; it only
 * rewrites text and reports how many fields it actually changed.
 */
function redactWorkspaceAnalysisInput(
  input: WorkspaceAnalysisInput,
): { input: WorkspaceAnalysisInput; redactionApplied: number } {
  let redactionApplied = 0;
  const redact = (value: string): string => {
    const redacted = redactSecrets(value);
    if (redacted !== value) redactionApplied += 1;
    return redacted;
  };

  const changeSet: WorkspaceChangeSet = {
    ...input.changeSet,
    workspaceLabel: redact(input.changeSet.workspaceLabel),
    ...(input.changeSet.branch !== undefined ? { branch: redact(input.changeSet.branch) } : {}),
    ...(input.changeSet.changeset
      ? {
          changeset: input.changeSet.changeset.map((entry) => ({
            ...entry,
            ...(entry.patch !== undefined ? { patch: redact(entry.patch) } : {}),
            ...(entry.content !== undefined ? { content: redact(entry.content) } : {}),
          })),
        }
      : {}),
    ...(input.changeSet.snapshot
      ? { snapshot: input.changeSet.snapshot.map((entry) => ({ ...entry, content: redact(entry.content) })) }
      : {}),
  };

  const evidence = input.evidence.map((check) => redactCheckEvidence(check, redact));

  return {
    input: { ...input, changeSet, repositoryContext: redact(input.repositoryContext), evidence },
    redactionApplied,
  };
}

/**
 * Normalize a finding's `file` per the Phase-4 finding-hygiene rules: relative,
 * `/`-separated, no `.`/`..` segments. Returns null for absolute paths (POSIX
 * or Windows-drive form), traversal, or an empty/whitespace-only path.
 */
function normalizeFindingPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) return null;
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

/** Every path a finding may legitimately cite: the submitted changeset/snapshot entries (plus rename sources). */
function buildAllowedFindingPaths(changeSet: WorkspaceChangeSet): Set<string> {
  const paths = new Set<string>();
  for (const entry of changeSet.changeset ?? []) {
    const normalized = normalizeFindingPath(entry.path);
    if (normalized) paths.add(normalized);
    if (entry.from) {
      const from = normalizeFindingPath(entry.from);
      if (from) paths.add(from);
    }
  }
  for (const entry of changeSet.snapshot ?? []) {
    const normalized = normalizeFindingPath(entry.path);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

/**
 * Finding-path boundary (Phase-4 finding hygiene): normalize each finding's
 * path, reject absolute/traversal paths, and drop (never silently pass
 * through) any finding whose path does not appear in the submitted
 * changeset/snapshot material. A finding with an empty/missing path has no
 * other legitimate meaning under the prompt contract (which instructs the
 * model to omit findings it cannot place in a provided path) and is dropped
 * under the same unknown-path count.
 */
function filterFindingsByPath(
  findings: WorkspaceFinding[],
  allowedPaths: Set<string>,
): { findings: WorkspaceFinding[]; unknownPath: number } {
  let unknownPath = 0;
  const kept: WorkspaceFinding[] = [];
  for (const finding of findings) {
    const normalized = normalizeFindingPath(finding.file);
    if (normalized === null || !allowedPaths.has(normalized)) {
      unknownPath += 1;
      continue;
    }
    kept.push(normalized === finding.file ? finding : { ...finding, file: normalized });
  }
  return { findings: kept, unknownPath };
}

/** Default OpenRouter transport: one request, strict schema, no fallback chain. */
export const requestOpenRouterWorkspaceModel: WorkspaceModelRequest = async (request) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new NonRetryableReviewError("Workspace review requires OPENROUTER_API_KEY");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_schema", json_schema: { name: "workspace_review", strict: true, schema: request.schema } },
      provider: { require_parameters: true },
    }),
    signal: request.signal,
  });
  try {
    if (!response.ok) {
      const message = `Workspace review model call failed (${response.status}): ${await response.text()}`;
      throw isRetryableHttpStatus(response.status) ? new Error(message) : new NonRetryableReviewError(message);
    }
    const payload = await response.json() as {
      model?: string;
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string | null }; error?: { message?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const choice = payload.choices?.[0];
    const providerError = choice?.error ?? payload.error;
    if (providerError) throw new NonRetryableReviewError(`Workspace review model call failed: ${providerError.message ?? "generation ended with an error"}`);
    const text = choice?.message?.content;
    if (!text) throw new NonRetryableReviewError("Workspace review model response did not include output");
    return {
      text,
      ...(payload.model ? { model: payload.model } : {}),
      usage: {
        ...(payload.usage?.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {}),
        ...(payload.usage?.completion_tokens !== undefined ? { outputTokens: payload.usage.completion_tokens } : {}),
        ...(payload.usage?.cost !== undefined ? { estimatedCostUsd: payload.usage.cost } : {}),
      },
    };
  } catch (error) {
    // On the deadline-abort path (and any other failure before the body is fully
    // read) the response body can still be pending. Cancel it so the underlying
    // connection is released instead of leaking; never let cleanup mask the real
    // error (e.g. the timeout) that's about to propagate.
    try {
      await response.body?.cancel();
    } catch {
      // ignore: body cleanup is best-effort
    }
    throw error;
  }
};

/**
 * Run one advisory Workspace Review: build the versioned prompt for the review
 * kind, make a single deadline-bounded model attempt, validate the structured
 * output, apply the policy threshold and finding cap, and derive the verdict.
 */
export async function analyzeWorkspaceReview(
  input: WorkspaceAnalysisInput,
  deps: WorkspaceAnalysisDeps = {},
): Promise<WorkspaceReviewResult> {
  if (input.reviewKind !== input.changeSet.kind) {
    throw new NonRetryableReviewError(`Workspace review kind "${input.reviewKind}" does not match the captured change set kind "${input.changeSet.kind}"`);
  }
  for (const evidence of input.evidence) {
    assertCheckEvidenceInvariants(evidence);
    // Alpha contract (spec §3.2): all Workspace Review evidence is local or
    // absent; reject sandbox-origin evidence outright rather than presenting
    // it downgraded.
    if (evidence.origin === "sandbox") throw new WorkspaceSandboxEvidenceRejectedError(evidence.label);
  }

  const requestModel = deps.requestModel ?? requestOpenRouterWorkspaceModel;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = Math.floor(input.deadlineAt - startedAt);
  if (timeoutMs < MIN_OPENROUTER_TIMEOUT_MS) throw new WorkspaceReviewTimeoutError(Math.max(0, timeoutMs));

  const { input: redactedInput, redactionApplied } = redactWorkspaceAnalysisInput(input);
  const systemPrompt = getWorkspaceSystemPrompt(input.reviewKind);
  const modelInput = buildWorkspaceReviewInput(redactedInput);
  const controller = new AbortController();
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout>;
  // Racing a deadline promise (not just aborting the signal) means the deadline
  // is enforced deterministically even if a provider ignores the abort signal
  // and never settles its own promise.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
      reject(new WorkspaceReviewTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  let response: WorkspaceModelResponse;
  try {
    response = await Promise.race([
      requestModel({
        model: input.policy.model,
        systemPrompt,
        input: modelInput,
        schema: workspaceReviewSchema,
        maxOutputTokens: WORKSPACE_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof WorkspaceReviewTimeoutError) throw error;
    if (isAbortError(error) || deadlineReached || controller.signal.aborted) throw new WorkspaceReviewTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer!);
  }

  let review: ReturnType<typeof parseWorkspaceReviewOutput>;
  try {
    review = parseWorkspaceReviewOutput(response.text);
  } catch (error) {
    // Single attempt by design: a malformed response fails the review instead of cascading.
    const detail = error instanceof Error ? error.message : String(error);
    throw new NonRetryableReviewError(`Workspace review response was not valid review JSON: ${detail}`, error instanceof Error ? { cause: error } : undefined);
  }

  // Finding-path boundary (Phase-4 finding hygiene): drop, count, never
  // silently pass through, any finding citing a path outside the submitted material.
  const { findings: pathValidFindings, unknownPath } = filterFindingsByPath(
    review.findings,
    buildAllowedFindingPaths(input.changeSet),
  );

  const minimum = reviewSeverities.indexOf(input.policy.minimumSeverity);
  const maxFindings = input.policy.maxFindings ?? WORKSPACE_MAX_FINDINGS;
  const findings = pathValidFindings
    .filter((finding) => reviewSeverities.indexOf(finding.severity) >= minimum)
    .slice(0, maxFindings);
  const hiddenCount = pathValidFindings.length - findings.length;

  return {
    verdict: workspaceVerdict(findings),
    summary: hiddenCount
      ? `${review.summary}\n\nPolicy omitted ${hiddenCount} finding${hiddenCount === 1 ? "" : "s"} based on the ${input.policy.minimumSeverity} severity threshold and the ${maxFindings}-finding report cap.`
      : review.summary,
    findings,
    evidence: input.evidence,
    redactionApplied,
    droppedFindings: { unknownPath },
    ai: {
      model: response.model ?? input.policy.model,
      latencyMs: now() - startedAt,
      ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
      ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
      ...(response.usage?.estimatedCostUsd !== undefined ? { estimatedCostUsd: response.usage.estimatedCostUsd } : {}),
    },
  };
}
