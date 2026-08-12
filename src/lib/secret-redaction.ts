/**
 * Redact common secret material before persistence or logging.
 * Call at ledger / error / evidence boundaries — not a substitute for never storing diffs.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

export function redactSecretsTruncated(value: string, remaining: number): string {
  return redactSecrets(value).slice(0, Math.max(0, remaining));
}
