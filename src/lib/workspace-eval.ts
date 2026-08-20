/**
 * Workspace Review evaluation: loads workspace Eval Cases and scores an
 * analyzer against them with the existing eval machinery (matcher, metrics,
 * thresholds). Fixtures live in `evals/workspace/`; the analyzer is injected,
 * so the suite runs offline with fakes and against live models identically.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvalCase, type EvalCase } from "./review-eval-case";
import { matchEvalFindings } from "./review-eval-match";
import {
  aggregateEvalMetrics,
  evaluateThresholds,
  parseEvalThresholds,
  scoreEvalCase,
  type EvalCaseMetrics,
  type EvalSuiteMetrics,
  type EvalThresholds,
} from "./review-eval-metrics";
import { analyzeWorkspaceReview } from "./workspace-analysis";
import { getWorkspaceSystemPrompt, workspacePromptVersion } from "./workspace-review-prompts";
import {
  assertCheckEvidenceInvariants,
  type CheckEvidence,
  type ChangesetEntry,
  type SnapshotEntry,
  type WorkspaceAnalysisInput,
  type WorkspaceChangeSet,
  type WorkspaceReviewKind,
  type WorkspaceReviewResult,
} from "./workspace-review-types";

export type WorkspaceEvalCase = EvalCase & { kind: WorkspaceReviewKind };

export type LoadedWorkspaceEvalCase = WorkspaceEvalCase & {
  changeSet: WorkspaceChangeSet;
  context: string;
  evidence: CheckEvidence[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

/** Parse a workspace Eval Case label document: the shared EvalCase labels plus a review kind. */
export function parseWorkspaceEvalCase(value: unknown): WorkspaceEvalCase {
  const labels = parseEvalCase(value);
  const kind = (value as Record<string, unknown>).kind;
  if (kind !== "changeset" && kind !== "snapshot") throw new Error("kind must be \"changeset\" or \"snapshot\"");
  return { ...labels, kind };
}

function parseChangesetEntry(value: unknown, path: string): ChangesetEntry {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const status = assertString(value.status, `${path}.status`);
  if (!["added", "modified", "renamed"].includes(status)) throw new Error(`${path}.status is invalid`);
  if (value.patch !== undefined && value.content !== undefined) throw new Error(`${path} patch and content are mutually exclusive`);
  const entry: ChangesetEntry = { path: assertString(value.path, `${path}.path`), status: status as ChangesetEntry["status"] };
  if (value.from !== undefined) entry.from = assertString(value.from, `${path}.from`);
  if (value.patch !== undefined) entry.patch = assertString(value.patch, `${path}.patch`);
  if (value.content !== undefined) entry.content = assertString(value.content, `${path}.content`);
  return entry;
}

function parseSnapshotEntry(value: unknown, path: string): SnapshotEntry {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return { path: assertString(value.path, `${path}.path`), content: assertString(value.content, `${path}.content`) };
}

/** Parse and validate a `workspace.json` fixture into a WorkspaceChangeSet. */
export function parseWorkspaceChangeSet(value: unknown): WorkspaceChangeSet {
  if (!isRecord(value)) throw new Error("workspace must be an object");
  const kind = value.kind;
  if (kind !== "changeset" && kind !== "snapshot") throw new Error("workspace.kind must be \"changeset\" or \"snapshot\"");
  const vcs = value.vcs;
  if (vcs !== "git" && vcs !== "none") throw new Error("workspace.vcs must be \"git\" or \"none\"");
  const changeSet: WorkspaceChangeSet = {
    kind,
    workspaceLabel: assertString(value.workspaceLabel, "workspace.workspaceLabel"),
    vcs,
  };
  if (value.branch !== undefined) changeSet.branch = assertString(value.branch, "workspace.branch");
  if (value.baseState !== undefined) {
    if (value.baseState === "unborn") changeSet.baseState = "unborn";
    else if (isRecord(value.baseState)) changeSet.baseState = { headSha: assertString(value.baseState.headSha, "workspace.baseState.headSha") };
    else throw new Error("workspace.baseState must be \"unborn\" or { headSha }");
  }
  if (kind === "changeset") {
    if (!Array.isArray(value.changeset)) throw new Error("workspace.changeset must be an array for changeset reviews");
    changeSet.changeset = value.changeset.map((entry, index) => parseChangesetEntry(entry, `workspace.changeset[${index}]`));
  } else {
    if (!Array.isArray(value.snapshot)) throw new Error("workspace.snapshot must be an array for snapshot reviews");
    changeSet.snapshot = value.snapshot.map((entry, index) => parseSnapshotEntry(entry, `workspace.snapshot[${index}]`));
  }
  return changeSet;
}

