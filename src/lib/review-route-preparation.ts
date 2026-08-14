import type { SandboxResult } from "./types";
import type { ReviewRouteConfig } from "./review-route-config";

export type ReviewRiskLevel = "low" | "standard" | "high";

export type ReviewRoutePreparation = {
  diffBytes: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  languages: string[];
  riskSignals: string[];
  riskFloor: ReviewRiskLevel;
  sandboxFailed: boolean;
};

const riskPathPatterns: Array<{ id: string; pattern: RegExp }> = [
  { id: "migrations", pattern: /(?:^|\/)migrations?\//i },
  { id: "auth", pattern: /(?:^|\/)(?:auth|authentication|authorization)(?:\/|$)/i },
  { id: "security", pattern: /(?:^|\/)(?:security|secrets?|credentials?)(?:\/|$)/i },
  { id: "webhook", pattern: /(?:^|\/)webhook(?:s)?(?:\/|$)/i },
  { id: "api-route", pattern: /(?:^|\/)api(?:\/|$)/i },
  { id: "dependency-manifest", pattern: /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|go\.mod|Cargo\.toml)$/i },
  { id: "concurrency", pattern: /(?:^|\/)(?:queue|worker|redis|lock|mutex)(?:\/|$)/i },
];

function effectiveDiffPath(section: string) {
  const destination = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  if (destination) return destination.replace(/^"|"$/g, "");
  const source = section.match(/^--- a\/(.+)$/m)?.[1];
  if (source) return source.replace(/^"|"$/g, "");
  const quotedHeader = section.match(/^diff --git "a\/(.+)" "b\/(.+)"$/m);
  const plainHeader = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
  return quotedHeader?.[2] ?? plainHeader?.[2];
}

function languageFromPath(path: string) {
  const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension) return "other";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    swift: "swift",
    sql: "sql",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
  };
  return map[extension] ?? extension;
}

function countDiffLines(diff: string) {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    else if (line.startsWith("-")) linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

function collectChangedPaths(diff: string) {
  const paths = new Set<string>();
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const path = effectiveDiffPath(section);
    if (path && path !== "/dev/null") paths.add(path);
  }
  return [...paths];
}

function detectRiskSignals(paths: string[], lineCount: number, fileCount: number, config: ReviewRouteConfig) {
  const signals: string[] = [];
  for (const path of paths) {
    for (const rule of riskPathPatterns) {
      if (rule.pattern.test(path) && !signals.includes(rule.id)) signals.push(rule.id);
    }
  }
  if (lineCount >= config.largeDiffLineThreshold) signals.push("large-diff-lines");
  if (fileCount >= config.largeDiffFileThreshold) signals.push("large-diff-files");
  return signals;
}

function resolveRiskFloor(signals: string[], sandboxFailed: boolean): ReviewRiskLevel {
  if (sandboxFailed) return "high";
  const highSignals = new Set(["migrations", "auth", "security", "webhook", "api-route", "concurrency"]);
  if (signals.some((signal) => highSignals.has(signal))) return "high";
  if (signals.length > 0) return "standard";
  return "low";
}

/** Diff-only signals for pre-sandbox decisions such as slim sandbox (no sandbox evidence yet). */
export function prepareReviewRouteFromDiff(
  diff: string,
  config: ReviewRouteConfig,
): ReviewRoutePreparation {
  const preSandbox: SandboxResult = {
    ok: true,
    commands: [],
    durationMs: 0,
    sandboxId: "pre-sandbox",
  };
  return prepareReviewRoute(diff, preSandbox, config);
}

export function prepareReviewRoute(
  diff: string,
  sandbox: SandboxResult,
  config: ReviewRouteConfig,
): ReviewRoutePreparation {
  const paths = collectChangedPaths(diff);
  const { linesAdded, linesRemoved } = countDiffLines(diff);
  const lineCount = linesAdded + linesRemoved;
  const riskSignals = detectRiskSignals(paths, lineCount, paths.length, config);
  const sandboxFailed = !sandbox.ok;
  if (sandboxFailed && !riskSignals.includes("sandbox-failed")) riskSignals.unshift("sandbox-failed");
  const languages = [...new Set(paths.map(languageFromPath))].sort();
  return {
    diffBytes: Buffer.byteLength(diff, "utf8"),
    filesChanged: paths.length,
    linesAdded,
    linesRemoved,
    languages,
    riskSignals,
    riskFloor: resolveRiskFloor(riskSignals, sandboxFailed),
    sandboxFailed,
  };
}
