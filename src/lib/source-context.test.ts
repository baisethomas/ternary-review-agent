import { describe, expect, it } from "vitest";
import {
  chunkSourceFile,
  extractSymbols,
  isSourcePath,
  selectBoundedContext,
  selectCandidates,
  tokenize,
} from "./source-context";

describe("source-context", () => {
  it("tokenizes identifiers of length ≥ 3 and drops keyword noise", () => {
    const tokens = tokenize("export const transferFunds = (from) => this.ab + amount");
    expect(tokens).toEqual(new Set(["transferfunds", "amount"]));
  });

  it("extracts declared symbol names", () => {
    expect(extractSymbols("export function authorize() {}\nclass Ledger {}\nconst rate = 1;")).toEqual(["authorize", "Ledger", "rate"]);
  });

  it("recognizes source paths by extension", () => {
    expect(isSourcePath("src/lib/a.ts")).toBe(true);
    expect(isSourcePath("config.yaml")).toBe(true);
    expect(isSourcePath("bin/tool.exe")).toBe(false);
    expect(isSourcePath("image.png")).toBe(false);
  });

  it("chunks content into overlapping line windows with 1-based inclusive integer bounds", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const chunks = chunkSourceFile("a.ts", content, { chunkLines: 5, chunkOverlapLines: 2 });
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([[1, 5], [4, 8], [7, 11], [10, 12]]);
    for (const chunk of chunks) {
      expect(Number.isInteger(chunk.startLine) && chunk.startLine >= 1).toBe(true);
      expect(Number.isInteger(chunk.endLine) && chunk.endLine >= chunk.startLine).toBe(true);
    }
  });

  it("selects candidates deterministically under file, size, and byte budgets", () => {
    const descriptors = [
      { path: "z.ts", size: 10 },
      { path: "a.ts", size: 10 },
      { path: "huge.ts", size: 100 },
      { path: "not-source.bin", size: 5 },
      { path: "m.ts", size: 10 },
    ];
    const selected = selectCandidates(descriptors, { maxFiles: 3, maxFileBytes: 50, maxSourceBytes: 20 });
    expect(selected.map((file) => file.path)).toEqual(["a.ts", "m.ts"]);
  });

  it("ranks symbol matches above content mentions and bounds excerpt text", () => {
    const owner = { path: "owner.ts", startLine: 1, endLine: 3, symbols: ["transferFunds"], content: "export function transferFunds() {}" };
    const mention = { path: "mention.ts", startLine: 1, endLine: 2, symbols: [], content: "// calls transferFunds somewhere" };
    const unrelated = { path: "other.ts", startLine: 1, endLine: 1, symbols: ["noop"], content: "const noop = 1;" };

    const context = selectBoundedContext([mention, owner, unrelated], "transferFunds", { maxContextChunks: 8, maxContextChars: 20_000 });
    expect(context.chunks.map((chunk) => chunk.path)).toEqual(["owner.ts", "mention.ts"]);
    expect(context.text).toContain("### owner.ts:1-3 [transferFunds]");

    const bounded = selectBoundedContext([mention, owner], "transferFunds", { maxContextChunks: 8, maxContextChars: 60 });
    expect(bounded.chunks).toHaveLength(1);
    expect(bounded.text.length).toBeLessThanOrEqual(60);
  });

  it("returns nothing when no chunk scores above zero", () => {
    const chunk = { path: "a.ts", startLine: 1, endLine: 1, symbols: [], content: "const alpha = 1;" };
    expect(selectBoundedContext([chunk], "zebra", { maxContextChunks: 8, maxContextChars: 100 })).toEqual({ chunks: [], text: "" });
  });
});