/** Load every workspace Eval Case directory under `casesDir`. */
export async function loadWorkspaceEvalCases(casesDir: string): Promise<LoadedWorkspaceEvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const cases: LoadedWorkspaceEvalCase[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(casesDir, entry.name);
    const labels = parseWorkspaceEvalCase(JSON.parse(await readFile(join(directory, "case.json"), "utf8")) as unknown);
    if (labels.id !== entry.name) throw new Error(`Workspace Eval Case id "${labels.id}" must match directory "${entry.name}"`);
    const changeSet = parseWorkspaceChangeSet(JSON.parse(await readFile(join(directory, "workspace.json"), "utf8")) as unknown);
    if (changeSet.kind !== labels.kind) throw new Error(`Workspace Eval Case "${labels.id}" kind "${labels.kind}" does not match workspace.json kind "${changeSet.kind}"`);
    let context = "";
    try {
      context = await readFile(join(directory, "context.txt"), "utf8");
    } catch {
      context = "";
    }
    let evidence: CheckEvidence[] = [];
    try {
      evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8")) as CheckEvidence[];
    } catch {
      // optional
    }
    for (const check of evidence) assertCheckEvidenceInvariants(check);
    cases.push({ ...labels, changeSet, context, evidence });
  }
  return cases;
}

export type WorkspaceEvalAnalyzer = (input: WorkspaceAnalysisInput) => Promise<WorkspaceReviewResult>;

export type WorkspaceEvalRunnerOptions = {
  casesDir: string;
  thresholdsPath: string;
  /** Written only when provided; offline scoring runs need no report file. */
  resultsDir?: string;
  model?: string;
  gate?: boolean;
  /** Per-case analysis deadline; defaults to the spec's 120s end-to-end ceiling. */
  deadlineMsPerCase?: number;
  now?: () => Date;
  analyze?: WorkspaceEvalAnalyzer;
};

export type WorkspaceEvalCaseReport = {
  id: string;
  title: string;
  kind: WorkspaceReviewKind;
  metrics: EvalCaseMetrics;
  verdict?: WorkspaceReviewResult["verdict"];
  verdictAgreed?: boolean;
  truePositiveKeys: string[];
  falseNegativeRuleIds: string[];
  falsePositiveTitles: string[];
  error?: string;
};

export type WorkspaceEvalRunReport = {
  ranAt: string;
  promptVersions: Record<WorkspaceReviewKind, string>;
  systemPromptHashes: Record<WorkspaceReviewKind, string>;
  model?: string;
  cases: WorkspaceEvalCaseReport[];
  suite: EvalSuiteMetrics;
  thresholds: EvalThresholds;
  gateFailures: string[];
};

/** Spec §6: server end-to-end deadline ceiling for one Workspace Review. */
export const WORKSPACE_EVAL_CASE_DEADLINE_MS = 120_000;

const WORKSPACE_EVAL_MODEL = "~deepseek/deepseek-v4-flash-latest";

function promptHash(prompt: string) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/** The expected advisory verdict of a case: findings iff any labeled finding is required. */
export function expectedWorkspaceVerdict(evalCase: WorkspaceEvalCase): WorkspaceReviewResult["verdict"] {
  return evalCase.expectedFindings.some((finding) => finding.required) ? "findings" : "pass";
}

