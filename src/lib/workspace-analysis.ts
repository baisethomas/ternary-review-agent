/**
 * Workspace Review analysis wrapper (docs/workspace-review-spec.md §3, §6).
 *
 * A narrow, source-agnostic seam around the model call: it needs no GitHub
 * API, no publisher, no queue, and no persistence.
 *
 * ADR-0002 option C (TER-44 step 1) makes a single attempt survivable: a
 * bounded reasoning budget, deterministic provider routing, and a streamed
 * response whose silence is detected inside a stall window instead of at the
 * end-to-end deadline.
 *
 * ADR-0002 option B (TER-44 step 2, this module's retry loop) adds **at most
 * two** attempts against the **same model** — the PR pipeline's
 * DeepSeek→OpenAI cascade in `review-route-service.ts` stays PR-queue-only, and
 * nothing here ever changes the model. The second attempt runs only when the
 * first failed in a way that a different provider could plausibly survive AND a
 * full attempt budget still fits before the end-to-end deadline; it is routed
 * away from the provider that failed via OpenRouter `provider.ignore`. The
 * end-to-end deadline race stays authoritative and aborts whichever attempt is
 * in flight.
 */

import { MIN_OPENROUTER_TIMEOUT_MS } from "./openrouter-review-provider";
import {
  WORKSPACE_REVIEW_ASSEMBLY_RESERVE_MS,
  WORKSPACE_REVIEW_ATTEMPT_BUDGET_MS,
  WORKSPACE_REVIEW_MAX_ATTEMPTS,
} from "./review-invocation-limits";
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

/**
 * Stall abort (ADR-0002 option C): a streamed generation that stops producing
 * bytes is dead, not slow. Failing it inside the stall window instead of at the
 * end-to-end deadline is the whole point — it is a *distinct* error so the
 * measurement can tell "provider went quiet" apart from "review took too long".
 */
export class WorkspaceModelStallError extends NonRetryableReviewError {
  readonly stallMs: number;
  constructor(stallMs: number) {
    super(`Workspace review model stream stalled: no bytes received for ${stallMs}ms`);
    this.name = "WorkspaceModelStallError";
    this.stallMs = stallMs;
  }
}

/**
 * The connection died; the deadline did not expire.
 *
 * Phase B could not tell these apart: the wrapper relabelled *any* abort
 * reaching its catch as `WorkspaceReviewTimeoutError`, so an upstream reset, a
 * dropped socket, or a provider hanging up mid-generation all counted as
 * "review took too long" — 24 of 45 submissions landed in that bucket with no
 * way to say how many were actually slow. Only the deadline race may produce
 * the timeout error now; every other abort surfaces here.
 */
export class WorkspaceModelConnectionError extends NonRetryableReviewError {
  constructor(detail: string) {
    super(`Workspace review model connection ended before the deadline: ${detail}`);
    this.name = "WorkspaceModelConnectionError";
  }
}

/**
 * One attempt ran past its own slice of the end-to-end deadline (ADR-0002
 * option B: 5 + 2×80 + 15 = 180 s). Distinct from `WorkspaceReviewTimeoutError`
 * on purpose — the review as a whole still has time left, which is precisely
 * why this failure is retryable and the deadline one is not.
 */
export class WorkspaceModelAttemptTimeoutError extends NonRetryableReviewError {
  readonly attemptBudgetMs: number;
  constructor(attemptBudgetMs: number) {
    super(`Workspace review model attempt exceeded its ${attemptBudgetMs}ms budget`);
    this.name = "WorkspaceModelAttemptTimeoutError";
    this.attemptBudgetMs = attemptBudgetMs;
  }
}

/**
 * The provider reported a generation error — an SSE frame carrying a top-level
 * `error` / `finish_reason: "error"` while the HTTP status stayed 200, or the
 * same shape in a buffered response. Phase B's only `model_failure` cluster was
 * a single provider returning 500s (dogfood report §8.6–§8.7), which is exactly
 * the case a second attempt on a *different* provider can survive.
 */
export class WorkspaceModelProviderError extends NonRetryableReviewError {
  constructor(detail: string) {
    super(`Workspace review model call failed: ${detail}`);
    this.name = "WorkspaceModelProviderError";
  }
}

/**
 * The model answered, but the answer was not a schema-valid review.
 *
 * Treated as **retryable** (ADR-0002 step 2 decision): Phase B saw
 * non-repeatable output from byte-identical payloads, so a malformed answer is
 * evidence about *this generation*, not about the request. The cost is bounded
 * by the same two-attempt / budget rules as every other retry, and a second
 * malformed answer still fails the review deterministically.
 */
