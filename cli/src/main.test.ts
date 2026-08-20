import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./main.js";
import { SCHEMA_VERSION } from "./types.js";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Ternary Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Ternary Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ternary-main-")));
  roots.push(dir);
  return dir;
}

function g(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
}

interface RunResult {
  code: number;
  out: string[];
  err: string[];
}

function run(argv: string[], cwd: string): RunResult {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    cwd,
  });
  return { code, out, err };
}

describe("argv wiring", () => {
  const dir = makeDir();

  it("requires --dry-run or --manifest in this phase", () => {
    const r = run(["review", "."], dir);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("transmission is not implemented");
  });

  it("rejects unknown flags and commands", () => {
    expect(run(["review", ".", "--uncommitted"], dir).code).toBe(2);
    expect(run(["review", ".", "--uncommitted"], dir).err.join("\n")).toContain("--uncommitted");
    expect(run(["deploy", "."], dir).code).toBe(2);
  });

  it("has NO override for the deny classes: every plausible bypass flag is rejected", () => {
    // Spec 4.2: "no override in the alpha". This is the CLI half of that —
    // there is no flag to write, and none of these parse.
    for (const flag of [
      "--no-deny",
      "--include-env",
      "--allow-secrets",
      "--allow-env",
      "--force",
      "--unsafe",
      "--include=.env",
      "--no-redact",
      "--disable-deny-classes",
      "--override",
    ]) {
      const r = run(["review", ".", flag, "--dry-run"], dir);
      expect(r.code, flag).toBe(2);
      expect(r.err.join("\n"), flag).toContain(flag);
      expect(r.err.join("\n"), flag).toContain("unknown flag");
    }
  });

  it("carries no override switch in its source (structural, not just unparsed)", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(srcDir, file), "utf8");
      expect(source, file).not.toMatch(/--(?:no-deny|allow-secrets|include-env|no-redact|unsafe)/);
      expect(source, file).not.toMatch(/\ballowDenyOverride|skipDenyClasses|bypassDeny\b/);
    }
  });

  it("refuses a file as the workspace path (an .env cannot be passed as the argument)", () => {
    const argDir = makeDir();
    writeFileSync(join(argDir, ".env"), "SECRET=argument-canary\n");
    const r = run(["review", ".env", "--dry-run"], argDir);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("Workspace Root must be a directory");
    expect(r.out.join("\n") + r.err.join("\n")).not.toContain("argument-canary");
  });

  it("rejects --staged with --all", () => {
    const r = run(["review", ".", "--staged", "--all", "--dry-run"], dir);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("mutually exclusive");
  });
});

describe("ternary review . --dry-run (end to end, offline)", () => {
  it("reports every required field and exits 0", () => {
    const dir = makeDir();
    g(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, ".env"), "SECRET=do-not-send\n");
    const r = run(["review", ".", "--dry-run"], dir);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain("dry run (nothing transmitted)");
    expect(text).toContain("review mode:       changeset (default capture)");
    expect(text).toContain(`workspace root:    ${dir}`);
    expect(text).toContain(`schema version:    ${SCHEMA_VERSION}`);
    expect(text).toMatch(/canonical digest: {2}sha256:[0-9a-f]{64}/);
    expect(text).toContain("included files (1):");
    expect(text).toContain("excluded files (1):");
    expect(text).toContain(".env — env_file");
    expect(text).toMatch(/total source bytes: {2}\d+/);
    expect(text).toMatch(/total payload bytes: \d+/);
    // Never print source contents or secret values.
    expect(text).not.toContain("do-not-send");
    expect(text).not.toContain("export const");
  });

  it("--staged outside a Git repository is a hard error", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "a.ts"), "a\n");
    const r = run(["review", ".", "--staged", "--dry-run"], dir);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("--staged requires a Git repository");
  });

  it("--manifest works in a non-Git directory as a snapshot", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "only.ts"), "x\n");
    const r = run(["review", ".", "--manifest"], dir);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain("manifest (nothing transmitted)");
    expect(text).toContain("snapshot (default capture)");
    expect(text).toContain("only.ts");
  });

  it("--all produces a snapshot review", () => {
    const dir = makeDir();
    g(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "a\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "base");
    const r = run(["review", ".", "--all", "--dry-run"], dir);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("snapshot (all capture)");
  });

  it("is byte-for-byte deterministic: identical trees produce identical digests", () => {
    const digests: string[] = [];
    for (let i = 0; i < 2; i++) {
      const outer = makeDir();
      // Fixed leaf name: the workspace label enters the payload.
      const dir = join(outer, "workspace");
      execFileSync("mkdir", [dir]);
      g(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", "base");
      writeFileSync(join(dir, "a.ts"), "one\nTWO\n");
      writeFileSync(join(dir, "new.ts"), "brand new\n");
      const r = run(["review", ".", "--dry-run"], dir);
      expect(r.code).toBe(0);
      const line = r.out.find((l) => l.includes("canonical digest:"));
      digests.push(line ?? "missing");
    }
    expect(digests[0]).toBe(digests[1]);
    expect(digests[0]).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("unborn HEAD renders as all-additions changeset", () => {
    const dir = makeDir();
    g(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "first.ts"), "hello\n");
    g(dir, "add", "first.ts");
    const r = run(["review", ".", "--staged", "--dry-run"], dir);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain("unborn HEAD (all files are additions)");
    expect(text).toContain("A first.ts");
  });

  it("neutralizes hostile filenames end to end", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "evil\x1b[8m.ts"), "x\n");
    writeFileSync(join(dir, "hidden\rrewrite.ts"), "x\n");
    writeFileSync(join(dir, "c1csi.ts"), "x\n");
    writeFileSync(join(dir, `long${"y".repeat(200)}.ts`), "x\n");
    const r = run(["review", ".", "--manifest"], dir);
    expect(r.code).toBe(0);
    const text = r.out.join("\n") + r.err.join("\n");
    // The only escape sequences in the output are the CLI's own (there are
    // none today): every control character is rendered visibly (spec 10).
    expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\r]/);
    expect(text).toContain("\\x1b");
    expect(text).toContain("\\x0d");
    expect(text).toContain("\\x9b");
  });

  it("renders bidi and zero-width characters in filenames without them steering the line", () => {
    const dir = makeDir();
    // U+202E RIGHT-TO-LEFT OVERRIDE and U+200B ZERO WIDTH SPACE are not
    // control characters, so they survive into the manifest bytes; what
    // matters is that they cannot introduce an escape sequence.
    writeFileSync(join(dir, "sj.‮gnp.ts"), "x\n");
    writeFileSync(join(dir, "zero​width.ts"), "x\n");
    const r = run(["review", ".", "--manifest"], dir);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("zero​width.ts");
  });
});
