// Pure unified-diff generation for ChangesetEntry.patch (spec 8.2).
// Deterministic Myers O(ND) line diff; no timestamps, no index lines.
// Falls back to a whole-file replace hunk when inputs are pathologically
// large, which stays a valid (and recorded-in-size) unified diff.

const MAX_TOTAL_LINES = 20_000;
const CONTEXT = 3;

type Op = { tag: " " | "-" | "+"; line: string };

export function unifiedDiff(path: string, baseText: string, newText: string): string {
  if (baseText === newText) return "";
  const a = splitLines(baseText);
  const b = splitLines(newText);
  const ops = a.length + b.length > MAX_TOTAL_LINES ? replaceAll(a, b) : myersDiff(a, b);
  const hunks = buildHunks(ops);
  if (hunks.length === 0) return "";
  return `--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
}

// Lines KEEP their terminating "\n" so that a missing trailing newline is a
// real content difference (spec 8.3: source contents are never silently
// normalized). A line without "\n" can only be the last line of its file and
// is rendered with the standard "\ No newline at end of file" marker.
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const last = parts.pop() as string;
  const lines = parts.map((l) => `${l}\n`);
  if (last !== "") lines.push(last);
  return lines;
}

function replaceAll(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line): Op => ({ tag: "-", line })),
    ...b.map((line): Op => ({ tag: "+", line })),
  ];
}

// Standard Myers greedy diff with a trace for backtracking.
function myersDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  let v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  let dFound = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number; // down: insertion from b
      } else {
        x = (v[offset + k - 1] as number) + 1; // right: deletion from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        v = next;
        trace.push(v.slice());
        dFound = d;
        break outer;
      }
    }
    v = next;
  }
  if (dFound < 0) return replaceAll(a, b);
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d--) {
    const prev = trace[d] as number[];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (prev[offset + k - 1] as number) < (prev[offset + k + 1] as number))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ tag: " ", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ tag: "+", line: b[y - 1] as string });
      y--;
    } else {
      ops.push({ tag: "-", line: a[x - 1] as string });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ tag: " ", line: a[x - 1] as string });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ tag: "-", line: a[x - 1] as string });
    x--;
  }
  while (y > 0) {
    ops.push({ tag: "+", line: b[y - 1] as string });
    y--;
  }
  ops.reverse();
  return ops;
}

function buildHunks(ops: Op[]): string[] {
  // Group changed regions with up to CONTEXT lines of context.
  const hunks: string[] = [];
  let i = 0;
  let aLine = 0; // 0-based count of consumed a-lines
  let bLine = 0;
  while (i < ops.length) {
    const op = ops[i] as Op;
    if (op.tag === " ") {
      aLine++;
      bLine++;
      i++;
      continue;
    }
    // Found a change; back up for leading context.
    let start = i;
    let leading = 0;
    while (start > 0 && leading < CONTEXT && (ops[start - 1] as Op).tag === " ") {
      start--;
      leading++;
    }
    const aStart = aLine - leading;
    const bStart = bLine - leading;
    // Advance through the hunk, allowing gaps of up to 2*CONTEXT equal lines.
    let end = i;
    let aCount = leading;
    let bCount = leading;
    let aCur = aLine;
    let bCur = bLine;
    let trailing = 0;
    while (end < ops.length) {
      const o = ops[end] as Op;
      if (o.tag === " ") {
        trailing++;
        if (trailing > 2 * CONTEXT) break;
      } else {
        trailing = 0;
      }
      if (o.tag !== "+") {
        aCur++;
        aCount++;
      }
      if (o.tag !== "-") {
        bCur++;
        bCount++;
      }
      end++;
    }
    // Trim surplus trailing context beyond CONTEXT lines.
    let surplus = Math.max(0, trailing - CONTEXT);
    // Never trim if the hunk reaches the end (keep "no newline" anchoring simple).
    if (end >= ops.length) surplus = Math.max(0, trailing - CONTEXT);
    end -= surplus;
    aCount -= surplus;
    bCount -= surplus;
    aCur -= surplus;
    bCur -= surplus;

    const bodyOps = ops.slice(start, end);
    const lines: string[] = [];
    for (const o of bodyOps) {
      if (o.line.endsWith("\n")) {
        lines.push(o.tag + o.line.slice(0, -1));
      } else {
        // Only the final line of a file can lack its terminator.
        lines.push(o.tag + o.line);
        lines.push("\\ No newline at end of file");
      }
    }
    const header = `@@ -${hunkRange(aStart, aCount)} +${hunkRange(bStart, bCount)} @@`;
    hunks.push(`${header}\n${lines.join("\n")}\n`);
    i = end;
    aLine = aCur;
    bLine = bCur;
  }
  return hunks;
}

function hunkRange(start0: number, count: number): string {
  const start1 = count === 0 ? start0 : start0 + 1;
  return count === 1 ? `${start1}` : `${start1},${count}`;
}
