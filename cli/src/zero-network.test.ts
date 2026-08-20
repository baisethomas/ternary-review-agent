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

function moduleGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const pattern =
      /(?:import|export)[^"'\n]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (spec === undefined) continue;
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

describe("structural zero-network (module graph)", () => {
  const graph = moduleGraph(join(SRC_DIR, "main.ts"));
  const files = [...graph].filter((f) => !f.startsWith("external:")).map((f) => basename(f));
  const externals = [...graph]
    .filter((f) => f.startsWith("external:"))
    .map((f) => f.slice("external:".length));

  it("covers the collector modules (sanity: the walk is real)", () => {
    for (const expected of [
      "main.ts", "capture.ts", "deny.ts", "payload.ts", "render.ts", "types.ts",
      "diff.ts", "ignore.ts", "pathbytes.ts", "secrets.ts",
    ]) {
      expect(files).toContain(expected);
    }
  });

  it("imports no networking transport anywhere in the entry path", () => {
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
