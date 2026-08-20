import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureWorkspace, loadLocalPolicy, makeContentReaders } from "./capture.js";
import { runExclusionPipeline } from "./deny.js";
import { CollectorError, DEFAULT_CAPS } from "./types.js";
import type { CaptureMode, CaptureResult } from "./types.js";

// Deterministic git identity/dates so blob and commit shas are reproducible.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ternary-capture-")));
  roots.push(dir);
  return dir;
}

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
  });
}

function makeRepo(): string {
  const dir = makeDir();
  g(dir, "init", "-q", "-b", "main");
  return dir;
}

function commitAll(dir: string, message: string): void {
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", message);
}

function capturedPaths(result: CaptureResult): string[] {
  return result.candidates.map((c) => c.path).sort();
}

function candidate(result: CaptureResult, path: string) {
  return result.candidates.find((c) => c.path === path);
}

describe("capture-mode matrix (spec 7.1)", () => {
  it("default mode: unstaged modifications, staged changes, and safe untracked files", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "committed.ts"), "base\n");
    writeFileSync(join(dir, "staged.ts"), "old\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "committed.ts"), "modified in worktree\n"); // unstaged
    writeFileSync(join(dir, "staged.ts"), "staged edit\n");
    g(dir, "add", "staged.ts");
    writeFileSync(join(dir, "untracked.ts"), "safe untracked\n");
    const result = captureWorkspace(dir, "default");
    expect(result.kind).toBe("changeset");
    expect(result.workspace.vcs).toBe("git");
    expect(result.workspace.unborn).toBe(false);
    expect(capturedPaths(result)).toEqual(["committed.ts", "staged.ts", "untracked.ts"]);
    expect(candidate(result, "committed.ts")?.status).toBe("modified");
    expect(candidate(result, "staged.ts")?.status).toBe("modified");
    expect(candidate(result, "untracked.ts")?.status).toBe("added");
    // Default mode reads from the worktree.
    expect(result.candidates.every((c) => c.source === "worktree")).toBe(true);
  });

  it("default mode: when index and worktree disagree, the worktree wins", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "file.ts"), "committed\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "file.ts"), "index version\n");
    g(dir, "add", "file.ts");
    writeFileSync(join(dir, "file.ts"), "worktree version\n");
    const result = captureWorkspace(dir, "default");
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);
    const outcome = runExclusionPipeline(
      result,
      loadLocalPolicy(result.workspace.rootAbs, "git"),
      DEFAULT_CAPS,
      readers,
    );
    const patch = outcome.changeset?.[0]?.patch ?? "";
    expect(patch).toContain("+worktree version");
    expect(patch).not.toContain("index version");
  });

  it("default mode: worktree deletions are deletions even if staged differently", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "gone.ts"), "here\n");
    commitAll(dir, "base");
    rmSync(join(dir, "gone.ts"));
    const result = captureWorkspace(dir, "default");
    expect(candidate(result, "gone.ts")?.status).toBe("deleted");
    expect(candidate(result, "gone.ts")?.kind).toBe("deleted");
  });

  it("default mode: staged renames are represented as renames, not delete+add", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "before.ts"), "line one\nline two\nline three\n");
    commitAll(dir, "base");
    g(dir, "mv", "before.ts", "after.ts");
    const result = captureWorkspace(dir, "default");
    expect(capturedPaths(result)).toEqual(["after.ts"]);
    const renamed = candidate(result, "after.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.from).toBe("before.ts");
    expect(renamed?.similarity).toBeGreaterThan(0);
  });

  it("staged mode: index only — worktree edits and untracked files are excluded", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "v1\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "a.ts"), "v2 staged\n");
    g(dir, "add", "a.ts");
    writeFileSync(join(dir, "a.ts"), "v3 worktree only\n");
    writeFileSync(join(dir, "untracked.ts"), "never staged\n");
    const result = captureWorkspace(dir, "staged");
    expect(capturedPaths(result)).toEqual(["a.ts"]);
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);
    const outcome = runExclusionPipeline(
      result,
      { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      readers,
    );
    const patch = outcome.changeset?.[0]?.patch ?? "";
    expect(patch).toContain("+v2 staged");
    expect(patch).not.toContain("v3 worktree only");
  });

  it("staged mode: staged deletions and renames", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "del.ts"), "x\n");
    writeFileSync(join(dir, "old.ts"), "many\nlines\nof\ncontent\nhere\n");
    commitAll(dir, "base");
    g(dir, "rm", "-q", "del.ts");
    g(dir, "mv", "old.ts", "new.ts");
    const result = captureWorkspace(dir, "staged");
    expect(candidate(result, "del.ts")?.status).toBe("deleted");
    const renamed = candidate(result, "new.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.from).toBe("old.ts");
    expect(renamed?.similarity).toBeGreaterThanOrEqual(50);
  });

  it("unborn HEAD: every captured file is an addition against the empty base", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "first.ts"), "hello\n");
    g(dir, "add", "first.ts");
    for (const mode of ["default", "staged"] as CaptureMode[]) {
      const result = captureWorkspace(dir, mode);
      expect(result.kind).toBe("changeset");
      expect(result.workspace.unborn).toBe(true);
      expect(result.workspace.headSha).toBeUndefined();
      expect(candidate(result, "first.ts")?.status).toBe("added");
    }
  });

  it("--all: bounded whole-workspace snapshot in a Git repository", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.ts"), "t\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "untracked.ts"), "u\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "ignored.ts"), "should not appear\n");
    const result = captureWorkspace(dir, "all");
    expect(result.kind).toBe("snapshot");
    const paths = capturedPaths(result);
    expect(paths).toContain("tracked.ts");
    expect(paths).toContain("untracked.ts");
    expect(paths).not.toContain("ignored.ts");
    expect(result.candidates.every((c) => c.status === "unchanged")).toBe(true);
  });

  it("non-Git directory: bounded snapshot; --staged is a hard error", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "a.ts"), "a\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.ts"), "b\n");
    const result = captureWorkspace(dir, "default");
    expect(result.kind).toBe("snapshot");
    expect(result.workspace.vcs).toBe("none");
    expect(capturedPaths(result)).toEqual(["a.ts", "sub/b.ts"]);
    expect(() => captureWorkspace(dir, "staged")).toThrowError(CollectorError);
    expect(() => captureWorkspace(dir, "staged")).toThrowError(/--staged requires a Git repository/);
  });

  it("non-Git directory: respects .gitignore and .ternaryignore in the walk", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, ".ternaryignore"), "private/\n");
    writeFileSync(join(dir, "keep.ts"), "k\n");
    writeFileSync(join(dir, "noise.log"), "n\n");
    mkdirSync(join(dir, "private"));
    writeFileSync(join(dir, "private", "x.ts"), "x\n");
    const result = captureWorkspace(dir, "all");
    const paths = capturedPaths(result);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("noise.log");
    expect(paths).not.toContain("private/x.ts");
    expect(result.preExcluded).toContainEqual({ path: "private", class: "policy_excluded" });
  });
});

