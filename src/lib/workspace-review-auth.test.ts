import { describe, expect, it } from "vitest";
import {
  authenticateWorkspaceReview,
  bearerTokenFrom,
  constantTimeEquals,
  principalIdFor,
  workspaceAuthEnv,
} from "./workspace-review-auth";

describe("constantTimeEquals", () => {
  it("accepts identical tokens", () => {
    expect(constantTimeEquals("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects different tokens of equal length", () => {
    expect(constantTimeEquals("s3cret-token", "s3cret-tokeN")).toBe(false);
  });

  it("rejects a length mismatch without throwing (timingSafeEqual would)", () => {
    expect(constantTimeEquals("short", "much-longer-token")).toBe(false);
    expect(constantTimeEquals("much-longer-token", "short")).toBe(false);
  });

  it("compares UTF-8 bytes, not code units", () => {
    expect(constantTimeEquals("tökén", "tökén")).toBe(true);
    expect(constantTimeEquals("tökén", "token")).toBe(false);
  });
});

describe("bearerTokenFrom", () => {
  it("extracts the token after the Bearer prefix", () => {
    expect(bearerTokenFrom("Bearer abc123")).toBe("abc123");
  });

  it("rejects absent, empty, and non-Bearer headers", () => {
    expect(bearerTokenFrom(null)).toBeNull();
    expect(bearerTokenFrom(undefined)).toBeNull();
    expect(bearerTokenFrom("")).toBeNull();
    expect(bearerTokenFrom("Bearer ")).toBeNull();
    expect(bearerTokenFrom("Basic abc123")).toBeNull();
    expect(bearerTokenFrom("bearer abc123")).toBeNull();
  });
});

describe("authenticateWorkspaceReview", () => {
  const env = { TERNARY_CLI_TOKEN: "current-token-value" };

  it("accepts the current token", () => {
    const result = authenticateWorkspaceReview("Bearer current-token-value", env);
    expect(result).toMatchObject({ ok: true, slot: "current" });
  });

  it("accepts the NEXT token during a rotation overlap", () => {
    const result = authenticateWorkspaceReview("Bearer next-token-value", {
      TERNARY_CLI_TOKEN: "current-token-value",
      TERNARY_CLI_TOKEN_NEXT: "next-token-value",
    });
    expect(result).toMatchObject({ ok: true, slot: "next" });
  });

  it("still accepts CURRENT while NEXT is set", () => {
    const result = authenticateWorkspaceReview("Bearer current-token-value", {
      TERNARY_CLI_TOKEN: "current-token-value",
      TERNARY_CLI_TOKEN_NEXT: "next-token-value",
    });
    expect(result).toMatchObject({ ok: true, slot: "current" });
  });

  it("rejects the old NEXT token once rotation completes and NEXT is unset", () => {
    const rotated = { TERNARY_CLI_TOKEN: "next-token-value" };
    expect(authenticateWorkspaceReview("Bearer next-token-value", rotated)).toMatchObject({ ok: true, slot: "current" });
    expect(authenticateWorkspaceReview("Bearer current-token-value", rotated)).toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });

  it("rejects an absent Authorization header", () => {
    expect(authenticateWorkspaceReview(null, env)).toEqual({ ok: false, reason: "missing_bearer" });
  });

  it("rejects a wrong token", () => {
    expect(authenticateWorkspaceReview("Bearer wrong-token-value", env)).toEqual({
      ok: false,
      reason: "token_mismatch",
    });
  });

  it("rejects an empty-string token even if the env var is empty", () => {
    expect(authenticateWorkspaceReview("Bearer anything", { TERNARY_CLI_TOKEN: "" })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("fails closed when no token is configured", () => {
    expect(authenticateWorkspaceReview("Bearer anything", {})).toEqual({ ok: false, reason: "not_configured" });
    expect(authenticateWorkspaceReview("Bearer anything", { TERNARY_CLI_TOKEN_NEXT: "only-next" })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("never accepts INTERNAL_API_TOKEN and never reads it", () => {
    const read: string[] = [];
    const env = new Proxy(
      { TERNARY_CLI_TOKEN: "current-token-value", INTERNAL_API_TOKEN: "internal-token-value" } as Record<string, string>,
      {
        get(target, key: string) {
          read.push(key);
          return target[key];
        },
      },
    );
    const result = authenticateWorkspaceReview("Bearer internal-token-value", env);
    expect(result).toEqual({ ok: false, reason: "token_mismatch" });
    expect(read).not.toContain("INTERNAL_API_TOKEN");
  });

  it("derives a stable, non-reversible principal id that is not the token", () => {
    const first = authenticateWorkspaceReview("Bearer current-token-value", env);
    const second = authenticateWorkspaceReview("Bearer current-token-value", env);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error("expected authentication to succeed");
    expect(first.principalId).toBe(second.principalId);
    expect(first.principalId).not.toContain("current-token-value");
    expect(first.principalId).toMatch(/^[0-9a-f]{32}$/);
    expect(principalIdFor("other-token")).not.toBe(first.principalId);
  });
});

describe("workspaceAuthEnv", () => {
  it("projects only the two Workspace Review token keys", () => {
    const projected = workspaceAuthEnv({
      TERNARY_CLI_TOKEN: "a",
      TERNARY_CLI_TOKEN_NEXT: "b",
      INTERNAL_API_TOKEN: "c",
    });
    expect(projected).toEqual({ TERNARY_CLI_TOKEN: "a", TERNARY_CLI_TOKEN_NEXT: "b" });
    expect(Object.keys(projected)).toEqual(["TERNARY_CLI_TOKEN", "TERNARY_CLI_TOKEN_NEXT"]);
  });
});