export class WorkspaceReviewOutputInvalidError extends NonRetryableReviewError {
  constructor(detail: string, cause?: unknown) {
    super(
      `Workspace review response was not valid review JSON: ${detail}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "WorkspaceReviewOutputInvalidError";
  }
}

/**
 * Build the error for a non-OK OpenRouter HTTP response, carrying the status so
 * the retry policy can read it back. Retryable statuses (5xx, 429, …) stay a
 * plain `Error` and non-retryable ones (401/400/413) stay a
 * `NonRetryableReviewError`, exactly as before — the status is additive.
 */
export function workspaceModelHttpError(status: number, detail: string): Error {
  const message = `Workspace review model call failed (${status}): ${detail}`;
  const error = isRetryableHttpStatus(status) ? new Error(message) : new NonRetryableReviewError(message);
  return Object.assign(error, { status });
}

function workspaceModelHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Provider identity carried on a *failed* attempt.
 *
 * On success the served provider is on the response; on a stream failure it is
 * only ever seen in the chunks already consumed (OpenRouter puts `provider` on
 * every chunk), so the transport pins it to the error and the retry reads it
 * back to build `provider.ignore`. A symbol keeps it off the wire and out of
 * any `JSON.stringify` of the error.
 */
const WORKSPACE_ERROR_PROVIDER = Symbol.for("ternary.workspaceReview.errorProvider");
const WORKSPACE_ERROR_ATTEMPTS = Symbol.for("ternary.workspaceReview.errorAttempts");

export function attachWorkspaceProvider<E>(error: E, provider: string | undefined): E {
  if (!provider || typeof error !== "object" || error === null) return error;
  Object.defineProperty(error, WORKSPACE_ERROR_PROVIDER, { value: provider, configurable: true });
  return error;
}

export function workspaceProviderFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<symbol, unknown>)[WORKSPACE_ERROR_PROVIDER];
  return typeof value === "string" ? value : undefined;
}

/** Metadata-only attempt record (ADR-0002 observability): never prompt text, never payload bytes. */
export type WorkspaceAttemptMetadata = {
  /** 1 or 2 — how many model requests this review actually sent. */
  attempts: number;
  /** Why attempt 1 was retry-eligible (its error class or HTTP status); absent when it was not. */
  retryReason?: string;
  /** Set when attempt 1 was retry-eligible but the retry did not fit before the deadline. */
  retrySkipped?: "insufficient_budget";
  attempt1Provider?: string;
  attempt2Provider?: string;
};

export function attachWorkspaceAttemptMetadata<E>(error: E, metadata: WorkspaceAttemptMetadata): E {
  if (typeof error !== "object" || error === null) return error;
  Object.defineProperty(error, WORKSPACE_ERROR_ATTEMPTS, { value: metadata, configurable: true });
  return error;
}

/** Read the attempt record off a failed review, for the route's metadata-only log line. */
export function workspaceAttemptMetadataFromError(error: unknown): WorkspaceAttemptMetadata | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<symbol, unknown>)[WORKSPACE_ERROR_ATTEMPTS];
  return typeof value === "object" && value !== null ? (value as WorkspaceAttemptMetadata) : undefined;
}

/**
 * The retry policy, in one place: return a short reason when a second attempt
 * against the same model on a different provider could plausibly succeed, or
 * `undefined` when it could not.
 *
 * Retryable — all delivery failures, not judgement failures: a stall, a dead
 * connection, a truncated stream, a malformed SSE frame, an attempt that blew
 * its own budget, a provider error frame, a retryable HTTP status (5xx/429/408/
 * 409/425), and a schema-invalid answer (see `WorkspaceReviewOutputInvalidError`).
 *
 * Never retryable: the end-to-end deadline (there is no time left by
 * definition), a non-retryable HTTP status (401/400/413 — a second identical
 * request gets the same answer and burns money), and an invalid tuning env
 * (deterministic misconfiguration, never reaches the wire).
 */
export function workspaceRetryReason(error: unknown): string | undefined {
  if (error instanceof WorkspaceReviewTimeoutError) return undefined;
  if (error instanceof WorkspaceModelTuningConfigError) return undefined;
  if (error instanceof WorkspaceModelStallError) return "stall";
  if (error instanceof WorkspaceModelAttemptTimeoutError) return "attempt_timeout";
  if (error instanceof WorkspaceModelConnectionError) return "connection";
  if (error instanceof WorkspaceModelTruncatedStreamError) return "truncated_stream";
  if (error instanceof WorkspaceModelMalformedFrameError) return "malformed_frame";
  if (error instanceof WorkspaceModelProviderError) return "provider_error";
  if (error instanceof WorkspaceReviewOutputInvalidError) return "schema_invalid";
  const status = workspaceModelHttpStatus(error);
  if (status !== undefined && isRetryableHttpStatus(status)) return `http_${status}`;
  return undefined;
}

/**
 * OpenRouter reasoning-effort bound. Enum verified against OpenRouter's
 * chat-completion schema (`reasoning.effort`: max | xhigh | high | medium |
 * low | minimal | none). NOTE: the `deepseek/deepseek-v4-flash` model page
 * documents only `high` and `xhigh` as natively supported, and OpenRouter maps
 * unsupported efforts to the nearest supported behaviour — so a "low" bound may
 * be a no-op on that model. That is exactly what the TER-44 spike measures.
 */
export type WorkspaceReasoningEffort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

/**
 * The enum above, verified 2026-08-26 against
 * https://openrouter.ai/docs/use-cases/reasoning-tokens — "Can be \"max\",
 * \"xhigh\", \"high\", \"medium\", \"low\", \"minimal\" or \"none\"
 * (OpenAI-style)". (https://openrouter.ai/docs/api-reference/parameters lists
 * the same set minus `max`; the reasoning-tokens page is the fuller one, so the
 * union is what we accept.) Kept as a runtime array so the env parser and the
 * type cannot drift apart.
 */
export const WORKSPACE_REASONING_EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const;

/**
 * `"omit"` is Ternary's own value, not OpenRouter's: it means *send no
 * `reasoning` object at all*. It is required for non-reasoning models — with
 * `provider.require_parameters: true` a `reasoning` parameter excludes every
 * provider of a model that does not support the parameter, so a model like
 * `mistralai/mistral-small-3.2-24b-instruct` would be unroutable rather than
 * merely unbounded.
 */
export type WorkspaceReasoningSetting = WorkspaceReasoningEffort | "omit";

/**
 * OpenRouter `provider.sort` values, verified 2026-08-26 against
 * https://openrouter.ai/docs/features/provider-routing — `"price"`,
 * `"throughput"`, `"latency"`. Sorting disables load balancing, so on a small
 * provider pool it can concentrate traffic on one struggling provider; `"omit"`
 * (Ternary's own value) drops `sort` from the body and restores OpenRouter's
 * default load-balanced routing.
 */
export type WorkspaceProviderSort = "latency" | "throughput" | "price";

export const WORKSPACE_PROVIDER_SORTS = ["latency", "throughput", "price"] as const;

export type WorkspaceProviderSortSetting = WorkspaceProviderSort | "omit";

/**
 * Survivability knobs for the single model attempt (ADR-0002 option C).
 * Deliberately an option object rather than literals in the fetch body: the
 * spike has to be able to move each knob and re-measure without a code change
 * to the transport.
 */
export type WorkspaceModelTuning = {
  /**
   * Bounded reasoning budget: sent as `reasoning: { effort }`, or, for
   * `"omit"`, not sent at all (see `WorkspaceReasoningSetting`).
   */
  reasoningEffort: WorkspaceReasoningSetting;
  /**
   * Deterministic provider routing: sent as `provider.sort` on BOTH the
   * streamed and non-streamed paths. The non-streamed path exists as the
   * comparison baseline for *streaming and stall detection*, not for routing —
   * routing determinism is wanted either way. `"omit"` drops `sort` entirely.
   */
  providerSort: WorkspaceProviderSortSetting;
  /** Ask for an SSE stream so a stalled generation is detectable. */
  stream: boolean;
  /**
   * Fail the attempt when **no SSE data frame** arrives for this long.
   *
   * The window measures time since the last `data:` frame — a content or
   * reasoning delta, the usage chunk, or `[DONE]`. It does NOT measure time
   * since the last byte: SSE comment/keepalive lines
   * (`: OPENROUTER PROCESSING`) and blank separator lines prove only that the
   * socket is warm, never that the model is generating, and so never reset it.
   * When streaming, the window also covers the request/headers phase.
   */
  stallTimeoutMs: number;
};

/**
 * Default reasoning effort is `"none"`, not `"low"` (changed 2026-08-26,
 * D-20260826-0500-workspace-review-reasoning-none). §8.6.2 measured `"low"`
 * as a no-op on the incumbent `deepseek/deepseek-v4-flash` — the model
 * silently ignored the bound and kept reasoning at 884–2,600 tokens per
 * call. TER-44 step 1b Experiment A (dogfood report §8.7) then measured
 * `effort: "none"` against the same fixtures: `reasoningTokens: 0` on 11 of
 * 11 completed runs, 91.7% delivery, p50 28.4 s — clearing the ADR-0002
 * survivability gate for the first time. This promotes that env-only
 * measurement to the repository default; `WORKSPACE_MODEL_REASONING_EFFORT`
 * still overrides it per `resolveWorkspaceModelTuningFromEnv` below.
 */
export const WORKSPACE_MODEL_TUNING_DEFAULTS: WorkspaceModelTuning = {
  reasoningEffort: "none",
  providerSort: "latency",
  stream: true,
  stallTimeoutMs: 20_000,
};

/**
 * Invalid tuning env. A misspelled effort must not silently degrade to the
 * default: the whole point of these knobs is that a measurement series can say
 * which value produced which numbers, and a silent fallback would make a run
 * unattributable.
 */
export class WorkspaceModelTuningConfigError extends NonRetryableReviewError {
  constructor(variable: string, value: string, accepted: readonly string[]) {
    super(`${variable}="${value}" is not a valid value; expected one of: ${accepted.join(", ")}`);
    this.name = "WorkspaceModelTuningConfigError";
  }
}

function parseTuningEnum<T extends string>(
  variable: string,
  raw: string | undefined,
  accepted: readonly T[],
): T | undefined {
  // Unset and empty both mean "not configured" — Vercel env vars that exist
  // with an empty value are the normal way to clear one.
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (!(accepted as readonly string[]).includes(value)) throw new WorkspaceModelTuningConfigError(variable, value, accepted);
  return value as T;
}

/**
 * Resolve the env-tunable survivability knobs, once, in one place.
 *
 * Env exists so ADR-0002's model/routing experiments are env-only changes on a
 * deployed build (owner decision 2026-08-26: measure reasoning `none` on the
 * incumbent and a non-reasoning model, without a code change). Precedence is
 * defaults < env < per-call `deps.tuning`, so tests stay in control.
 */
export function resolveWorkspaceModelTuningFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<WorkspaceModelTuning> {
  const reasoningEffort = parseTuningEnum<WorkspaceReasoningSetting>(
    "WORKSPACE_MODEL_REASONING_EFFORT",
    env.WORKSPACE_MODEL_REASONING_EFFORT,
    [...WORKSPACE_REASONING_EFFORTS, "omit"],
  );
  const providerSort = parseTuningEnum<WorkspaceProviderSortSetting>(
    "WORKSPACE_MODEL_PROVIDER_SORT",
    env.WORKSPACE_MODEL_PROVIDER_SORT,
    [...WORKSPACE_PROVIDER_SORTS, "omit"],
  );
  return {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(providerSort !== undefined ? { providerSort } : {}),
  };
}

export type WorkspaceModelResponse = {
  text: string;
  model?: string;
  /** Serving provider slug, when OpenRouter reports one (metadata only). */
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    estimatedCostUsd?: number;
  };
};

export type WorkspaceModelRequestArgs = {
  model: string;
  systemPrompt: string;
  input: string;
  schema: unknown;
  maxOutputTokens: number;
  signal: AbortSignal;
  tuning: WorkspaceModelTuning;
  /**
   * Provider slugs the retry must route around (ADR-0002 option B: "the second
   * attempt routed away from the provider that failed"). Per-attempt state, not
   * a tuning knob — attempt 1 never sends it.
   */
  ignoreProviders?: readonly string[];
};

export type WorkspaceModelRequest = (request: WorkspaceModelRequestArgs) => Promise<WorkspaceModelResponse>;

export type WorkspaceAnalysisDeps = {
  requestModel?: WorkspaceModelRequest;
  now?: () => number;
  /** Per-call overrides of the survivability knobs; unset fields keep the defaults. */
  tuning?: Partial<WorkspaceModelTuning>;
};

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * The two messages undici (Node's built-in `fetch`) uses when a connection dies
 * rather than returning a response. Verified against the installed
 * `node_modules/undici`:
 *   - `new TypeError('fetch failed', { cause: response.error })`
 *     (`lib/web/fetch/index.js:237`) — the request never produced a response.
 *   - `new TypeError('terminated', { cause: ... })`
 *     (`lib/web/fetch/index.js:2132`) — the response body was cut mid-stream.
 * Confirmed empirically on Node v22.14.0 against a socket that resets: the
 * `fetch()` rejection is `TypeError: fetch failed` and the `reader.read()`
 * rejection is `TypeError: terminated`, both with `cause.code === "ECONNRESET"`
 * (undici also raises `UND_ERR_SOCKET` causes under the same two messages).
 *
 * Matching the message rather than the cause is deliberate: the cause varies by
 * failure (ECONNRESET, UND_ERR_SOCKET, TLS errors), the outer message does not,
 * and an unrelated internal `TypeError` — a genuine bug — carries neither
 * message and so stays a plain model failure.
 */
const UNDICI_CONNECTION_FAILURE_MESSAGES = new Set(["fetch failed", "terminated"]);

/**
 * Classify a transport-level rejection as a dead connection, or return
 * `undefined` to leave it alone.
 *
 * Ternary's own errors (stall, truncated stream, malformed frame, non-OK HTTP,
 * provider error frames) are never `TypeError` and never carry an abort name,
 * so they pass through unchanged and keep their own meaning.
 */
function asConnectionError(error: unknown): WorkspaceModelConnectionError | undefined {
  if (isAbortError(error)) return new WorkspaceModelConnectionError(error instanceof Error ? error.message : String(error));
  if (error instanceof TypeError && UNDICI_CONNECTION_FAILURE_MESSAGES.has(error.message)) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    return new WorkspaceModelConnectionError(`${error.message}${code}`);
  }
  return undefined;
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

/**
 * OpenRouter usage block, shared by the streamed and non-streamed paths.
 * `cost` and `completion_tokens_details.reasoning_tokens` are always present
 * when available — OpenRouter's usage-accounting docs state that usage is
 * included automatically and that `usage: { include: true }` /
 * `stream_options: { include_usage: true }` are deprecated no-ops, so neither
 * is sent (sending them under `require_parameters: true` would only risk
 * narrowing the provider pool).
 */
type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
};

function toWorkspaceUsage(usage: OpenRouterUsage | undefined): WorkspaceModelResponse["usage"] {
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    ...(usage?.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage?.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(usage?.cost !== undefined ? { estimatedCostUsd: usage.cost } : {}),
  };
}

/**
 * Build the request body. The survivability parameters all come from `tuning`
 * so the spike can move them without touching this function:
 *
 * - `reasoning.effort` — bounded reasoning budget (reasoning-tokens docs).
 * - `provider.sort` — deterministic routing; sorting disables load balancing
 *   and makes the router try providers in sorted order (provider-routing docs).
 * - `provider.require_parameters` — kept `true` because the request uses a
 *   strict `json_schema` response format; every `deepseek-v4-flash` endpoint
 *   lists both `reasoning` and `response_format`/`structured_outputs` in its
 *   `supported_parameters`, so this does not shrink the pool.
 * - `stream` — so a silent provider is detectable before the deadline.
 * - `provider.ignore` — the retry's blocklist. Verified 2026-08-26 against
 *   https://openrouter.ai/docs/features/provider-routing: `ignore` is
 *   documented as `string[]`, "List of provider slugs to skip for this
 *   request", with the example `{ "provider": { "ignore": ["deepinfra"] } }`.
 *   (`only` is the allowlist counterpart; a blocklist is what ADR-0002 wants —
 *   route *away* from the provider that just failed without pinning the pool.)
 *   Omitted entirely on attempt 1 and whenever the failed provider is unknown.
 */
export function buildWorkspaceModelRequestBody(request: WorkspaceModelRequestArgs): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.input },
    ],
    response_format: { type: "json_schema", json_schema: { name: "workspace_review", strict: true, schema: request.schema } },
    // `omit` means the key never reaches the wire. Under `require_parameters:
    // true` an unsupported parameter is not ignored — it excludes every
    // provider that does not support it, which is how a `reasoning` object
    // makes a non-reasoning model unroutable.
    ...(request.tuning.reasoningEffort === "omit" ? {} : { reasoning: { effort: request.tuning.reasoningEffort } }),
    provider: {
      require_parameters: true,
      ...(request.tuning.providerSort === "omit" ? {} : { sort: request.tuning.providerSort }),
      ...(request.ignoreProviders?.length ? { ignore: [...request.ignoreProviders] } : {}),
    },
    ...(request.tuning.stream ? { stream: true } : {}),
  };
}

type StreamAccumulator = {
  text: string;
  model?: string;
  provider?: string;
  usage?: OpenRouterUsage;
  /**
   * Whether the stream announced its own end. OpenRouter's streaming doc
   * documents exactly two terminal signals: the `data: [DONE]` sentinel and a
   * chunk carrying `finish_reason: "error"` (handled as a throw below). The
   * OpenAI-compatible `finish_reason` values `stop`/`length`/`content_filter`/
   * `tool_calls` are NOT documented on that page, so they are accepted as
   * belt-and-braces terminators for providers that omit `[DONE]` — never as the
   * primary signal.
   */
  terminated: boolean;
};

const TERMINAL_FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls"]);

/**
 * Race one awaited step against the stall window. Used for BOTH the
 * request/headers phase and each body read: a provider that accepts the
 * connection and then hangs before sending headers is the exact Phase B
 * failure mode, and arming the timer only after `fetch()` resolves would let it
 * run to the end-to-end deadline instead of failing fast.
 */
function withStallDeadline<T>(
  operation: Promise<T>,
  waitMs: number,
  abort: () => void,
  windowMs = waitMs,
): Promise<T> {
  // Suppress unhandled-rejection noise from the LOSER of the race without
  // swallowing the rejection itself: the handler goes on a derived promise, so
  // `operation`'s own rejection still reaches the race below.
  void operation.then(
    () => {},
    () => {},
  );
  let stallTimer: ReturnType<typeof setTimeout>;
  const stall = new Promise<never>((_, reject) => {
    stallTimer = setTimeout(() => {
      abort();
      reject(new WorkspaceModelStallError(windowMs));
    }, Math.max(0, waitMs));
    // Never let a pending stall timer hold the process open.
    (stallTimer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([operation, stall]).finally(() => clearTimeout(stallTimer!));
}

/**
 * An SSE `data:` frame that is not parseable JSON. Silently skipping it would
 * drop real content (a delta, the usage chunk, or `[DONE]`) and let a truncated
 * generation pass as a complete one; the same applies to a partial line left in
 * the buffer at EOF.
 */
export class WorkspaceModelMalformedFrameError extends NonRetryableReviewError {
  constructor() {
    super("Workspace review model stream contained an unparseable data frame; the generation was cut short");
    this.name = "WorkspaceModelMalformedFrameError";
  }
}

/** A stream whose body ended without announcing completion is a dropped connection, not a review. */
export class WorkspaceModelTruncatedStreamError extends NonRetryableReviewError {
  constructor() {
    super("Workspace review model stream ended without a completion marker; the generation was cut short");
    this.name = "WorkspaceModelTruncatedStreamError";
  }
}

/**
 * Consume one SSE line and report what class of line it was, so the caller can
 * hold the stall clock to *data frames* rather than to bytes. Mutates the
 * accumulator. Throws on a mid-stream error event — OpenRouter reports those as
 * a `data:` frame with a top-level `error` and `finish_reason: "error"` while
 * the HTTP status stays 200, so the only place they can be caught is here — and
 * on a `data:` frame that is not parseable JSON.
 */
type StreamLineKind = "data" | "done" | "ignored";

function consumeStreamLine(line: string, acc: StreamAccumulator): StreamLineKind {
  const trimmed = line.trim();
  // Keepalive comments (": OPENROUTER PROCESSING") and blank separator lines
  // are tolerated but are NOT data: they prove the socket is warm, not that the
  // model is generating, so they must not reset the stall clock.
  if (!trimmed || trimmed.startsWith(":")) return "ignored";
  if (!trimmed.startsWith("data:")) return "ignored";
  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return "done";
  let chunk: {
    model?: string;
    provider?: string;
    error?: { message?: string };
    choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null; error?: { message?: string } }>;
    usage?: OpenRouterUsage;
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    throw new WorkspaceModelMalformedFrameError();
  }
  const choice = chunk.choices?.[0];
  const streamError = chunk.error ?? choice?.error;
  // Pin the provider before throwing: a retry can only route around a provider
  // it can name, and this frame is often the only place the name appears.
  if (chunk.model) acc.model = chunk.model;
  if (chunk.provider) acc.provider = chunk.provider;
  if (streamError) {
    throw attachWorkspaceProvider(
      new WorkspaceModelProviderError(streamError.message ?? "generation ended with an error"),
      acc.provider,
    );
  }
  if (chunk.usage) acc.usage = chunk.usage;
  // Reading continues past a terminal finish_reason: the usage chunk and the
  // `[DONE]` sentinel normally follow it.
  if (choice?.finish_reason && TERMINAL_FINISH_REASONS.has(choice.finish_reason)) acc.terminated = true;
  const delta = choice?.delta?.content;
  if (typeof delta === "string") acc.text += delta;
  return "data";
}

/**
 * Read the SSE body under the stall contract: the attempt fails if no SSE
 * **data frame** arrives for `stallTimeoutMs`.
 *
 * The clock deliberately does NOT track bytes. OpenRouter emits
 * `: OPENROUTER PROCESSING` keepalive comments, so a provider that holds the
 * socket warm while generating nothing would reset a byte-based window forever
 * and escape detection entirely — the Phase B failure mode wearing a disguise.
 * Only `data:` frames (content or reasoning deltas, the usage chunk, `[DONE]`)
 * count as progress; comments and blank separator lines are tolerated and
 * ignored.
 *
 * Enforced two ways, because either alone has a hole: a timer armed for the
 * time REMAINING since the last data frame (so a keepalive trickle still trips
 * at the window), plus an elapsed check on every read completion (so a read
 * that returns only keepalives cannot re-arm a full window).
 */
async function readWorkspaceModelStream(
  body: ReadableStream<Uint8Array>,
  stallTimeoutMs: number,
  abort: () => void,
  // Owned by the caller so the served provider survives a throw: on a stall or
  // a cut body the accumulator is the only record of who was serving.
  acc: StreamAccumulator,
): Promise<StreamAccumulator> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The clock starts when the stream does: response headers are the last thing
  // that counts as progress before the first data frame.
  let lastDataFrameAt = Date.now();
  try {
    for (;;) {
      const waitMs = stallTimeoutMs - (Date.now() - lastDataFrameAt);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await withStallDeadline(reader.read(), waitMs, abort, stallTimeoutMs);
      } catch (error) {
        // A body cut mid-stream is a dead connection, not a slow review. The
        // stall window's own error is not a TypeError, so it passes through.
        throw asConnectionError(error) ?? error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sawDataFrame = false;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const kind = consumeStreamLine(line, acc);
        if (kind !== "ignored") sawDataFrame = true;
        if (kind === "done") {
          acc.terminated = true;
          return acc;
        }
        newline = buffer.indexOf("\n");
      }
      if (sawDataFrame) lastDataFrameAt = Date.now();
      else if (Date.now() - lastDataFrameAt >= stallTimeoutMs) {
        abort();
        throw new WorkspaceModelStallError(stallTimeoutMs);
      }
    }
    // A trailing partial line is not "nothing left over": if it is a data frame
    // it is a truncated one, and consumeStreamLine throws for it.
    if (buffer && consumeStreamLine(buffer, acc) === "done") acc.terminated = true;
    // Clean EOF is not success. Without `[DONE]` or a terminal finish_reason the
    // body simply stopped, and a truncated prefix that happens to parse as a
    // valid review would otherwise be published as one.
    if (!acc.terminated) throw new WorkspaceModelTruncatedStreamError();
    return acc;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Default OpenRouter transport: one request, strict schema, no fallback chain,
 * bounded reasoning, deterministic provider routing, and (by default) a
 * streamed response with stall detection.
 */
export const requestOpenRouterWorkspaceModel: WorkspaceModelRequest = async (request) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new NonRetryableReviewError("Workspace review requires OPENROUTER_API_KEY");
  // The stall abort needs its own controller: aborting the caller's signal
  // would make a stall indistinguishable from the end-to-end deadline, which
  // is precisely the distinction the spike is measuring.
  const controller = new AbortController();
  // Declared out here so the catch blocks can name the serving provider even
  // when the stream died before returning anything.
  const acc: StreamAccumulator = { text: "", terminated: false };
  const onOuterAbort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", onOuterAbort, { once: true });
  let response: Response;
  try {
    const pending = fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildWorkspaceModelRequestBody(request)),
      signal: controller.signal,
    });
    // The stall window covers the request/headers phase too, but ONLY when
    // streaming: with `stream: true` headers arrive promptly, so silence here
    // means a hung provider. A non-streamed response legitimately withholds
    // headers until the whole generation is buffered, so that path stays
    // governed by the end-to-end deadline alone.
    response = request.tuning.stream
      ? await withStallDeadline(pending, request.tuning.stallTimeoutMs, () => controller.abort())
      : await pending;
  } catch (error) {
    request.signal.removeEventListener("abort", onOuterAbort);
    // The connection never produced a response. Classified here, at the
    // transport boundary, so the wrapper's deadline check stays the only thing
    // that can call something a timeout.
    throw attachWorkspaceProvider(asConnectionError(error) ?? error, acc.provider);
  }
  try {
    if (!response.ok) {
      throw workspaceModelHttpError(response.status, await response.text());
    }
    if (request.tuning.stream) {
      if (!response.body) throw new NonRetryableReviewError("Workspace review model response did not include output");
      await readWorkspaceModelStream(response.body, request.tuning.stallTimeoutMs, () => controller.abort(), acc);
      if (!acc.text) throw new NonRetryableReviewError("Workspace review model response did not include output");
      return {
        text: acc.text,
        ...(acc.model ? { model: acc.model } : {}),
        ...(acc.provider ? { provider: acc.provider } : {}),
        usage: toWorkspaceUsage(acc.usage),
      };
    }
    const payload = await response.json() as {
      model?: string;
      provider?: string;
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string | null }; error?: { message?: string } }>;
      usage?: OpenRouterUsage;
    };
    if (payload.provider) acc.provider = payload.provider;
    const choice = payload.choices?.[0];
    const providerError = choice?.error ?? payload.error;
    if (providerError) {
      throw attachWorkspaceProvider(
        new WorkspaceModelProviderError(providerError.message ?? "generation ended with an error"),
        acc.provider,
      );
    }
    const text = choice?.message?.content;
    if (!text) throw new NonRetryableReviewError("Workspace review model response did not include output");
    return {
      text,
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.provider ? { provider: payload.provider } : {}),
      usage: toWorkspaceUsage(payload.usage),
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
    // Covers the non-streamed `response.json()` and the non-OK `response.text()`
    // too: a body that dies while being buffered is the same dead connection.
    // Already-classified and Ternary-owned errors pass through untouched.
    throw attachWorkspaceProvider(asConnectionError(error) ?? error, acc.provider);
  } finally {
    request.signal.removeEventListener("abort", onOuterAbort);
    // Idempotent: on success the body is already fully read, on failure this is
    // what actually tears the socket down instead of leaving it to GC.
    controller.abort();
  }
};

