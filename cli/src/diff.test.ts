import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("returns an empty string for identical inputs", () => {
    expect(unifiedDiff("a.ts", "same\n", "same\n")).toBe("");
  });

  it("emits headers without timestamps or index lines", () => {
    const patch = unifiedDiff("src/a.ts", "one\ntwo\n", "one\nTWO\n");
    expect(patch.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@ ")).toBe(true);
    expect(patch).not.toMatch(/index [0-9a-f]+\.\.[0-9a-f]+/);
    expect(patch).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("represents a middle-line change with context", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const next = "a\nb\nc\nD\ne\nf\ng\nh\n";
    const patch = unifiedDiff("f.txt", base, next);
    expect(patch).toContain("-d");
    expect(patch).toContain("+D");
    expect(patch).toContain(" c");
    expect(patch).toContain(" e");
    // Only one hunk for one change region.
    expect(patch.match(/@@/g)).toHaveLength(2);
  });

  it("is deterministic", () => {
    const base = "l1\nl2\nl3\n";
    const next = "l1\nl2 changed\nl3\nl4\n";
    expect(unifiedDiff("p", base, next)).toBe(unifiedDiff("p", base, next));
  });

  it("marks missing trailing newlines", () => {
    const patch = unifiedDiff("f.txt", "line\n", "line");
    expect(patch).toContain("\\ No newline at end of file");
  });

  it("handles additions from empty base", () => {
    const patch = unifiedDiff("f.txt", "", "new\n");
    expect(patch).toContain("+new");
  });
});