describe("Local Policy resolution (nested ignore files)", () => {
  it("Git mode: a nested .ternaryignore excludes only inside its own directory", () => {
    const dir = makeRepo();
    mkdirSync(join(dir, "pkg", "app"), { recursive: true });
    writeFileSync(join(dir, "pkg", "app", ".ternaryignore"), "*.gen.ts\n");
    writeFileSync(join(dir, "pkg", "app", "a.gen.ts"), "generated\n");
    writeFileSync(join(dir, "pkg", "app", "a.ts"), "source\n");
    writeFileSync(join(dir, "other.gen.ts"), "not covered by the nested rule\n");
    const result = captureWorkspace(dir, "default");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    const included = outcome.changeset?.map((c) => c.path) ?? [];
    expect(included).toContain("pkg/app/a.ts");
    expect(included).toContain("other.gen.ts");
    expect(included).not.toContain("pkg/app/a.gen.ts");
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "pkg/app/a.gen.ts",
      class: "policy_excluded",
    });
    expect(result.policy?.excludePatterns).toEqual(["pkg/app/:*.gen.ts"]);
  });

  it("non-Git walk: a deeper ignore file's negation wins over a shallower rule", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", ".gitignore"), "!important.log\n");
    writeFileSync(join(dir, "noise.log"), "n\n");
    writeFileSync(join(dir, "pkg", "important.log"), "keep me\n");
    writeFileSync(join(dir, "pkg", "other.log"), "drop me\n");
    const result = captureWorkspace(dir, "all");
    const paths = capturedPaths(result);
    expect(paths).toContain("pkg/important.log");
    expect(paths).not.toContain("pkg/other.log");
    expect(paths).not.toContain("noise.log");
  });
});

