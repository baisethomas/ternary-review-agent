/**
 * Versioned prompt and input builders for Workspace Reviews
 * (docs/workspace-review-spec.md §3). Changeset and snapshot prompts are
 * versioned separately so Eval Runs can label and gate them independently
 * of the PR pipeline's REVIEW_PROMPT_VERSION.
 *
 * Both prompts are advisory: verdicts are derived server-side from reported
 * findings (`workspaceVerdict`), never from GitHub review semantics. The
 * snapshot prompt must never reference pull requests. Both prompts state
 * evidence trust explicitly — local evidence is client-reported and is never
 * worded as isolated sandbox evidence.
 */

import { extractReviewJsonPayload } from "./openrouter-review-provider";
import type {
  CheckEvidence,
  WorkspaceAnalysisInput,
  WorkspaceFinding,
  WorkspaceReviewKind,
} from "./workspace-review-types";

/** Bump when the changeset system prompt text changes materially. */
export const WORKSPACE_CHANGESET_PROMPT_VERSION = "workspace-changeset-v1";

/** Bump when the snapshot system prompt text changes materially. */
export const WORKSPACE_SNAPSHOT_PROMPT_VERSION = "workspace-snapshot-v1";

/** Bounded advisory report cap (spec §4.4). */
export const WORKSPACE_MAX_FINDINGS = 50;

/** Model-visible input budgets (spec §4.4 tunable defaults). */
export const WORKSPACE_PROMPT_BUDGETS = {
  /** Matches the PR pipeline's MAX_DIFF_CHARS default. */
  maxChangesetChars: 160_000,
  /** Matches the snapshot source budget. */
  maxSnapshotChars: 400_000,
  /** Matches repositoryContextCharacterBudget / maxContextChars. */
  maxContextChars: 20_000,
  /** Matches SANDBOX_MODEL_OUTPUT_LIMIT: model-visible slice per evidence command. */
  maxEvidenceOutputChars: 1_500,
} as const;

export type WorkspacePromptBudgets = typeof WORKSPACE_PROMPT_BUDGETS;

const sharedFindingContract = `Return strict JSON with: summary and findings. Each finding has a ruleId for its stable review-rule family (for example security-authorization or correctness-concurrency), plus a unique findingKey that combines that rule with the affected symbol and remains stable when line numbers or wording change. Each finding also has severity (blocking|warning|suggestion), file, optional line, title, explanation, and optional suggestedFix. Every finding's file must be a path that appears in the provided material — never invent or guess file locations; if you cannot place a problem in a provided path, omit the finding. Report at most ${WORKSPACE_MAX_FINDINGS} findings, most material first. Do not report style preferences.`;

const evidenceTrustContract = `Evidence provenance is explicit: entries with trust "unverified_client" are client-reported local output that was never verified — treat them as unconfirmed claims, not proof, and say "client-reported" if you cite them. Only entries with trust "isolated" ran in an isolated sandbox.`;

const changesetSystemPrompt = `You are Ternary, a senior code review agent performing an advisory Workspace Review of a local changeset that has not been pushed or merged anywhere. There is no merge decision to make and your report has no side effects; the developer will fix findings locally before pushing. Review only material problems introduced by this changeset relative to its base state. Prioritize correctness, security, concurrency, data loss, unsafe input handling, and missing validation or tests. ${evidenceTrustContract} ${sharedFindingContract}`;

const snapshotSystemPrompt = `You are Ternary, a senior code review agent performing an advisory Snapshot Review of a bounded local workspace capture. There is no base state and no change to attribute: you are looking at the workspace as it stands, so judge the code that exists, not an imagined diff. Report only material defects and risks: broken authorization, secret handling, unsafe input handling, concurrency or data-loss hazards, missing validation, and whole-project architectural risks that would bite soon. Long-standing deliberate patterns, framework conventions, and incomplete-looking scaffolding are not findings unless they create a concrete material risk. ${evidenceTrustContract} ${sharedFindingContract}`;

/** System prompt text for a Workspace Review kind (for Eval Run variant labeling). */
export function getWorkspaceSystemPrompt(kind: WorkspaceReviewKind) {
  return kind === "changeset" ? changesetSystemPrompt : snapshotSystemPrompt;
}

