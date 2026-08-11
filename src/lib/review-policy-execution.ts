function globExpression(pattern: string) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function diffPaths(section: string) {
  const paths = [section.match(/^\+\+\+ b\/(.+)$/m)?.[1], section.match(/^--- a\/(.+)$/m)?.[1]].filter((path): path is string => Boolean(path));
  const quotedHeader = section.match(/^diff --git "a\/(.+)" "b\/(.+)"$/m);
  const plainHeader = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
  if (quotedHeader) paths.push(quotedHeader[1], quotedHeader[2]);
  if (plainHeader) paths.push(plainHeader[1], plainHeader[2]);
  return paths.map((path) => path.replace(/^"|"$/g, ""));
}

export function filterReviewDiff(diff: string, excludedPaths: string[]) {
  if (!excludedPaths.length) return diff;
  const expressions = excludedPaths.map((pattern) => globExpression(pattern.replace(/^\.\//, "")));
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const paths = diffPaths(section);
      return !paths.some((path) => expressions.some((expression) => expression.test(path)));
    })
    .join("");
}

export function isReviewPathExcluded(path: string, excludedPaths: string[]) {
  const normalized = path.replace(/^\.\//, "");
  return excludedPaths.some((pattern) => globExpression(pattern.replace(/^\.\//, "")).test(normalized));
}

export function applyReviewPolicyToResult(result: ReviewResult, policy: ResolvedReviewPolicy): ReviewResult {
  const minimum = reviewSeverities.indexOf(policy.minimumSeverity);
  const findings = result.findings.filter((finding) => reviewSeverities.indexOf(finding.severity) >= minimum && !isReviewPathExcluded(finding.file, policy.excludedPaths));
  const hiddenCount = result.findings.length - findings.length;
  const verdict = !result.sandbox.ok || findings.some((finding) => finding.severity === "blocking")
    ? "request_changes"
    : findings.length
      ? "comment"
      : "approve";
  return {
    ...result,
    verdict,
    summary: hiddenCount
      ? `${result.summary}\n\nPolicy omitted ${hiddenCount} finding${hiddenCount === 1 ? "" : "s"} based on the ${policy.minimumSeverity} severity threshold and excluded-path settings.`
      : result.summary,
    findings,
  };
}
import type { ResolvedReviewPolicy } from "./review-policy";
import { reviewSeverities } from "./review-policy";
import type { ReviewResult } from "./types";
