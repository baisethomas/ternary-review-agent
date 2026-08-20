// Zero-network is structural (spec fixed decision 7): the module graph
// reachable from the dry-run/manifest entry path (main.ts) must import no
// networking transport and must never reach the transmit module. A runtime
// test additionally asserts a dry-run makes zero network calls.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// The complete allowlist for the collector's entry path. Anything else —
// above all http/https/http2/net/tls/dns, undici, axios, node-fetch, got —
// fails this test by not being listed.
const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:path",
]);

// Best-effort `//` and `/* */` comment stripper for the module-graph walk
// below. Good enough for this codebase's source files (module specifiers
// here are always simple relative paths or `node:...` builtins, never
// strings containing `//`), not a general-purpose tokenizer.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

// `staticOnly: true` excludes dynamic `import(...)`/`require(...)` call
// sites from the walk — the point of a *static* module graph is exactly
// that ESM evaluates it eagerly regardless of which runtime branch fires,
// which a dynamic import (evaluated lazily, only when that line actually
// runs) does not do. Default (false) keeps the original behavior — every
// import form, static or dynamic — for the collect.ts/submit.ts-rooted
// checks below, which don't need the distinction.
function moduleGraph(entry: string, options: { staticOnly?: boolean } = {}): Set<string> {
  const { staticOnly = false } = options;
  const visited = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    // Strip comments before matching: once the "from" alternative below
    // spans newlines (needed for this codebase's common multi-line named-
    // import lists), an unstripped comment mentioning "import ... from ..."
    // as prose (as several files in this graph do, including this test)
    // would otherwise itself be matched as a real import statement.
    const source = stripComments(readFileSync(file, "utf8"));
    // Note: the "from" alternative deliberately allows newlines between the
    // `import`/`export` keyword and `from` (multi-line named-import lists
    // are common in this codebase) but still excludes quote characters, so
    // the lazy match can't run past its own module specifier into the next
    // statement. `\b` on both keywords keeps this from firing inside a word
    // like "imported".
    const staticPattern = /\b(?:import|export)\b[^"']*?\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
    const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
    // A whole-declaration type-only import (`import type { X } from "..."`)
    // is erased entirely at compile time by TypeScript's `isolatedModules`
    // rules — no runtime `import` statement survives it in the emitted JS —
    // so it contributes no edge to the graph either. (A per-specifier
    // type-only import, e.g. `import { type X, y } from "..."`, still keeps
    // a runtime edge for `y`, so only the whole-declaration form is skipped.)
    const isTypeOnlyImport = (matchText: string): boolean => /^(?:import|export)\s+type\s/.test(matchText);
    const specs: string[] = [];
    for (const match of source.matchAll(staticPattern)) {
      if (isTypeOnlyImport(match[0])) continue;
      const spec = match[1] ?? match[2];
      if (spec !== undefined) specs.push(spec);
    }
    if (!staticOnly) {
      for (const match of source.matchAll(dynamicPattern)) {
        const spec = match[1] ?? match[2];
        if (spec !== undefined) specs.push(spec);
      }
    }
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      } else {
        externals.add(spec);
      }
    }
  };
  visit(entry);
  // Externals travel alongside visited files for assertion convenience.
  for (const e of externals) visited.add(`external:${e}`);
  return visited;
}