/**
 * Run one advisory Workspace Review: build the versioned prompt for the review
 * kind, make at most two deadline-bounded model attempts against the same model
 * (ADR-0002 option B), validate the structured output, apply the policy
 * threshold and finding cap, and derive the verdict.
 *
 * The retry is bounded three ways at once: at most `WORKSPACE_REVIEW_MAX_ATTEMPTS`
 * requests, only for the failure classes `workspaceRetryReason` names, and only
 * while a full attempt budget plus the assembly reserve still fits before the
 * end-to-end deadline. One review therefore costs at most two model
 * invocations — which is exactly what the request-based hourly gate bounds.
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
  // Defaults < env < per-call overrides. Resolved before the deadline timer is
  // armed so a misconfigured env fails the request outright rather than being
  // reported as a model failure.
  const tuning: WorkspaceModelTuning = {
    ...WORKSPACE_MODEL_TUNING_DEFAULTS,
    ...resolveWorkspaceModelTuningFromEnv(),
    ...deps.tuning,
  };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = Math.floor(input.deadlineAt - startedAt);
  if (timeoutMs < MIN_OPENROUTER_TIMEOUT_MS) throw new WorkspaceReviewTimeoutError(Math.max(0, timeoutMs));

  const { input: redactedInput, redactionApplied } = redactWorkspaceAnalysisInput(input);
  const systemPrompt = getWorkspaceSystemPrompt(input.reviewKind);
  const modelInput = buildWorkspaceReviewInput(redactedInput);

  let deadlineReached = false;
  // The attempt currently in flight, so the end-to-end deadline can abort
  // whichever one it catches — attempt 2 included.
  let activeController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout>;
  // Racing a deadline promise (not just aborting the signal) means the deadline
  // is enforced deterministically even if a provider ignores the abort signal
  // and never settles its own promise. Created ONCE and raced by every attempt:
  // it is the end-to-end bound, not a per-attempt one.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      activeController?.abort();
      reject(new WorkspaceReviewTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  // One entry per attempt actually sent; the value is the serving provider when
  // one was reported. Metadata only — never prompt text, never payload bytes.
  const attemptProviders: Array<string | undefined> = [];
  let retryReason: string | undefined;
  let retrySkipped: WorkspaceAttemptMetadata["retrySkipped"];
  const ignoreProviders: string[] = [];
  const attemptMetadata = (): WorkspaceAttemptMetadata => ({
    attempts: attemptProviders.length,
    ...(retryReason !== undefined ? { retryReason } : {}),
    ...(retrySkipped !== undefined ? { retrySkipped } : {}),
    ...(attemptProviders[0] !== undefined ? { attempt1Provider: attemptProviders[0] } : {}),
    ...(attemptProviders[1] !== undefined ? { attempt2Provider: attemptProviders[1] } : {}),
  });

  try {
    for (let attempt = 1; ; attempt += 1) {
      const index = attempt - 1;
      attemptProviders.push(undefined);
      // Attempt budget. While a retry is still possible the attempt is capped at
      // its own slice (ADR-0002: 5 + 2×80 + 15 = 180 s), so a stuck attempt
      // cannot eat the room the retry needs. The FINAL attempt is bounded by the
      // end-to-end deadline instead: there is nothing left to reserve time for,
      // and capping it lower would only convert the contract's deterministic
      // 504 `workspace_review_timeout` into a 500 while leaving allowed budget
      // unused. Either way the deadline timer — armed first, so it fires first
      // when the two coincide — is what ends the last attempt.
      const remainingBeforeAttemptMs = Math.floor(input.deadlineAt - now());
      const attemptBudgetMs = Math.max(
        0,
        attempt < WORKSPACE_REVIEW_MAX_ATTEMPTS
          ? Math.min(WORKSPACE_REVIEW_ATTEMPT_BUDGET_MS, remainingBeforeAttemptMs)
          : remainingBeforeAttemptMs,
      );
      const controller = new AbortController();
      activeController = controller;
      let attemptExpired = false;
      let attemptTimer: ReturnType<typeof setTimeout>;
      const attemptDeadline = new Promise<never>((_, reject) => {
        attemptTimer = setTimeout(() => {
          attemptExpired = true;
          controller.abort();
          reject(new WorkspaceModelAttemptTimeoutError(attemptBudgetMs));
        }, attemptBudgetMs);
      });

      try {
        const response = await Promise.race([
          requestModel({
            model: input.policy.model,
            systemPrompt,
            input: modelInput,
            schema: workspaceReviewSchema,
            maxOutputTokens: WORKSPACE_MAX_OUTPUT_TOKENS,
            signal: controller.signal,
            tuning,
            // Attempt 1 sends no blocklist at all; attempt 2 routes away from
            // the provider that failed, when attempt 1 named one.
            ...(ignoreProviders.length ? { ignoreProviders: [...ignoreProviders] } : {}),
          }),
          deadline,
          attemptDeadline,
        ]);
        attemptProviders[index] = response.provider;

        let review: ReturnType<typeof parseWorkspaceReviewOutput>;
        try {
          review = parseWorkspaceReviewOutput(response.text);
        } catch (error) {
          // Retry-eligible (see WorkspaceReviewOutputInvalidError): a
          // well-formed request that produced a malformed answer is a property
          // of the generation, not of the payload.
          throw attachWorkspaceProvider(
            new WorkspaceReviewOutputInvalidError(error instanceof Error ? error.message : String(error), error),
            response.provider,
          );
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
        const metadata = attemptMetadata();

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
            ...(response.provider !== undefined ? { provider: response.provider } : {}),
            ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
            ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
            ...(response.usage?.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
            ...(response.usage?.estimatedCostUsd !== undefined ? { estimatedCostUsd: response.usage.estimatedCostUsd } : {}),
            attempts: metadata.attempts,
            ...(metadata.retryReason !== undefined ? { retryReason: metadata.retryReason } : {}),
            ...(metadata.attempt1Provider !== undefined ? { attempt1Provider: metadata.attempt1Provider } : {}),
            ...(metadata.attempt2Provider !== undefined ? { attempt2Provider: metadata.attempt2Provider } : {}),
          },
        };
      } catch (error) {
        const failure = classifyWorkspaceAttemptError(error, {
          deadlineReached,
          attemptExpired,
          aborted: controller.signal.aborted,
          attemptBudgetMs,
          timeoutMs,
        });
        attemptProviders[index] ??= workspaceProviderFromError(failure);

        // The end-to-end deadline is final: no time remains by definition.
        if (failure instanceof WorkspaceReviewTimeoutError) {
          throw attachWorkspaceAttemptMetadata(failure, attemptMetadata());
        }

        const reason = workspaceRetryReason(failure);
        if (reason === undefined || attempt >= WORKSPACE_REVIEW_MAX_ATTEMPTS) {
          if (reason !== undefined) retryReason = reason;
          throw attachWorkspaceAttemptMetadata(failure, attemptMetadata());
        }
        retryReason = reason;

        // A second attempt only starts if its FULL budget still fits before the
        // deadline (ADR-0002 fixed decision 6). Starting one that the deadline
        // would cut in half just burns money for a 504 either way.
        const remainingMs = Math.floor(input.deadlineAt - now());
        if (remainingMs < WORKSPACE_REVIEW_ATTEMPT_BUDGET_MS + WORKSPACE_REVIEW_ASSEMBLY_RESERVE_MS) {
          retrySkipped = "insufficient_budget";
          throw attachWorkspaceAttemptMetadata(failure, attemptMetadata());
        }

        const failedProvider = attemptProviders[index];
        // No provider named (an HTTP error, a connection that died before the
        // first chunk) — attempt 2 sends the same routing rather than an
        // `ignore` list it cannot fill.
        if (failedProvider) ignoreProviders.push(failedProvider);
      } finally {
        clearTimeout(attemptTimer!);
      }
    }
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Turn one attempt's rejection into the error class the retry policy reads.
 *
 * Ordering is load-bearing and unchanged from step 1: an explicit timeout wins,
 * then a stall (a stall that races the deadline abort must stay a stall, or the
 * measurement loses the cause), then our own deadline, then the attempt budget,
 * then transport classification.
 */
