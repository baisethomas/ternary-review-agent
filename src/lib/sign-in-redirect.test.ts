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

  it("returns a string rebuilt from the validated path, not the caller's target", () => {
    // A trailing "?" is the case where verbatim and rebuilt differ: the separator
    // is present but the query is empty, so the canonical form drops it.
    expect(resolveSignInRedirect("/policies?")).toBe("/policies");
  });

  it("splits on the first ? only, so a nested redirect stays inside the query", () => {
    // The path is what gets validated; the query is re-attached untouched. Nothing
    // in the app reads a nested `redirect_url` — grep for it finds only the one
    // parameter access-gate.tsx writes — so a hostile value parked here is inert,
    // and Clerk's own origin check (isAllowedRedirect) is the layer that sees it.
    const target = "/policies?redirect_url=//evil.example";
    expect(resolveSignInRedirect(target)).toBe("/policies?redirect_url=//evil.example");
  });

  it.each([
    ["an absolute http URL", "https://evil.example"],
    ["an absolute URL wearing an internal path", "https://evil.example/analytics"],
    ["a protocol-relative host", "//evil.example"],
    ["a protocol-relative host with a path", "//evil.example/policies"],
    ["a protocol-relative host carrying a query", "//evil.example?x=1"],
    ["a percent-encoded protocol-relative host", "/%2F%2Fevil"],
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
