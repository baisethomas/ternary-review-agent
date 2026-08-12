import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewEvalArgs, runReviewEvalSuite } from "../src/lib/review-eval-runner.ts";
import { resolveReviewPolicy, safeReviewPolicy } from "../src/lib/review-policy.ts";

const root = join(import.meta.dirname, "..");
const args = parseReviewEvalArgs(process.argv.slice(2));

let policy = resolveReviewPolicy(null, args.model ? { model: args.model } : null, safeReviewPolicy);
if (args.policyJson) {
  const loaded = await import(pathToFileURL(join(process.cwd(), args.policyJson)).href, { with: { type: "json" } });
  policy = { ...policy, ...(loaded.default as object) };
}

const report = await runReviewEvalSuite({
  casesDir: args.casesDir ? join(process.cwd(), args.casesDir) : join(root, "evals/cases"),
  thresholdsPath: args.thresholdsPath ? join(process.cwd(), args.thresholdsPath) : join(root, "evals/thresholds.json"),
  resultsDir: args.resultsDir ? join(process.cwd(), args.resultsDir) : join(root, "evals/results"),
  model: args.model,
  promptVersion: args.promptVersion,
  policy,
  contextMode: args.contextMode,
  gate: args.gate,
});

console.log(JSON.stringify({
  ranAt: report.ranAt,
  model: report.model,
  promptVersion: report.promptVersion,
  suite: report.suite,
  gateFailures: report.gateFailures,
  cases: report.cases.map((entry) => ({
    id: entry.id,
    metrics: entry.metrics,
    falseNegativeRuleIds: entry.falseNegativeRuleIds,
    falsePositiveTitles: entry.falsePositiveTitles,
  })),
}, null, 2));

if (report.gateFailures.length > 0) {
  console.error(`Eval gate failed:\n${report.gateFailures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
}
