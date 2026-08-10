import type { ReviewFinding } from "./types";

export function findingCommentMarker(findingId: string) {
  return `<!-- ternary-finding:${findingId} -->`;
}

export function findingIdFromComment(body?: string | null) {
  return body?.match(/<!-- ternary-finding:([^>]+) -->\s*$/)?.[1]?.trim() ?? null;
}

export function formatFindingComment(finding: ReviewFinding, findingId: string) {
  const fix = finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : "";
  const location = finding.file ? `\n\nCurrent location: \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
  return `**${finding.severity} · ${finding.title}**\n\n${finding.explanation}${fix}${location}\n\n${findingCommentMarker(findingId)}`;
}
