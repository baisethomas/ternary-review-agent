import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsTruncated } from "./secret-redaction";

describe("secret-redaction", () => {
  it("redacts GitHub tokens, OpenAI-style keys, and Authorization Bearer values", () => {
    const input = [
      "token ghp_abcdefghijklmnopqrstuvwxyz12",
      "pat github_pat_abcdefghijklmnopqrstuvwxyz12",
      "key sk-abcdefghijklmnopqrstuvwxyz12",
      "Authorization: Bearer secret-token",
      "authorization:bearer other-secret",
    ].join("\n");

    expect(redactSecrets(input)).toBe(
      [
        "token [REDACTED]",
        "pat [REDACTED]",
        "key [REDACTED]",
        "Authorization: Bearer [REDACTED]",
        "authorization:bearer [REDACTED]",
      ].join("\n"),
    );
  });

  it("leaves ordinary text unchanged", () => {
    expect(redactSecrets("exit code 0\nok")).toBe("exit code 0\nok");
  });

  it("truncates after redaction so secrets cannot hide past the budget", () => {
    const value = `prefix Authorization: Bearer ${"x".repeat(40)} trailing`;
    const redacted = redactSecretsTruncated(value, 40);
    expect(redacted.length).toBe(40);
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).not.toContain("xxxxx");
    expect(redactSecretsTruncated("hello", -5)).toBe("");
  });
});