function classifyWorkspaceAttemptError(
  error: unknown,
  context: {
    deadlineReached: boolean;
    attemptExpired: boolean;
    aborted: boolean;
    attemptBudgetMs: number;
    timeoutMs: number;
  },
): unknown {
  if (error instanceof WorkspaceReviewTimeoutError) return error;
  // A stall is a delivery failure with its own cause; it must never be
  // laundered into the generic deadline error by the abort checks below.
  if (error instanceof WorkspaceModelStallError) return error;
  // ONLY the deadline race may produce a timeout. `deadlineReached` is set by
  // the timer before it aborts, so an AbortError caused by our own deadline
  // still lands here; anything else that aborted did so because the connection
  // died, and saying "timeout" for that made Phase B's 24 timeouts unreadable
  // (ADR-0002; dogfood report §9 item 1).
  if (context.deadlineReached) return new WorkspaceReviewTimeoutError(context.timeoutMs);
  if (error instanceof WorkspaceModelAttemptTimeoutError) return error;
  // The attempt's own budget aborted the socket; the review still has time.
  if (context.attemptExpired) {
    return attachWorkspaceProvider(
      new WorkspaceModelAttemptTimeoutError(context.attemptBudgetMs),
      workspaceProviderFromError(error),
    );
  }
  // Classified here as well as at the transport boundary: the contract is the
  // wrapper's, so it must hold for ANY injected `requestModel`, not only for
  // the OpenRouter transport that ships with it.
  const connection = asConnectionError(error);
  if (connection) return attachWorkspaceProvider(connection, workspaceProviderFromError(error));
  if (context.aborted) {
    return attachWorkspaceProvider(
      new WorkspaceModelConnectionError(error instanceof Error ? error.message : String(error)),
      workspaceProviderFromError(error),
    );
  }
  return error;
}
