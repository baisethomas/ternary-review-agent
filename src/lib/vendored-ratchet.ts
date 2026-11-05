import { filterReviewDiff, isReviewPathExcluded } from "./review-policy-execution";
import type { ReviewResult, SandboxResult } from "./types";

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

export function filterVendoredRatchetDiff(diff: string, owner: string, repo: string) {
  return filterReviewDiff(diff, [...vendoredRatchetExcludedPaths(owner, repo)]);
}

export function isReviewableDiff(diff: string) {
  return /(?:^|\n)diff --git /m.test(diff);
}

export function vendoredRatchetSkipResult(sandbox: SandboxResult): ReviewResult {
  return {
    verdict: "approve",
    summary: `Vendored Ratchet files skipped. No project-owned files remained for review.`,
    findings: [],
    sandbox,
    authoritativeFindings: true,
  };
}

export function skippedVendoredRatchetOnly(policyDiff: string, reviewDiff: string) {
  return isReviewableDiff(policyDiff) && !isReviewableDiff(reviewDiff);
}
