import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateOpenRouterReview, getReviewSystemPrompt, REVIEW_PROMPT_VERSION } from "./openrouter-review-provider";
import {
  defaultEvalSandbox,
  parseEvalCase,
  parseEvalSandbox,
  type LoadedEvalCase,
} from "./review-eval-case";
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
import { resolveReviewPolicy, safeReviewPolicy, type ResolvedReviewPolicy } from "./review-policy";
import type { ReviewResult } from "./types";

export type EvalContextMode = "fixture" | "empty";

export type ReviewEvalRunnerOptions = {
  casesDir: string;
  thresholdsPath: string;
  resultsDir: string;
  model?: string;
  promptVersion?: string;
  policy?: ResolvedReviewPolicy;
  contextMode?: EvalContextMode;
  gate?: boolean;
  now?: () => Date;
  generateReview?: typeof generateOpenRouterReview;
};

export type EvalCaseReport = {
  id: string;
  title: string;
  metrics: EvalCaseMetrics;
  predictedFindings: ReviewResult["findings"];
  truePositiveKeys: string[];
  falseNegativeRuleIds: string[];
  falsePositiveTitles: string[];
  error?: string;
};

export type EvalRunReport = {
  ranAt: string;
  promptVersion: string;
  systemPromptHash: string;
  model?: string;
  contextMode: EvalContextMode;
  policyHash: string;
  cases: EvalCaseReport[];
  suite: EvalSuiteMetrics;
  thresholds: EvalThresholds;
  gateFailures: string[];
};

function policyHash(policy: ResolvedReviewPolicy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
}

function promptHash(prompt: string) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/** Load every Eval Case directory under `casesDir`. */
export async function loadEvalCases(casesDir: string): Promise<LoadedEvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const cases: LoadedEvalCase[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(casesDir, entry.name);
    const raw = JSON.parse(await readFile(join(directory, "case.json"), "utf8")) as unknown;
    const labels = parseEvalCase(raw);
    if (labels.id !== entry.name) throw new Error(`Eval Case id "${labels.id}" must match directory "${entry.name}"`);
    const diff = await readFile(join(directory, "diff.patch"), "utf8");
    let context = "";
    try {
      context = await readFile(join(directory, "context.txt"), "utf8");
    } catch {
      context = "";
    }
    let sandbox = defaultEvalSandbox();
    try {
      sandbox = parseEvalSandbox(JSON.parse(await readFile(join(directory, "sandbox.json"), "utf8")) as unknown);
    } catch {
      // optional
    }
    cases.push({ ...labels, diff, context, sandbox });
  }
  return cases;
}

export async function runReviewEvalSuite(options: ReviewEvalRunnerOptions): Promise<EvalRunReport> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is required for Eval Runs (fallback empty reviews must not score the suite)");
  }
  const contextMode = options.contextMode ?? "fixture";
  const promptVersion = options.promptVersion ?? REVIEW_PROMPT_VERSION;
  const policy = options.policy ?? resolveReviewPolicy(
    null,
    options.model ? { model: options.model } : null,
    safeReviewPolicy,
  );
  const generateReview = options.generateReview ?? generateOpenRouterReview;
  const thresholds = parseEvalThresholds(JSON.parse(await readFile(options.thresholdsPath, "utf8")) as unknown);
  const cases = await loadEvalCases(options.casesDir);
  if (cases.length === 0) throw new Error(`No Eval Cases found in ${options.casesDir}`);

  const reports: EvalCaseReport[] = [];
  for (const evalCase of cases) {
    const context = contextMode === "empty" ? "" : evalCase.context;
    try {
      const result = await generateReview(evalCase.diff, evalCase.sandbox, context, policy);
      const match = matchEvalFindings(evalCase, result.findings);
      const metrics = scoreEvalCase(match, result);
      reports.push({
        id: evalCase.id,
        title: evalCase.title,
        metrics,
        predictedFindings: result.findings,
        truePositiveKeys: match.truePositives.map((entry) => entry.predicted.findingKey ?? entry.predicted.title),
        falseNegativeRuleIds: match.falseNegatives.map((entry) => entry.ruleId),
        falsePositiveTitles: match.falsePositives.map((entry) => entry.title),
      });
    } catch (error) {
      // Keep the suite moving through provider timeouts/errors; do not score failed cases.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Eval Case ${evalCase.id} failed: ${message}`);
      reports.push({
        id: evalCase.id,
        title: evalCase.title,
        metrics: scoreEvalCase({ truePositives: [], falseNegatives: [], falsePositives: [] }),
        predictedFindings: [],
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
    }
  }
  const ranAt = (options.now ?? (() => new Date))().toISOString();
  const report: EvalRunReport = {
    ranAt,
    promptVersion,
    systemPromptHash: promptHash(getReviewSystemPrompt()),
    ...(options.model || policy.model ? { model: options.model ?? policy.model } : {}),
    contextMode,
    policyHash: policyHash(policy),
    cases: reports,
    suite,
    thresholds,
    gateFailures,
  };

  await mkdir(options.resultsDir, { recursive: true });
  const slug = `${ranAt.replace(/[:.]/g, "-")}-${promptVersion}`;
  await writeFile(join(options.resultsDir, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function parseReviewEvalArgs(argv: string[]) {
  const options: {
    model?: string;
    promptVersion?: string;
    policyJson?: string;
    contextMode: EvalContextMode;
    casesDir?: string;
    thresholdsPath?: string;
    resultsDir?: string;
    gate: boolean;
  } = { contextMode: "fixture", gate: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--gate") options.gate = true;
    else if (arg === "--model" && next) { options.model = next; index += 1; }
    else if (arg === "--prompt-version" && next) { options.promptVersion = next; index += 1; }
    else if (arg === "--policy-json" && next) { options.policyJson = next; index += 1; }
    else if (arg === "--context-mode" && next) {
      if (next !== "fixture" && next !== "empty") throw new Error("--context-mode must be fixture|empty");
      options.contextMode = next;
      index += 1;
    } else if (arg === "--cases-dir" && next) { options.casesDir = next; index += 1; }
    else if (arg === "--thresholds" && next) { options.thresholdsPath = next; index += 1; }
    else if (arg === "--results-dir" && next) { options.resultsDir = next; index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