export async function runWorkspaceEvalSuite(options: WorkspaceEvalRunnerOptions): Promise<WorkspaceEvalRunReport> {
  const analyze = options.analyze ?? analyzeWorkspaceReview;
  if (!options.analyze && !process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required for live workspace Eval Runs (inject analyze for offline scoring)");
  }
  const thresholds = parseEvalThresholds(JSON.parse(await readFile(options.thresholdsPath, "utf8")) as unknown);
  const cases = await loadWorkspaceEvalCases(options.casesDir);
  if (cases.length === 0) throw new Error(`No workspace Eval Cases found in ${options.casesDir}`);
  const deadlineMs = options.deadlineMsPerCase ?? WORKSPACE_EVAL_CASE_DEADLINE_MS;
  const model = options.model ?? WORKSPACE_EVAL_MODEL;

  const reports: WorkspaceEvalCaseReport[] = [];
  for (const evalCase of cases) {
    try {
      const result = await analyze({
        reviewKind: evalCase.kind,
        changeSet: evalCase.changeSet,
        repositoryContext: evalCase.context,
        evidence: evalCase.evidence,
        policy: { model, minimumSeverity: "suggestion" },
        deadlineAt: Date.now() + deadlineMs,
      });
      const match = matchEvalFindings(evalCase, result.findings);
      reports.push({
        id: evalCase.id,
        title: evalCase.title,
        kind: evalCase.kind,
        metrics: scoreEvalCase(match, result),
        verdict: result.verdict,
        verdictAgreed: result.verdict === expectedWorkspaceVerdict(evalCase),
        truePositiveKeys: match.truePositives.map((entry) => entry.predicted.findingKey ?? entry.predicted.title),
        falseNegativeRuleIds: match.falseNegatives.map((entry) => entry.ruleId),
        falsePositiveTitles: match.falsePositives.map((entry) => entry.title),
      });
    } catch (error) {
      // Keep the suite moving through provider timeouts/errors; do not score failed cases.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Workspace Eval Case ${evalCase.id} failed: ${message}`);
      reports.push({
        id: evalCase.id,
        title: evalCase.title,
        kind: evalCase.kind,
        metrics: scoreEvalCase({ truePositives: [], falseNegatives: [], falsePositives: [] }),
        truePositiveKeys: [],
        falseNegativeRuleIds: [],
        falsePositiveTitles: [],
        error: message,
      });
    }
  }

  const scored = reports.filter((entry) => !entry.error);
  const suite = aggregateEvalMetrics(scored.map((entry) => entry.metrics));
  const gateFailures = options.gate ? evaluateThresholds(suite, thresholds) : [];
  if (options.gate) {
    for (const entry of reports) {
      if (entry.error) gateFailures.push(`case ${entry.id} unscored: ${entry.error}`);
      else if (entry.verdictAgreed === false) gateFailures.push(`case ${entry.id} verdict ${entry.verdict} disagreed with the labeled expectation`);
    }
  }

  const ranAt = (options.now ?? (() => new Date))().toISOString();
  const report: WorkspaceEvalRunReport = {
    ranAt,
    promptVersions: {
      changeset: workspacePromptVersion("changeset"),
      snapshot: workspacePromptVersion("snapshot"),
    },
    systemPromptHashes: {
      changeset: promptHash(getWorkspaceSystemPrompt("changeset")),
      snapshot: promptHash(getWorkspaceSystemPrompt("snapshot")),
    },
    ...(options.model ? { model: options.model } : {}),
    cases: reports,
    suite,
    thresholds,
    gateFailures,
  };

  if (options.resultsDir) {
    await mkdir(options.resultsDir, { recursive: true });
    const slug = `${ranAt.replace(/[:.]/g, "-")}-workspace`;
    await writeFile(join(options.resultsDir, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
