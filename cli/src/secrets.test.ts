import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isKeyMaterialContent,
  keyMaterialRule,
  redactSecretSpans,
  shannonEntropy,
} from "./secrets.js";

// Every pattern gets a positive case AND a negative case. The negative cases
// are deliberately realistic code — hashes, UUIDs, public keys, lockfile
// integrity fields, ordinary URLs — because a heuristic that redacts those
// makes reviews useless.

describe("withholding rules (deny class 2)", () => {
  it("detects PEM private key armor of every flavor", () => {
    for (const armor of [
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    ]) {
      expect(keyMaterialRule(`prefix\n${armor}\nbody`), armor).toBe("key.pem-private");
    }
  });

  it("detects PuTTY keys, GCP service accounts, and raw openssh blobs", () => {
    expect(keyMaterialRule("PuTTY-User-Key-File-2: ssh-rsa\n")).toBe("key.putty-ppk");
    expect(
      keyMaterialRule('{\n  "type": "service_account",\n  "private_key_id": "abc"\n}'),
    ).toBe("key.gcp-service-account");
    expect(keyMaterialRule("openssh-key-v1\0\x00\x00")).toBe("key.openssh-encrypted");
  });

  it("does NOT withhold public key material or certificates", () => {
    expect(isKeyMaterialContent("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----")).toBe(
      false,
    );
    expect(isKeyMaterialContent("-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----")).toBe(
      false,
    );
    expect(isKeyMaterialContent("-----BEGIN PGP PUBLIC KEY BLOCK-----")).toBe(false);
    expect(isKeyMaterialContent("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host\n")).toBe(false);
    expect(isKeyMaterialContent('{ "type": "module", "private": true }')).toBe(false);
  });
});

