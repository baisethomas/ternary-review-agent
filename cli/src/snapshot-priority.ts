// Snapshot content priority (TER-43).
//
// The `--all` snapshot budget (spec 4.4: 400,000 bytes / 500 files) used to be
// spent in bytewise path order, which is alphabetical order wearing a costume:
// a workspace whose docs and config sort early exhausts the budget before the
// walk ever reaches source. Measured live in dogfood §8.11 — a 513 KB
// swift-app `--all` payload carried 47 content entries and *zero* Swift
// or JavaScript files, so the review had nothing but prose to reason about.
//
// This module ranks paths into four tiers — application source, then
// config/manifests (lockfiles demoted, they are generated noise), then docs,
// then everything else — and orders bytewise inside each tier so the result is
// still deterministic.
//
// Invariant: priority governs snapshot *content selection* and the order of
// the `snapshot` array ONLY. The manifest's bytewise ordering contract
// (spec 7.2) is untouched — the manifest still lists every path in bytewise
// order, and the payload digest depends on that ordering.
//
// The `snapshot` array order matters beyond presentation: the server re-applies
// its own caps in the order the array arrives (src/lib/workspace-review-route.ts),
// so leading with source protects source files from that second pass too.

import { comparePathsBytewise } from "./payload.js";

// Tier 0: application source, by lowercased extension.
const SOURCE_EXTENSIONS = new Set([
  "swift", "m", "mm", "kt", "kts", "java",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs",
  "c", "h", "cc", "cpp", "hpp", "cs",
  "php", "sql", "sh", "bash", "zsh",
  "vue", "svelte", "scala", "dart",
  "ex", "exs", "lua", "pl", "r", "ps1",
]);

// Tier 1: configuration and manifests.
const CONFIG_EXTENSIONS = new Set([
  "json", "yaml", "yml", "toml", "xml", "gradle", "plist", "ini", "cfg",
]);
const CONFIG_BASENAMES = new Set(["dockerfile", "makefile"]);

// Lockfiles are machine-generated dependency ledgers: config-shaped, but worth
// less review attention than anything a human wrote. Demoted to tier 3.
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "cargo.lock",
  "gemfile.lock",
  "bun.lockb",
]);

// Tier 2: documentation.
const DOC_EXTENSIONS = new Set(["md", "txt", "rst", "adoc"]);

export function snapshotPriorityTier(path: string): 0 | 1 | 2 | 3 {
  const slash = path.lastIndexOf("/");
  const base = slash < 0 ? path : path.slice(slash + 1);
  const lowerBase = base.toLowerCase();
  if (LOCKFILE_BASENAMES.has(lowerBase)) return 3;
  // A leading dot is not an extension separator: `.gitignore` has no extension.
  const dot = lowerBase.lastIndexOf(".");
  const ext = dot <= 0 ? "" : lowerBase.slice(dot + 1);
  if (ext !== "" && SOURCE_EXTENSIONS.has(ext)) return 0;
  if (ext !== "" && CONFIG_EXTENSIONS.has(ext)) return 1;
  if (CONFIG_BASENAMES.has(lowerBase)) return 1;
  if (ext !== "" && DOC_EXTENSIONS.has(ext)) return 2;
  return 3;
}

// Total order: tier first, then the bytewise path order used everywhere else
// in the collector, so selection stays deterministic across platforms.
export function compareSnapshotPriority(a: string, b: string): number {
  const tierDelta = snapshotPriorityTier(a) - snapshotPriorityTier(b);
  if (tierDelta !== 0) return tierDelta;
  return comparePathsBytewise(a, b);
}
