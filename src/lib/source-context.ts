/**
 * Pure source-context primitives shared by the Index Snapshot pipeline
 * (`repository-index.ts`) and Workspace Review analysis.
 *
 * Extracted from `repository-index.ts` under characterization tests (TER-37).
 * Behavior must stay byte-identical to the pre-extraction implementation; the
 * characterization suite in `repository-index.test.ts` pins it.
 */

export type SourceFileCandidate = { path: string; size: number };

export type SourceChunk = {
  path: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  content: string;
};

export type ChunkBudgets = {
  chunkLines: number;
  chunkOverlapLines: number;
};

export type CandidateBudgets = {
  maxFiles: number;
  maxFileBytes: number;
  maxSourceBytes: number;
};

export type BoundedContextBudgets = {
  maxContextChunks: number;
  maxContextChars: number;
};

const sourceExtension = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|sh|sql|ya?ml|json|toml|md)$/i;
const symbolPattern = /\b(?:class|interface|type|enum|function|def|func|const|let|var|export\s+function|export\s+class)\s+([A-Za-z_$][\w$]*)/g;
const ignoredTokens = new Set(["const", "function", "return", "export", "import", "from", "class", "interface", "this", "that", "with", "into"]);

/** True when the path looks like reviewable source (the Index Snapshot extension filter). */
export function isSourcePath(path: string) {
  return sourceExtension.test(path);
}

/** Lowercased identifier-ish tokens of length ≥ 3, minus common keywords. */
export function tokenize(value: string) {
  return new Set(value.toLowerCase().match(/[a-z_$][a-z0-9_$]{2,}/g)?.filter((token) => !ignoredTokens.has(token)) ?? []);
}

/** Declared symbol names found in a source excerpt. */
export function extractSymbols(content: string) {
  return [...content.matchAll(symbolPattern)].map((match) => match[1]);
}

/** Split file content into overlapping line-window chunks with extracted symbols. */
export function chunkSourceFile(path: string, content: string, budgets: ChunkBudgets): SourceChunk[] {
  const lines = content.split("\n");
  const chunks: SourceChunk[] = [];
  const step = Math.max(1, budgets.chunkLines - budgets.chunkOverlapLines);
  for (let start = 0; start < lines.length; start += step) {
    const chunkLines = lines.slice(start, start + budgets.chunkLines);
    if (!chunkLines.length) break;
    const chunkContent = chunkLines.join("\n");
    chunks.push({ path, startLine: start + 1, endLine: start + chunkLines.length, symbols: extractSymbols(chunkContent), content: chunkContent });
    if (start + budgets.chunkLines >= lines.length) break;
  }
  return chunks;
}

/**
 * Deterministic candidate selection: source-extension filter, per-file size cap,
 * bytewise path order, file-count cap, then a greedy total source-byte budget.
 */
export function selectCandidates<T extends SourceFileCandidate>(descriptors: T[], budgets: CandidateBudgets): T[] {
  const candidates = descriptors
    .filter((file) => isSourcePath(file.path) && file.size <= budgets.maxFileBytes)
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, budgets.maxFiles);
  let selectedBytes = 0;
  return candidates.filter((file) => {
    if (selectedBytes + file.size > budgets.maxSourceBytes) return false;
    selectedBytes += file.size;
    return true;
  });
}

/**
 * Score chunks against a query (symbol-name hits weigh 4, plain token hits 1) and
 * assemble a bounded excerpt text with `### path:start-end [symbols]` headers.
 */
export function selectBoundedContext<T extends SourceChunk>(allChunks: T[], query: string, budgets: BoundedContextBudgets) {
  const queryTokens = tokenize(query);
  const ranked = allChunks.map((chunk) => {
    const contentTokens = tokenize(`${chunk.path} ${chunk.symbols.join(" ")} ${chunk.content}`);
    let score = 0;
    for (const token of queryTokens) if (contentTokens.has(token)) score += chunk.symbols.some((symbol) => symbol.toLowerCase() === token) ? 4 : 1;
    return { chunk, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));

  const chunks: T[] = [];
  let text = "";
  for (const { chunk } of ranked) {
    if (chunks.length >= budgets.maxContextChunks) break;
    const header = `### ${chunk.path}:${chunk.startLine}-${chunk.endLine}${chunk.symbols.length ? ` [${chunk.symbols.join(", ")}]` : ""}\n`;
    const remaining = budgets.maxContextChars - text.length;
    if (remaining <= header.length) break;
    const excerpt = `${header}${chunk.content}\n`;
    text += excerpt.slice(0, remaining);
    chunks.push(chunk);
    if (text.length >= budgets.maxContextChars) break;
  }
  return { chunks, text };
}