/** Prompt version identifier for a Workspace Review kind. */
export function workspacePromptVersion(kind: WorkspaceReviewKind) {
  return kind === "changeset" ? WORKSPACE_CHANGESET_PROMPT_VERSION : WORKSPACE_SNAPSHOT_PROMPT_VERSION;
}

function boundedSections(sections: string[], budget: number) {
  let text = "";
  let omitted = 0;
  for (const section of sections) {
    const remaining = budget - text.length;
    if (remaining <= 0) {
      omitted += 1;
      continue;
    }
    text += section.length > remaining ? `${section.slice(0, remaining)}\n… truncated by Ternary\n` : section;
  }
  return omitted ? `${text}\n[${omitted} more file(s) omitted by the input budget]` : text;
}

function renderChangeset(input: WorkspaceAnalysisInput, budgets: WorkspacePromptBudgets) {
  const entries = input.changeSet.changeset ?? [];
  if (!entries.length) return "The changeset is empty.";
  const sections = entries.map((entry) => {
    const heading = entry.status === "renamed" && entry.from
      ? `--- ${entry.path} (renamed from ${entry.from})`
      : `--- ${entry.path} (${entry.status})`;
    const body = entry.patch ?? entry.content ?? "(no content captured)";
    return `${heading}\n${body}\n`;
  });
  return boundedSections(sections, budgets.maxChangesetChars);
}

function renderSnapshot(input: WorkspaceAnalysisInput, budgets: WorkspacePromptBudgets) {
  const entries = input.changeSet.snapshot ?? [];
  if (!entries.length) return "The snapshot is empty.";
  const sections = entries.map((entry) => `--- ${entry.path}\n${entry.content}\n`);
  return boundedSections(sections, budgets.maxSnapshotChars);
}

function compactEvidenceForModel(evidence: CheckEvidence[], budgets: WorkspacePromptBudgets) {
  if (!evidence.length) return "No check evidence was provided.";
  return JSON.stringify(evidence.map((check) => ({
    origin: check.origin,
    trust: check.trust,
    status: check.status,
    label: check.label,
    ...(check.unavailableReason ? { unavailableReason: check.unavailableReason } : {}),
    ...(check.truncation?.skippedCommands.length ? { skippedCommands: check.truncation.skippedCommands } : {}),
    commands: check.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      output: command.output.length > budgets.maxEvidenceOutputChars
        ? `${command.output.slice(0, budgets.maxEvidenceOutputChars)}\n… truncated for model input`
        : command.output,
    })),
  })));
}

function describeWorkspace(input: WorkspaceAnalysisInput) {
  const { changeSet } = input;
  const lines = [`Workspace: ${changeSet.workspaceLabel} (vcs: ${changeSet.vcs})`];
  if (changeSet.branch) lines.push(`Branch: ${changeSet.branch}`);
  if (input.reviewKind === "changeset") {
    lines.push(changeSet.baseState === "unborn"
      ? "Base state: unborn HEAD (every captured file is an addition against the empty tree)"
      : changeSet.baseState
        ? `Base state: HEAD ${changeSet.baseState.headSha}`
        : "Base state: unknown");
  }
  return lines.join("\n");
}

/** Render the model-visible user input for one Workspace Review. */
export function buildWorkspaceReviewInput(
  input: WorkspaceAnalysisInput,
  budgets: WorkspacePromptBudgets = WORKSPACE_PROMPT_BUDGETS,
) {
  const subject = input.reviewKind === "changeset"
    ? `LOCAL CHANGESET:\n${renderChangeset(input, budgets)}`
    : `WORKSPACE SNAPSHOT:\n${renderSnapshot(input, budgets)}`;
  const context = input.repositoryContext.trim()
    ? input.repositoryContext.slice(0, budgets.maxContextChars)
    : "No matching repository context was available.";
  return `${describeWorkspace(input)}\n\n${subject}\n\nREPOSITORY CONTEXT:\n${context}\n\nCHECK EVIDENCE (see trust labels):\n${compactEvidenceForModel(input.evidence, budgets)}`;
}