describe("capture edge cases (spec 7.2/7.3)", () => {
  it("ignored files never become untracked candidates in default mode", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".gitignore"), "secret-ish.txt\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "secret-ish.txt"), "ignored\n");
    const result = captureWorkspace(dir, "default");
    expect(capturedPaths(result)).not.toContain("secret-ish.txt");
  });

  it("symlinks are captured as link entries and never followed", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "real.ts"), "real\n");
    commitAll(dir, "base");
    symlinkSync("/etc/hosts", join(dir, "link-out"));
    const result = captureWorkspace(dir, "default");
    const link = candidate(result, "link-out");
    expect(link?.kind).toBe("symlink");
    expect(link?.linkTarget).toBe("/etc/hosts");
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);
    const outcome = runExclusionPipeline(
      result,
      { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      readers,
    );
    const bytes = JSON.stringify(outcome);
    expect(bytes).not.toContain("localhost"); // no /etc/hosts content
  });

  it("submodule gitlinks contribute metadata only", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    const headSha = g(dir, "rev-parse", "HEAD").trim();
    g(dir, "update-index", "--add", "--cacheinfo", `160000,${headSha},vendor-lib`);
    const result = captureWorkspace(dir, "staged");
    const sub = candidate(result, "vendor-lib");
    expect(sub?.kind).toBe("submodule");
    expect(sub?.blobSha).toBe(headSha);
  });

  it("nested repositories are excluded entirely", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    mkdirSync(join(dir, "nested"));
    g(join(dir, "nested"), "init", "-q");
    writeFileSync(join(dir, "nested", "inner.ts"), "inner\n");
    const result = captureWorkspace(dir, "default");
    expect(capturedPaths(result)).not.toContain("nested/inner.ts");
    expect(result.preExcluded).toContainEqual({ path: "nested", class: "nested_repository" });
  });

  it("case-collision in the index is a hard error (deterministic across platforms)", () => {
    const dir = makeRepo();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "content\n",
      env: { ...process.env, ...GIT_ENV },
      encoding: "utf8",
    }).trim();
    g(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},file.ts`);
    g(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},FILE.ts`);
    const result = captureWorkspace(dir, "staged");
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);
    expect(() =>
      runExclusionPipeline(result, { excludeRules: [], excludePatterns: [] }, DEFAULT_CAPS, readers),
    ).toThrowError(/differ only by case/);
  });

  it("race-safe read: a candidate replaced by a symlink after classification is excluded as unverifiable", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "victim.ts"), "innocent\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "victim.ts"), "changed\n");
    const result = captureWorkspace(dir, "default");
    // Simulate the race between classification (lstat) and the verified read.
    rmSync(join(dir, "victim.ts"));
    symlinkSync("/etc/hosts", join(dir, "victim.ts"));
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);
    const outcome = runExclusionPipeline(
      result,
      { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      readers,
    );
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "victim.ts",
      class: "unverifiable",
    });
    expect(JSON.stringify(outcome)).not.toContain("localhost");
  });
});