describe("structural zero-network (module graph): the dry-run/manifest path", () => {
  // collect.ts is the actual dry-run/manifest code path — capture through
  // finalized canonical payload — shared by main.ts's --dry-run/--manifest
  // branch. It must never reach the transmit module. (main.ts itself now
  // also wires the submit path, which legitimately does reach transmit.ts,
  // so the module graph rooted at main.ts is no longer the right thing to
  // assert "no transmit" against — see the "submit path" describe block
  // below for that positive check.)
  const graph = moduleGraph(join(SRC_DIR, "collect.ts"));
  const files = [...graph].filter((f) => !f.startsWith("external:")).map((f) => basename(f));
  const externals = [...graph]
    .filter((f) => f.startsWith("external:"))
    .map((f) => f.slice("external:".length));

  it("covers the collector modules (sanity: the walk is real)", () => {
    for (const expected of [
      "collect.ts", "capture.ts", "deny.ts", "payload.ts", "types.ts",
      "diff.ts", "ignore.ts", "pathbytes.ts", "secrets.ts",
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("imports no networking transport anywhere in the dry-run/manifest path", () => {
    for (const external of externals) {
      expect(ALLOWED_EXTERNAL_IMPORTS.has(external), `unexpected import: ${external}`).toBe(true);
    }
  });

  it("never imports the transmit module from the dry-run/manifest path", () => {
    expect(files).not.toContain("transmit.ts");
  });

  it("contains no fetch/XHR/WebSocket call sites", () => {
    for (const file of [...graph].filter((f) => !f.startsWith("external:"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/XMLHttpRequest|WebSocket/);
    }
  });
});

describe("structural: the submit path may reach transmit", () => {
  it("submit.ts's module graph does include the transmit module", () => {
    const graph = moduleGraph(join(SRC_DIR, "submit.ts"));
    const files = [...graph].filter((f) => !f.startsWith("external:")).map((f) => basename(f));
    expect(files).toContain("transmit.ts");
  });
});

describe("structural zero-network (module graph): the entry point (main.ts)", () => {
  // main.ts is what --dry-run and --manifest actually execute (it's the CLI
  // entry point runCli lives in). A static import anywhere in main.ts's own
  // module graph — even one main.ts never *executes* on the offline path,
  // like a top-level `import { runSubmit } from "./submit.js"` — is loaded
  // by ESM at module-evaluation time regardless of which branch runs, so the
  // collect.ts-rooted graph test above cannot see it: it doesn't walk
  // through main.ts. This is the regression that test missed (main.ts
  // statically importing submit.js, which statically imports transmit.js,
  // and TransmitError straight from transmit.js) — rooting the walk at
  // main.ts is what actually proves the offline entry point is clean.
  const graph = moduleGraph(join(SRC_DIR, "main.ts"), { staticOnly: true });
  const files = [...graph].filter((f) => !f.startsWith("external:")).map((f) => basename(f));

  it("covers the entry point's own offline modules (sanity: the walk is real)", () => {
    for (const expected of ["main.ts", "collect.ts", "render.ts", "types.ts"]) {
      expect(files).toContain(expected);
    }
  });

  it("never reaches the transmit module via a static import from the entry point", () => {
    expect(files).not.toContain("transmit.ts");
  });

  it("never reaches the submit module via a static import from the entry point", () => {
    // submit.ts is only reachable dynamically (`await import("./submit.js")`,
    // gated on a real, non-dry-run/non-manifest invocation), so it must not
    // appear in main.ts's static graph either — a stronger guarantee than
    // strictly required by spec decision 7, and the cleanest structural
    // proof that the dynamic import is actually gated rather than incidental.
    expect(files).not.toContain("submit.ts");
  });

  it("imports no networking transport anywhere in the entry point's static graph", () => {
    const externals = [...graph]
      .filter((f) => f.startsWith("external:"))
      .map((f) => f.slice("external:".length));
    for (const external of externals) {
      expect(ALLOWED_EXTERNAL_IMPORTS.has(external), `unexpected import: ${external}`).toBe(true);
    }
  });
});

describe("runtime zero-network (dry run)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a dry run makes zero network calls", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ternary-net-")));
    roots.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");

    const fetchSpy = vi.fn(() => {
      throw new Error("network call attempted during dry run");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const connectSpy = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("socket connection attempted during dry run");
      });

    const out: string[] = [];
    const code = runCli(["review", ".", "--dry-run"], {
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      cwd: dir,
    });

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