type JsonSchema =
  | { type: "string"; enum?: readonly string[] }
  | { type: "number" }
  | { type: "integer" }
  | { type: readonly ("string" | "number" | "integer" | "null")[] }
  | { type: "array"; items: JsonSchema }
  | { type: "object"; additionalProperties: false; required: readonly string[]; properties: Record<string, JsonSchema> };

/** Structured-output schema for Workspace Reviews: summary + findings only; the advisory verdict is derived server-side. */
export const workspaceReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["ruleId", "findingKey", "severity", "file", "line", "title", "explanation", "suggestedFix"],
        properties: {
          ruleId: { type: "string" },
          findingKey: { type: "string" },
          severity: { type: "string", enum: ["blocking", "warning", "suggestion"] },
          file: { type: "string" }, line: { type: ["integer", "null"] }, title: { type: "string" },
          explanation: { type: "string" }, suggestedFix: { type: ["string", "null"] },
        },
      },
    },
  },
} as const satisfies JsonSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesSchemaType(schema: JsonSchema, type: "number" | "integer"): boolean {
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function assertMatchesSchema(value: unknown, schema: JsonSchema, path = "review") {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  // A JSON number satisfies either a "number" or an "integer" schema type -
  // the two are distinguished below once we know the value is numeric.
  const typeMatches = allowedTypes.includes(actualType as never)
    || (actualType === "number" && includesSchemaType(schema, "integer"));
  if (!typeMatches) throw new Error(`${path} has invalid type`);
  if ("enum" in schema && schema.enum && !schema.enum.includes(value as string)) throw new Error(`${path} has invalid value`);
  if (actualType === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} has invalid number`);
    if (includesSchemaType(schema, "integer") && (!Number.isInteger(value) || (value as number) < 0)) {
      throw new Error(`${path} has invalid integer`);
    }
  }
  if (schema.type === "array") {
    (value as unknown[]).forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new Error(`${path} has invalid object`);
    const allowedKeys = new Set(Object.keys(schema.properties));
    if (Object.keys(value).some((key) => !allowedKeys.has(key)) || schema.required.some((key) => !(key in value))) throw new Error(`${path} has invalid fields`);
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (key in value) assertMatchesSchema(value[key], propertySchema, `${path}.${key}`);
    }
  }
}

type RawWorkspaceFinding = {
  ruleId: string;
  findingKey: string;
  severity: WorkspaceFinding["severity"];
  file: string;
  line: number | null;
  title: string;
  explanation: string;
  suggestedFix: string | null;
};

/**
 * Parse and validate the model's Workspace Review output. Strictness matches
 * the PR provider: exact schema fields, non-empty finding identity, unique
 * finding keys, plus the bounded-report finding cap.
 */
export function parseWorkspaceReviewOutput(text: string): { summary: string; findings: WorkspaceFinding[] } {
  const value: unknown = JSON.parse(extractReviewJsonPayload(text));
  assertMatchesSchema(value, workspaceReviewSchema);
  const raw = value as { summary: string; findings: RawWorkspaceFinding[] };
  if (raw.findings.length > WORKSPACE_MAX_FINDINGS) throw new Error(`review reports more than ${WORKSPACE_MAX_FINDINGS} findings`);
  const findings: WorkspaceFinding[] = raw.findings.map((finding) => ({
    ruleId: finding.ruleId,
    findingKey: finding.findingKey,
    severity: finding.severity,
    file: finding.file,
    ...(finding.line !== null ? { line: finding.line } : {}),
    title: finding.title,
    explanation: finding.explanation,
    ...(finding.suggestedFix !== null ? { suggestedFix: finding.suggestedFix } : {}),
  }));
  if (findings.some((finding) => !finding.ruleId.trim() || !finding.findingKey.trim())) throw new Error("finding identity is invalid");
  const findingKeys = findings.map((finding) => finding.findingKey.toLowerCase());
  if (new Set(findingKeys).size !== findingKeys.length) throw new Error("finding keys are duplicated");
  return { summary: raw.summary, findings };
}
