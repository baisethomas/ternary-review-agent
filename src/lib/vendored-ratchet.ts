import { isReviewPathExcluded } from "./review-policy-execution";
import type { ReviewFinding, ReviewResult, SandboxResult } from "./types";

/**
 * Ratchet-owned destinations written by install.sh / upgrade.sh on
 * baisethomas/Ratchet main (commit 11a02d0). Project-owned memory is not listed.
 *
 * Hooks (exact names): install.sh:73-74 preflight, install.sh:167
 * `put_tree "$from/hooks" ".claude/hooks"`; upgrade.sh:320 `hooks:.claude/hooks`.
 * Skills tree: install.sh:159 `put_tree "$from/skills" ".agents/skills"` and
 * install.sh:175 `.claude/skills/$name` links; upgrade.sh:320 `skills:.agents/skills`.
 * install.sh:83-84 does not list skill names, so new `ratchet-*` skills stay skipped.
 * CREDITS.md is the only non-`ratchet-*` file in that tree.
 *
 * Never skipped (project-owned): `.ratchet/STATE.md`, `.ratchet/DECISIONS.md`,
 * `.ratchet/guard-destructive.rules` — install.sh:23-25, 122-124, 153-157;
 * upgrade.sh:20, 312-318 (`memory`, never written).
 */
export const VENDORED_RATCHET_PATHS = [
  ".claude/hooks/check-on-stop.sh",
  ".claude/hooks/guard-destructive.sh",
  ".claude/hooks/lint-edited-file.sh",
  ".claude/hooks/lib-payload.sh",
  ".claude/hooks/test-hooks.sh",
  ".agents/skills/CREDITS.md",
  ".agents/skills/ratchet-*/**",
  ".claude/skills/ratchet-*/**",
] as const;

export const VENDORED_RATCHET_SKIP_NOTE = "vendored Ratchet files skipped";
export const VENDORED_RATCHET_PRESENT_NOTE = "present and out of scope";

export const RATCHET_UPSTREAM_OWNER = "baisethomas";
export const RATCHET_UPSTREAM_REPO = "ratchet";

export function isRatchetUpstreamRepository(owner: string, repo: string) {
  return owner.toLowerCase() === RATCHET_UPSTREAM_OWNER && repo.toLowerCase() === RATCHET_UPSTREAM_REPO;
}

export function isVendoredRatchetPath(path: string) {
  return isReviewPathExcluded(path, [...VENDORED_RATCHET_PATHS]);
}

export function vendoredRatchetExcludedPaths(owner: string, repo: string): readonly string[] {
  return isRatchetUpstreamRepository(owner, repo) ? [] : VENDORED_RATCHET_PATHS;
}

