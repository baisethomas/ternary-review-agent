// Content-based secret detection (spec 4.2 deny classes 2 and 4).
//
// Two kinds of rule live here:
//
//   * Withholding rules — content that makes the WHOLE file untransmittable
//     (deny class 2: private key material, keystore/service-account blobs).
//     The file contributes zero content bytes; only a redaction record.
//   * Redaction rules — token-shaped spans inside an otherwise transmittable
//     file (deny class 4). The span is replaced with [REDACTED] and the rule
//     id plus a count are recorded in the payload's redaction metadata.
//
// The first two redaction rules are byte-for-byte parity with the server's
// src/lib/secret-redaction.ts (spec 4.3 defense in depth); the rest are
// client-only heuristics, because the client boundary is the real control.
//
// Design bias: over-redaction costs review quality, under-redaction leaks a
// credential. Every ambiguous case resolves toward redacting.
//
// Pure module: no filesystem, no git, no network.

// --- Withholding rules (deny class 2) ---

const WITHHOLD_RULES: Array<{ rule: string; test: (text: string) => boolean }> = [
  {
    // PEM armor for private key material of any flavor: RSA, EC, DSA,
    // OPENSSH, ENCRYPTED, PGP ("PRIVATE KEY BLOCK"), plain PKCS#8.
    rule: "key.pem-private",
    test: (text) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/.test(text),
  },
  {
    // PuTTY private keys carry no PEM armor.
    rule: "key.putty-ppk",
    test: (text) => /^PuTTY-User-Key-File-\d/m.test(text),
  },
  {
    // GCP service-account JSON: the private_key member is the payload, but
    // the pair of markers identifies the file even if the key is elsewhere.
    rule: "key.gcp-service-account",
    test: (text) =>
      /"type"\s*:\s*"service_account"/.test(text) && /"private_key(_id)?"\s*:/.test(text),
  },
  {
    // OpenSSH private keys written without armor (rare) and ssh-agent dumps.
    rule: "key.openssh-encrypted",
    test: (text) => text.startsWith("openssh-key-v1\0"),
  },
];

/** The withholding rule a file's content matches, or null. */
export function keyMaterialRule(text: string): string | null {
  for (const { rule, test } of WITHHOLD_RULES) {
    if (test(text)) return rule;
  }
  return null;
}

/** Convenience predicate over {@link keyMaterialRule}. */
export function isKeyMaterialContent(text: string): boolean {
  return keyMaterialRule(text) !== null;
}

// --- Redaction rules (deny class 4) ---

interface RedactionRule {
  rule: string;
  pattern: RegExp; // must be global
  // Replacement receives the match and its capture groups. When a rule
  // captures a value, only the captured value is replaced, so surrounding
  // code (the assignment, the URL host) stays reviewable.
  replace: (match: string, groups: (string | undefined)[]) => string;
}

const PLACEHOLDER =
  /^(?:process\.env|import\.meta|\$\{|<|\[|your[-_]|my[-_]|example|changeme|change_me|placeholder|dummy|fake|sample|test[-_]|xxx+|todo|none|null|undefined|redacted|\*+$)/i;

const REPEATED_CHAR = /^(.)\1*$/;

// Hyphen/underscore-joined lowercase words ("ternary-review-secret",
// "prod_database_password_key") are identifiers, not credentials. Excluding
// them costs a real false negative (a passphrase-style secret written that
// way is not redacted) and buys a large drop in false positives on config
// and code; the file-class deny list, not this heuristic, is the control for
// files that hold credentials.
const WORDY_IDENTIFIER = /^[a-z]{2,}(?:[-_.][a-z]{2,})+$/;

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Entropy floor for the generic assignment heuristic. Chosen so that
// dictionary words, kebab-case identifiers, and repeated placeholder text
// stay below it while real 20+ char credentials (mixed case, digits, base64)
// sit comfortably above it.
const MIN_ASSIGNMENT_ENTROPY = 3.0;

function looksLikeSecretValue(value: string): boolean {
  if (value.length < 20) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (REPEATED_CHAR.test(value)) return false;
  if (WORDY_IDENTIFIER.test(value)) return false;
  return shannonEntropy(value) >= MIN_ASSIGNMENT_ENTROPY;
}

// Rules run in this fixed order; ordering is part of the deny rules version
// because it determines the recorded rule ids for overlapping matches.
const REDACTION_RULES: RedactionRule[] = [
  {
    // Parity with src/lib/secret-redaction.ts.
    rule: "token.known-prefix",
    pattern:
      /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // Parity with src/lib/secret-redaction.ts.
    rule: "token.authorization-bearer",
    pattern: /(authorization\s*:\s*bearer\s+)([^\s"']+)/gi,
    replace: (_m, g) => `${g[0] ?? ""}[REDACTED]`,
  },
  {
    // AWS access key ids: a fixed set of four-letter prefixes plus 16 chars.
    rule: "token.aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[A-Z0-9]{16}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // AWS secret access keys have no prefix, so they are only recognizable in
    // assignment context: 40 chars of base64 alphabet after a known key name.
    rule: "token.aws-secret-access-key",
    pattern:
      /((?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi,
    replace: (_m, g) => `${g[0] ?? ""}[REDACTED]`,
  },
  {
    // Slack tokens (bot, user, app, refresh, legacy) and webhook URLs.
    rule: "token.slack",
    pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // JWTs: a base64url header that decodes from '{"' (always "eyJ"), plus
    // payload and signature segments.
    rule: "token.jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // Connection strings with an embedded password: scheme://user:pass@host.
    // Only the password is replaced — the host stays reviewable.
    rule: "token.connection-string-password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)([^\s@/"']+)(@)/gi,
    replace: (_m, g) => `${g[0] ?? ""}[REDACTED]${g[2] ?? ""}`,
  },
  {
    // Generic high-entropy assignment to a secret-shaped name. The entropy
    // gate keeps identifiers, placeholders, and prose out.
    rule: "secret.high-entropy-assignment",
    pattern:
      /([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{20,})/g,
    replace: (match, g) => {
      const value = g[2] ?? "";
      if (!looksLikeSecretValue(value)) return match;
      return `${g[0] ?? ""}${g[1] ?? ""}[REDACTED]`;
    },
  },
];

export interface RedactionOutcome {
  text: string;
  spans: Array<{ rule: string; count: number }>;
}

/**
 * Replace every recognized secret span with [REDACTED], returning the rule
 * ids and per-rule counts for the payload's redaction metadata. Deterministic:
 * rules run in declaration order and counts are exact.
 */
export function redactSecretSpans(text: string): RedactionOutcome {
  let out = text;
  const spans: Array<{ rule: string; count: number }> = [];
  for (const { rule, pattern, replace } of REDACTION_RULES) {
    let count = 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      // trailing args are offset, whole string, and (never here) groups object
      const groups = args.slice(1, -2) as (string | undefined)[];
      const replaced = replace(match, groups);
      if (replaced !== match) count += 1;
      return replaced;
    });
    if (count > 0) spans.push({ rule, count });
  }
  return { text: out, spans };
}