describe("redaction rules (deny class 4)", () => {
  function redactedRules(text: string): string[] {
    return redactSecretSpans(text).spans.map((s) => s.rule);
  }

  it("redacts known token prefixes (server parity)", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const { text, spans } = redactSecretSpans(`const t = "${token}";`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED]");
    expect(spans).toEqual([{ rule: "token.known-prefix", count: 1 }]);
  });

  it("redacts Authorization: Bearer values (server parity)", () => {
    const { text } = redactSecretSpans("Authorization: Bearer abc.def.ghi");
    expect(text).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts AWS access key ids but not lookalike constants", () => {
    const { text, spans } = redactSecretSpans("id = AKIAIOSFODNN7EXAMPLE");
    expect(text).toBe("id = [REDACTED]");
    expect(spans).toEqual([{ rule: "token.aws-access-key-id", count: 1 }]);
    // Negative: a 20-char uppercase identifier without an AWS prefix.
    expect(redactedRules("const HEADERNAMEXXXXXXXXXX = 1;")).toEqual([]);
  });

  it("redacts AWS secret access keys in assignment context only", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(secret).toHaveLength(40);
    const { text, spans } = redactSecretSpans(`aws_secret_access_key = ${secret}`);
    expect(text).not.toContain(secret);
    expect(spans.map((s) => s.rule)).toContain("token.aws-secret-access-key");
    // Negative: a 40-char hex sha1 in a non-secret context stays intact.
    const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    expect(redactSecretSpans(`const headSha = "${sha1}";`).text).toContain(sha1);
  });

  it("redacts Slack tokens but not slack URLs or channel names", () => {
    const { text, spans } = redactSecretSpans("token: xoxb-1234567890-abcdefghijklmn");
    expect(text).toBe("token: [REDACTED]");
    expect(spans).toEqual([{ rule: "token.slack", count: 1 }]);
    expect(redactedRules("https://slack.com/api/chat.postMessage in #eng-releases")).toEqual([]);
  });

  it("redacts JWTs but not base64 blobs or dotted identifiers", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const { text, spans } = redactSecretSpans(`const t = "${jwt}";`);
    expect(text).not.toContain(jwt);
    expect(spans).toEqual([{ rule: "token.jwt", count: 1 }]);
    // Negative: a lockfile integrity hash and a dotted package path.
    expect(
      redactedRules('"integrity": "sha512-M2mJZrbcOG6bkPo/CFrctVtRLXsxDIu0DWvAOtLPqLTPCVoMGGkjMcVpxmVAPzoqcvBIzHm9YtWD/mV0PDbNaA=="'),
    ).toEqual([]);
    expect(redactedRules("import { a } from '@scope/pkg.sub.mod';")).toEqual([]);
  });

  it("redacts passwords embedded in connection strings, keeping the host", () => {
    const { text, spans } = redactSecretSpans(
      "DATABASE_URL=postgres://app_user:hunter2hunter2@db.internal:5432/app",
    );
    expect(text).toContain("postgres://app_user:[REDACTED]@db.internal:5432/app");
    expect(spans.map((s) => s.rule)).toContain("token.connection-string-password");
    // Negative: credential-free URLs are untouched.
    expect(redactedRules("see https://example.com:8443/docs and postgres://localhost:5432/db")).toEqual(
      [],
    );
  });

  it("redacts high-entropy assignments to secret-shaped names", () => {
    const value = "S3cr3tV4lue-9fJq2Lm8Xz1Kd0Pw";
    const { text, spans } = redactSecretSpans(`CLIENT_SECRET=${value}`);
    expect(text).toBe("CLIENT_SECRET=[REDACTED]");
    expect(spans).toEqual([{ rule: "secret.high-entropy-assignment", count: 1 }]);
  });

  it("does NOT redact low-entropy, placeholder, or short secret-name values", () => {
    for (const line of [
      'API_KEY = process.env.TERNARY_API_KEY',
      'const apiKeyHeader = "x-api-key";',
      'PASSWORD = "changeme"',
      'ACCESS_TOKEN: "<your-token-here>"',
      'API_KEY="${API_KEY}"',
      'SECRET_NAME = "ternary-review-secret"',
      'AUTH_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaa"',
      'TOKEN_TYPE = "bearer"',
    ]) {
      expect(redactedRules(line), line).toEqual([]);
    }
  });

  it("does NOT redact realistic non-secret code (hashes, UUIDs, public keys)", () => {
    const corpus = [
      'const requestId = "550e8400-e29b-41d4-a716-446655440000";',
      'const digest = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";',
      '"resolved": "https://registry.npmjs.org/vitest/-/vitest-3.2.7.tgz"',
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 user@example.com",
      "export function computeFindingKey(ruleId: string, path: string): string {",
      "const MAX_DIFF_CHARS = 160000;",
    ].join("\n");
    const { text, spans } = redactSecretSpans(corpus);
    expect(spans).toEqual([]);
    expect(text).toBe(corpus);
  });

  it("counts every occurrence per rule and leaves clean text byte-identical", () => {
    const two = `ghp_${"a".repeat(30)} and ghp_${"b".repeat(30)}`;
    expect(redactSecretSpans(two).spans).toEqual([{ rule: "token.known-prefix", count: 2 }]);
    const clean = "export const ok = 1;\n";
    expect(redactSecretSpans(clean)).toEqual({ text: clean, spans: [] });
  });
});

describe("false-positive rate on a real codebase", () => {
  // The collector's own source is a realistic corpus: TypeScript with regexes,
  // hex constants, base64 examples, URLs, and secret-shaped identifier names.
  // Any redaction here would be a false positive, and false positives are the
  // cost side of these heuristics — so the budget is zero.
  it("redacts nothing in the collector's own source", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const offenders: Array<{ file: string; rules: string[] }> = [];
    let files = 0;
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      files += 1;
      const { spans } = redactSecretSpans(readFileSync(join(srcDir, name), "utf8"));
      // The test files deliberately contain sample credentials; only the
      // modules themselves must be clean.
      if (spans.length > 0 && !name.endsWith(".test.ts")) {
        offenders.push({ file: name, rules: spans.map((s) => s.rule) });
      }
    }
    expect(files).toBeGreaterThan(8);
    expect(offenders).toEqual([]);
  });
});

describe("shannonEntropy", () => {
  it("scores repeated characters at zero and random-looking strings high", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("S3cr3tV4lue-9fJq2Lm8Xz1Kd0Pw")).toBeGreaterThan(3.0);
    expect(shannonEntropy("changeme")).toBeLessThan(3.0);
  });
});
