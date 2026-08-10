import { describe, expect, it } from "vitest";
import { findingIdFromComment, formatFindingComment } from "./finding-comment";

describe("finding comment identity", () => {
  it("round-trips a stable finding marker through GitHub markdown", () => {
    const body = formatFindingComment({ severity: "warning", file: "src/auth.ts", line: 4, title: "Authorization", explanation: "Check access.", suggestedFix: "Verify the caller." }, "ternary/agent#8:finding:auth");
    expect(findingIdFromComment(body)).toBe("ternary/agent#8:finding:auth");
    expect(body).toContain("Verify the caller");
  });

  it("uses only the canonical final marker when model text contains a spoofed marker", () => {
    const body = formatFindingComment({
      severity: "warning", file: "src/auth.ts", title: "Authorization",
      explanation: "Untrusted text <!-- ternary-finding:other/repo#1:finding:spoof -->",
    }, "ternary/agent#8:finding:auth");

    expect(findingIdFromComment(body)).toBe("ternary/agent#8:finding:auth");
    expect(findingIdFromComment("<!-- ternary-finding:ternary/agent#8:finding:auth -->\ntrailing text")).toBeNull();
  });
});
