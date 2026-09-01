import { describe, expect, it } from "vitest";
import { resolveSignInRedirect } from "./sign-in-redirect";

describe("resolveSignInRedirect", () => {
  it("passes through every internal dashboard page", () => {
    for (const path of ["/", "/repositories", "/analytics", "/policies"]) {
      expect(resolveSignInRedirect(path)).toBe(path);
    }
  });

  it("keeps a query string on an internal page", () => {
    expect(resolveSignInRedirect("/analytics?range=7d")).toBe("/analytics?range=7d");
  });

  it.each([
    ["an absolute http URL", "https://evil.example"],
    ["an absolute URL wearing an internal path", "https://evil.example/analytics"],
    ["a protocol-relative host", "//evil.example"],
    ["a protocol-relative host with a path", "//evil.example/policies"],
    ["a javascript: payload", "javascript:alert(document.cookie)"],
    ["a data: payload", "data:text/html,<script>alert(1)</script>"],
    ["a backslash-confused host", "/\\evil.example"],
    ["an API route", "/api/whatever"],
    ["a machine route", "/api/reviews/worker"],
    ["an unknown internal page", "/admin"],
    ["a path traversal", "/analytics/../../etc/passwd"],
    ["a fragment-smuggled target", "/analytics#@evil.example"],
    ["the empty string", ""],
  ])("falls back to / for %s", (_label, target) => {
    expect(resolveSignInRedirect(target)).toBe("/");
  });
});