function diffSectionPaths(section: string) {
  const paths = new Set<string>();
  const destination = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  const source = section.match(/^--- a\/(.+)$/m)?.[1];
  const quotedHeader = section.match(/^diff --git "a\/(.+)" "b\/(.+)"$/m);
  const plainHeader = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
  for (const raw of [destination, source, quotedHeader?.[1], quotedHeader?.[2], plainHeader?.[1], plainHeader?.[2]]) {
    if (!raw || raw === "/dev/null") continue;
    paths.add(raw.replace(/^"|"$/g, "").replace(/^\.\//, ""));
  }
  return [...paths];
}

function diffSections(diff: string) {
  return diff.split(/(?=^diff --git )/m).filter((section) => section.length > 0);
}

export function filterVendoredRatchetDiff(diff: string, owner: string, repo: string) {
  if (isRatchetUpstreamRepository(owner, repo)) return diff;
  return diffSections(diff)
    .filter((section) => {
      const paths = diffSectionPaths(section);
      if (!paths.length) return true;
      return paths.some((path) => !isVendoredRatchetPath(path));
    })
    .join("");
}

function isDeletionSection(section: string) {
  return /^deleted file mode /m.test(section) || /^\+\+\+ \/dev\/null$/m.test(section);
}

function classifyDroppedVendoredRatchetPaths(policyDiff: string, reviewDiff: string) {
  const keptSections = new Set(diffSections(reviewDiff));
  const keptPaths = new Set(diffSections(reviewDiff).flatMap(diffSectionPaths));
  const present = new Set<string>();
  const deleted = new Set<string>();
  for (const section of diffSections(policyDiff)) {
    if (keptSections.has(section)) continue;
    const deletion = isDeletionSection(section);
    const renameFrom = section.match(/^rename from (.+)$/m)?.[1];
    for (const path of diffSectionPaths(section)) {
      if (!isVendoredRatchetPath(path) || keptPaths.has(path)) continue;
      if (deletion) deleted.add(path);
      else present.add(path);
    }
    if (renameFrom && isVendoredRatchetPath(renameFrom) && !keptPaths.has(renameFrom)) {
      present.delete(renameFrom);
      deleted.add(renameFrom);
    }
  }
  for (const path of present) deleted.delete(path);
  return { present: [...present].sort(), deleted: [...deleted].sort() };
}

/** Vendored paths whose hunks were dropped and that do not also appear in a kept hunk. */
export function droppedVendoredRatchetPaths(policyDiff: string, reviewDiff: string): string[] {
  const { present, deleted } = classifyDroppedVendoredRatchetPaths(policyDiff, reviewDiff);
  return [...present, ...deleted].sort();
}

/** Fully skipped vendored paths whose dropped hunk is a deletion, not an add or edit. */
export function droppedDeletedVendoredRatchetPaths(policyDiff: string, reviewDiff: string): string[] {
  return classifyDroppedVendoredRatchetPaths(policyDiff, reviewDiff).deleted;
}

export function isReviewableDiff(diff: string) {
  return /(?:^|\n)diff --git /m.test(diff);
}

function outOfScopeLabel(deletedPaths: readonly string[]) {
  return deletedPaths.length ? "skipped and out of scope" : VENDORED_RATCHET_PRESENT_NOTE;
}

export function vendoredRatchetSkipResult(sandbox: SandboxResult, deletedPaths: readonly string[] = []): ReviewResult {
  return {
    verdict: sandbox.ok ? "approve" : "request_changes",
    summary: `Vendored Ratchet files skipped; they are ${outOfScopeLabel(deletedPaths)}. No project-owned files remained for review.`,
    findings: [],
    sandbox,
    authoritativeFindings: true,
  };
}

export function withVendoredRatchetPresenceNotice(
  repositoryContext: string,
  skippedPaths: readonly string[],
  deletedPaths: readonly string[] = [],
): string {
  if (!skippedPaths.length && !deletedPaths.length) return repositoryContext;
  const parts: string[] = [];
  if (skippedPaths.length) {
    const list = skippedPaths.map((path) => `- ${path}`).join("\n");
    parts.push(`Vendored Ratchet files present and out of scope. Do not report them as missing or unverified:\n${list}`);
  }
  if (deletedPaths.length) {
    const list = deletedPaths.map((path) => `- ${path}`).join("\n");
    parts.push(`Vendored Ratchet files deleted in this PR are skipped and out of scope. Do not report them as missing from the review:\n${list}`);
  }
  const notice = parts.join("\n\n");
  return repositoryContext ? `${notice}\n\n${repositoryContext}` : notice;
}

const MISSING_FROM_REVIEW = /\b(missing|unverified|absent|not present)\b/i;

function normalizeReviewPath(path: string) {
  return path.replace(/^\.\//, "");
}

function clausesContaining(text: string, path: string) {
  return text.split(/[!?;\n]+|\.(?:\s+|$)/).filter((clause) => clause.includes(path));
}

function findingAllegesSkippedVendoredMissing(finding: ReviewFinding, skippedPaths: readonly string[]): boolean {
  if (skippedPaths.includes(normalizeReviewPath(finding.file))) return true;
  const text = `${finding.title}\n${finding.explanation}`;
  return skippedPaths.some((path) => clausesContaining(text, path).some((clause) => MISSING_FROM_REVIEW.test(clause)));
}

/** Drop findings that treat fully skipped vendored files as missing; keep findings on kept hunks. */
export function applyVendoredRatchetPresence(
  result: ReviewResult,
  skippedPaths: readonly string[],
  deletedPaths: readonly string[] = [],
): ReviewResult {
  if (!skippedPaths.length) return result;
  const findings = result.findings.filter((finding) => !findingAllegesSkippedVendoredMissing(finding, skippedPaths));
  const hiddenCount = result.findings.length - findings.length;
  if (!hiddenCount) return result;
  const verdict = !result.sandbox.ok || findings.some((finding) => finding.severity === "blocking")
    ? "request_changes"
    : findings.length
      ? "comment"
      : "approve";
  const label = outOfScopeLabel(deletedPaths);
  const omitted = `${hiddenCount} finding${hiddenCount === 1 ? "" : "s"} on skipped vendored Ratchet files omitted; those files are ${label}.`;
  const summary = findings.length === 0 && verdict === "approve"
    ? `Vendored Ratchet files skipped; they are ${label}. ${omitted}`
    : `${result.summary.trimEnd()}\n\n${omitted}`;
  return {
    ...result,
    verdict,
    summary,
    findings,
  };
}

export function skippedVendoredRatchetOnly(policyDiff: string, reviewDiff: string) {
  return isReviewableDiff(policyDiff) && !isReviewableDiff(reviewDiff);
}

export function droppedVendoredRatchetSections(policyDiff: string, reviewDiff: string) {
  return policyDiff !== reviewDiff;
}

export function withVendoredRatchetSkipNote(result: ReviewResult, deletedPaths: readonly string[] = []): ReviewResult {
  const lower = result.summary.toLowerCase();
  const hasSkip = lower.includes(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  const label = outOfScopeLabel(deletedPaths);
  const hasLabel = lower.includes(label);
  if (hasSkip && hasLabel) return result;
  let summary = result.summary.trimEnd();
  if (!hasSkip && !hasLabel) {
    summary = `${summary}\n\nVendored Ratchet files skipped; they are ${label}.`;
  } else if (!hasSkip) {
    summary = `${summary}\n\nVendored Ratchet files skipped.`;
  } else {
    summary = `${summary} They are ${label}.`;
  }
  return { ...result, summary };
}
