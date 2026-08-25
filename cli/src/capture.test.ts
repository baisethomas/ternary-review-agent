import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Many tests here build real Git repositories and run several captures each
// (~2 s alone); under a full concurrent suite run they exceed vitest's 5 s
// default and flake.
vi.setConfig({ testTimeout: 20_000 });

// A conditional lstatSync hook for one test (identity-mismatch-vs-nlink
// ordering, below): node:fs is a real ES module and its exports are not
// individually spy-able, so the whole module is mocked here with a
// passthrough that only diverts when a test installs a hook. Every other
// test leaves the hook unset and gets real filesystem behavior.
const lstatHook = vi.hoisted(() => ({ fn: null as null | ((path: unknown) => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      lstatHook.fn?.(args[0]);
      return actual.lstatSync(...args);
    },
  };
});

// Records every `git` invocation's argv, same passthrough-mock shape as the
// lstatSync hook above. Used to assert capture.ts's own diff-index calls
// carry --no-textconv/--no-ext-diff (TER-35) — a behavioral marker-file test
// alone cannot prove this, since diff-index's raw (-z, no -p) plumbing output
// never runs a driver even without those flags (verified separately); this
// spy ties the test to the actual argv instead, so it fails if the flags are
// ever removed.
const gitArgvLog = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (
      file: Parameters<typeof actual.execFileSync>[0],
      args: Parameters<typeof actual.execFileSync>[1],
      ...rest: unknown[]
    ) => {
      if (file === "git" && Array.isArray(args)) gitArgvLog.calls.push([...(args as string[])]);
      // @ts-expect-error -- passthrough with the original call's arity
      return actual.execFileSync(file, args, ...rest);
    },
  };
});
import { captureWorkspace, isWorktreeAbsent, loadLocalPolicy, makeContentReaders } from "./capture.js";
import type { StatusRecord } from "./capture.js";
import { runExclusionPipeline } from "./deny.js";
import { canonicalBytes } from "./payload.js";
import { CollectorError, DEFAULT_CAPS, SCHEMA_VERSION } from "./types.js";
import type { CanonicalPayload, CaptureMode, CaptureResult } from "./types.js";

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
afterEach(() => {
  lstatHook.fn = null;
  gitArgvLog.calls = [];
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

  it("default mode: a staged deletion (git rm, nothing recreated) is a deletion, not unverifiable", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "gone.ts"), "here\n");
    commitAll(dir, "base");
    g(dir, "rm", "-q", "gone.ts");
    const result = captureWorkspace(dir, "default");
    expect(candidate(result, "gone.ts")?.status).toBe("deleted");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    const entry = outcome.manifest.find((m) => m.path === "gone.ts");
    expect(entry?.status).toBe("deleted");
    expect(entry?.contentIncluded).toBe(false);
    expect(entry?.size).toBe(0);
    expect(outcome.redaction.withheldFiles).not.toContainEqual({
      path: "gone.ts",
      class: "unverifiable",
    });
  });

  it("default mode: a staged deletion recreated as an untracked file is captured as content (worktree wins)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "gone.ts"), "here\n");
    commitAll(dir, "base");
    g(dir, "rm", "-q", "gone.ts");
    writeFileSync(join(dir, "gone.ts"), "recreated\n");
    const result = captureWorkspace(dir, "default");
    expect(candidate(result, "gone.ts")?.status).not.toBe("deleted");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    expect(outcome.manifest.some((m) => m.path === "gone.ts" && m.status === "deleted")).toBe(false);
    const changesetEntry = outcome.changeset?.find((c) => c.path === "gone.ts");
    expect(changesetEntry?.content ?? changesetEntry?.patch).toContain("recreated");
  });

  it("default mode: staged rename whose target is then deleted in the worktree collapses to a deletion of the source (TER-41)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "before.ts"), "line one\nline two\nline three\n");
    commitAll(dir, "base");
    g(dir, "mv", "before.ts", "after.ts");
    rmSync(join(dir, "after.ts"));
    const result = captureWorkspace(dir, "default");
    // The final worktree differs from HEAD only by the deletion of
    // before.ts; the destination (after.ts) is gone from both the worktree
    // and (as a rename target) never lands, so it must not silently
    // disappear on both ends — it collapses to a deletion of the source.
    expect(capturedPaths(result)).toEqual(["before.ts"]);
    const deleted = candidate(result, "before.ts");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.kind).toBe("deleted");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    const entry = outcome.manifest.find((m) => m.path === "before.ts");
    expect(entry?.status).toBe("deleted");
    expect(entry?.contentIncluded).toBe(false);
    expect(entry?.size).toBe(0);
  });

  it("default mode: staged rename whose target is deleted then recreated as an untracked file — worktree wins, no spurious deletion", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "before.ts"), "line one\nline two\nline three\n");
    commitAll(dir, "base");
    g(dir, "mv", "before.ts", "after.ts");
    rmSync(join(dir, "after.ts"));
    writeFileSync(join(dir, "after.ts"), "recreated content\n");
    const result = captureWorkspace(dir, "default");
    expect(capturedPaths(result)).toEqual(["after.ts"]);
    const renamed = candidate(result, "after.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.from).toBe("before.ts");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    expect(outcome.manifest.some((m) => m.status === "deleted")).toBe(false);
    const changesetEntry = outcome.changeset?.find((c) => c.path === "after.ts");
    expect(changesetEntry?.content ?? changesetEntry?.patch).toContain("recreated content");
  });

  it("default mode: staged rename source recreated as an untracked file after the rename — both paths represented, no spurious deletion", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "before.ts"), "line one\nline two\nline three\n");
    commitAll(dir, "base");
    g(dir, "mv", "before.ts", "after.ts");
    writeFileSync(join(dir, "before.ts"), "recreated source\n");
    const result = captureWorkspace(dir, "default");
    expect(capturedPaths(result)).toEqual(["after.ts", "before.ts"]);
    const renamed = candidate(result, "after.ts");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.from).toBe("before.ts");
    const recreatedSource = candidate(result, "before.ts");
    // before.ts existed in HEAD (it's the rename's origin), so the recreated
    // worktree content compares against that HEAD blob as a modification —
    // not a fresh addition, and not a deletion.
    expect(recreatedSource?.status).toBe("modified");
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    expect(outcome.manifest.some((m) => m.status === "deleted")).toBe(false);
    const sourceEntry = outcome.changeset?.find((c) => c.path === "before.ts");
    expect(sourceEntry?.content ?? sourceEntry?.patch).toContain("recreated source");
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

describe("cross-root renames (Workspace Root below the repo root, spec 4.1/4.2-10)", () => {
  const CANARY_DIR = "secretdir";
  const CANARY_FILE = "leak.ts";
  const CANARY_PATH = `${CANARY_DIR}/${CANARY_FILE}`;

  function makeSubrootRepo(): { dir: string; root: string } {
    const dir = makeRepo();
    mkdirSync(join(dir, CANARY_DIR), { recursive: true });
    mkdirSync(join(dir, "packages", "app"), { recursive: true });
    writeFileSync(join(dir, CANARY_DIR, CANARY_FILE), "outside content\n");
    writeFileSync(join(dir, "packages", "app", "keep.ts"), "keep\n");
    commitAll(dir, "base");
    return { dir, root: join(dir, "packages", "app") };
  }

  for (const mode of ["default", "staged"] as CaptureMode[]) {
    it(`${mode} mode: a staged rename whose origin lies outside the Workspace Root is captured as an addition, never a rename`, () => {
      const { dir, root } = makeSubrootRepo();
      g(dir, "mv", `${CANARY_DIR}/${CANARY_FILE}`, "packages/app/config.ts");
      const result = captureWorkspace(root, mode);
      const config = candidate(result, "config.ts");
      expect(config?.status).toBe("added");
      expect(config?.from).toBeUndefined();
      expect(config?.similarity).toBeUndefined();
      expect((config as { baseSha?: string } | undefined)?.baseSha).toBeUndefined();
      const { text, outcome } = canonicalOf(result);
      // The canonical bytes must never name the out-of-root origin path, in
      // any field — path, from, or otherwise.
      expect(text).not.toContain(CANARY_PATH);
      expect(text).not.toContain(CANARY_DIR);
      const changesetEntry = outcome.changeset?.find((c) => c.path === "config.ts");
      expect(changesetEntry?.status).toBe("added");
      expect(changesetEntry?.from).toBeUndefined();
      expect(changesetEntry?.patch).toBeUndefined();
      expect(changesetEntry?.content).toContain("outside content");
    });

    it(`${mode} mode: a staged rename whose destination lies outside the Workspace Root is captured as a deletion of the in-root source`, () => {
      const { dir, root } = makeSubrootRepo();
      writeFileSync(join(dir, "packages", "app", "leaving.ts"), "leaving content\n");
      commitAll(dir, "add leaving");
      g(dir, "mv", "packages/app/leaving.ts", `${CANARY_DIR}/gone.ts`);
      const result = captureWorkspace(root, mode);
      const source = candidate(result, "leaving.ts");
      expect(source?.status).toBe("deleted");
      expect(source?.kind).toBe("deleted");
      const { text } = canonicalOf(result);
      // The out-of-root destination path must never appear.
      expect(text).not.toContain(`${CANARY_DIR}/gone.ts`);
      expect(text).not.toContain("gone.ts");
    });
  }
});

// Canonical bytes of a full capture, for byte-absence assertions.
function canonicalOf(result: CaptureResult): { text: string; outcome: ReturnType<typeof runExclusionPipeline> } {
  const outcome = runExclusionPipeline(
    result,
    result.policy ?? { excludeRules: [], excludePatterns: [] },
    DEFAULT_CAPS,
    makeContentReaders(result.workspace.rootAbs, result.workspace),
  );
  const payload: CanonicalPayload = {
    schemaVersion: SCHEMA_VERSION,
    kind: result.kind,
    captureMode: result.captureMode,
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: {
      label: result.workspace.label,
      vcs: result.workspace.vcs,
      ...(result.kind === "changeset"
        ? {
            baseState: result.workspace.unborn
              ? ("unborn" as const)
              : { headSha: result.workspace.headSha as string },
          }
        : {}),
    },
    manifest: outcome.manifest,
    ...(outcome.changeset !== undefined ? { changeset: outcome.changeset } : {}),
    ...(outcome.snapshot !== undefined ? { snapshot: outcome.snapshot } : {}),
    context: [],
    localPolicy: {
      captureMode: result.captureMode,
      include: ["**"],
      exclude: result.policy?.excludePatterns ?? [],
      denyRulesVersion: "ternary-deny/2",
      caps: DEFAULT_CAPS,
    },
    redaction: outcome.redaction,
  };
  return { text: canonicalBytes(payload).toString("utf8"), outcome };
}

describe("adversarial: env files, symlinks, and hard links (spec 4.2, 7.2)", () => {
  const ENV_SECRET = "ENV_CANARY_5d3a91";

  it("an .env contributes zero bytes when untracked, staged, tracked, and nested — in every mode", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
    // Tracked and committed: the worst case, since Git will happily report it.
    writeFileSync(join(dir, ".env"), `TRACKED=${ENV_SECRET}\n`);
    mkdirSync(join(dir, "packages", "api"), { recursive: true });
    writeFileSync(join(dir, "packages", "api", ".env.production"), `NESTED=${ENV_SECRET}\n`);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "base");
    // Staged modification plus a fresh untracked one.
    writeFileSync(join(dir, ".env"), `STAGED=${ENV_SECRET}\n`);
    g(dir, "add", ".env");
    writeFileSync(join(dir, ".env.local"), `UNTRACKED=${ENV_SECRET}\n`);
    writeFileSync(join(dir, "src.ts"), "export const a = 2;\n");

    for (const mode of ["default", "staged", "all"] as CaptureMode[]) {
      const { text, outcome } = canonicalOf(captureWorkspace(dir, mode));
      expect(text, mode).not.toContain(ENV_SECRET);
      expect(text, mode).not.toContain("TRACKED=");
      const withheld = outcome.redaction.withheldFiles.filter((w) => w.class === "env_file");
      expect(withheld.length, mode).toBeGreaterThan(0);
    }
  });

  it("rejects a file as the Workspace Root, so an .env cannot be passed as the argument", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env"), `ARG=${ENV_SECRET}\n`);
    expect(() => captureWorkspace(join(dir, ".env"), "all")).toThrowError(
      /Workspace Root must be a directory/,
    );
  });

  it("a symlink chain out of the root contributes only link entries", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "secret.txt"), `OUTSIDE=${ENV_SECRET}\n`);
    symlinkSync(join(outside, "secret.txt"), join(dir, "hop2"));
    symlinkSync(join(dir, "hop2"), join(dir, "hop1"));
    // A link named like ordinary source, pointing outside.
    symlinkSync(join(outside, "secret.txt"), join(dir, "utils.ts"));
    writeFileSync(join(dir, "real.ts"), "export const real = 1;\n");
    const { text, outcome } = canonicalOf(captureWorkspace(dir, "all"));
    expect(text).not.toContain(ENV_SECRET);
    for (const link of ["hop1", "hop2", "utils.ts"]) {
      const entry = outcome.manifest.find((m) => m.path === link);
      expect(entry?.mode, link).toBe("symlink");
      expect(entry?.contentIncluded, link).toBe(false);
    }
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["real.ts"]);
  });

  it("a directory symlink escaping the root is never descended into", () => {
    const dir = makeDir();
    const outside = makeDir();
    mkdirSync(join(outside, "private"));
    writeFileSync(join(outside, "private", "notes.txt"), `DIRLINK=${ENV_SECRET}\n`);
    symlinkSync(join(outside, "private"), join(dir, "docs"));
    writeFileSync(join(dir, "real.ts"), "x\n");
    const { text, outcome } = canonicalOf(captureWorkspace(dir, "all"));
    expect(text).not.toContain(ENV_SECRET);
    expect(outcome.manifest.find((m) => m.path === "docs")?.mode).toBe("symlink");
    expect(outcome.manifest.some((m) => m.path.startsWith("docs/"))).toBe(false);
  });

  it("a hard link to a denied file under an innocent name is excluded, never silently included", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".env"), `HARDLINK=${ENV_SECRET}\n`);
    linkSync(join(dir, ".env"), join(dir, "notes.txt"));
    const { text, outcome } = canonicalOf(captureWorkspace(dir, "all"));
    expect(text).not.toContain(ENV_SECRET);
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "notes.txt",
      class: "hardlink_alias",
    });
    expect(outcome.snapshot).toEqual([]);
  });

  it("chain break plus a hard-linked leaf resolves to unverifiable, never hardlink_alias — identity/chain is checked before nlink (spec 7.3)", () => {
    const dir = makeDir();
    const outside = makeDir();
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "victim.ts"), "innocent\n");
    // nlink > 1 on the leaf: if the hardlink check ran before the chain
    // re-check, this alone would exclude the file as "hardlink_alias".
    linkSync(join(dir, "pkg", "victim.ts"), join(dir, "pkg", "victim-alias.ts"));
    const result = captureWorkspace(dir, "all");
    expect(candidate(result, "pkg/victim.ts")?.mode).toBe("regular");
    // The race: after classification, the classified ancestor directory is
    // moved out of the Workspace Root and replaced by a symlink — chain
    // identity is now broken for every path underneath it, including the
    // hard-linked leaf.
    renameSync(join(dir, "pkg"), join(outside, "moved-pkg"));
    symlinkSync(join(outside, "moved-pkg"), join(dir, "pkg"));
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "pkg/victim.ts",
      class: "unverifiable",
    });
    expect(outcome.redaction.withheldFiles).not.toContainEqual({
      path: "pkg/victim.ts",
      class: "hardlink_alias",
    });
  });

  it("identity mismatch plus a hard-linked leaf resolves to unverifiable, never hardlink_alias — identity is checked before nlink (spec 7.3)", () => {
    // This isolates the exact reorder: with the classifying identity already
    // known, one bounded re-classification retry is all a mismatch gets. If
    // the hardlink check ran before identity was verified, a swapped-in
    // hard-linked file would wrongly resolve as hardlink_alias on the very
    // first attempt, without ever consulting the classifying identity. With
    // identity checked first, the mismatch instead forces the retry's
    // re-classification — which this test makes fail — so the outcome is
    // "unverifiable", proving identity/chain is checked before nlink.
    const dir = makeRepo();
    writeFileSync(join(dir, "victim.ts"), "innocent\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "victim.ts"), "changed\n");
    const result = captureWorkspace(dir, "default");
    const victimAbs = join(dir, "victim.ts");
    // Race: the classified file is swapped for a different, hard-linked file
    // at the same path — a different inode, so the classifying dev/ino no
    // longer match.
    rmSync(victimAbs);
    writeFileSync(victimAbs, "swapped\n");
    linkSync(victimAbs, join(dir, "victim-alias.ts"));
    // Force the read's one bounded re-classification retry to fail (ENOENT),
    // so the identity mismatch cannot self-heal on the second attempt.
    lstatHook.fn = (path) => {
      if (path === victimAbs) {
        const error = new Error("ENOENT: simulated vanish during retry") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    };
    const outcome = runExclusionPipeline(
      result,
      result.policy ?? { excludeRules: [], excludePatterns: [] },
      DEFAULT_CAPS,
      makeContentReaders(result.workspace.rootAbs, result.workspace),
    );
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "victim.ts",
      class: "unverifiable",
    });
    expect(outcome.redaction.withheldFiles).not.toContainEqual({
      path: "victim.ts",
      class: "hardlink_alias",
    });
  });
});

describe("isWorktreeAbsent decision boundary (spec 7.1 worktree-wins semantics)", () => {
  // A minimal well-formed StatusRecord; each case overrides only the fields
  // the predicate reads.
  function record(overrides: Partial<StatusRecord>): StatusRecord {
    return {
      path: "f.ts",
      pathEncoded: false,
      stagedChar: ".",
      worktreeChar: ".",
      headSha: "0",
      indexSha: "0",
      submodule: false,
      untracked: false,
      ...overrides,
    };
  }

  it('worktreeChar "D" is absent regardless of the other fields', () => {
    expect(isWorktreeAbsent(record({ worktreeChar: "D", stagedChar: "M", indexSha: "abc123" }))).toBe(
      true,
    );
  });

  it('stagedChar "D" with a zero indexSha and no untracked recreation is absent (plain staged delete)', () => {
    expect(
      isWorktreeAbsent(record({ stagedChar: "D", indexSha: "0", untracked: false })),
    ).toBe(true);
  });

  it('stagedChar "D" with a zero indexSha but an untracked file recreated at the path is not absent (worktree wins)', () => {
    expect(
      isWorktreeAbsent(record({ stagedChar: "D", indexSha: "0", untracked: true })),
    ).toBe(false);
  });

  it('stagedChar "D" with a nonzero indexSha is not absent', () => {
    expect(
      isWorktreeAbsent(record({ stagedChar: "D", indexSha: "abc123", untracked: false })),
    ).toBe(false);
  });
});

describe("adversarial: hostile filenames and normalization determinism", () => {
  it("control characters in filenames survive capture and stay deterministic", () => {
    const digests: string[] = [];
    for (let run = 0; run < 2; run++) {
      // Fixed leaf name: the workspace label enters the payload.
      const dir = join(makeDir(), "workspace");
      mkdirSync(dir);
      const names = [
        "evil\x1b[2Jclear.ts", // ANSI CSI
        "carriage\rreturn.ts",
        "bidi‮ovveride.ts", // right-to-left override
        "zero​width.ts",
        `long-${"x".repeat(180)}.ts`,
      ];
      for (const name of names) writeFileSync(join(dir, name), "x\n");
      const { text, outcome } = canonicalOf(captureWorkspace(dir, "all"));
      // The manifest keeps the real bytes (the payload is data, not a screen);
      // neutralization happens at the renderer (render.test.ts, main.test.ts).
      expect(outcome.manifest).toHaveLength(names.length);
      digests.push(createHash("sha256").update(text).digest("hex"));
    }
    expect(digests[0]).toBe(digests[1]);
  });

  it("NFC and NFD spellings of one name produce identical canonical bytes", () => {
    const nfc = "café.ts".normalize("NFC");
    const nfd = "café.ts".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    const texts = [nfc, nfd].map((name) => {
      const dir = makeDir();
      writeFileSync(join(dir, name), "export const x = 1;\n");
      return canonicalOf(captureWorkspace(dir, "all")).text;
    });
    // Workspace labels differ (temp dirs), so compare the manifest section.
    const manifests = texts.map((t) => t.slice(t.indexOf('"manifest"'), t.indexOf('"redaction"')));
    expect(manifests[0]).toBe(manifests[1]);
    expect(manifests[0]).toContain(nfc);
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
  const NESTED_CANARY = "NESTED_CANARY_7c1f04";

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

  it("--all in a Git repo: a nested repository contributes nothing and is counted", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    // A directory whose files Git already tracks, which later became a repo:
    // ls-files keeps reporting the individual tracked paths.
    mkdirSync(join(dir, "was-tracked"));
    writeFileSync(join(dir, "was-tracked", "x.ts"), `TRACKED_CANARY=${NESTED_CANARY}\n`);
    commitAll(dir, "base");
    g(join(dir, "was-tracked"), "init", "-q", "-b", "main");
    // Untracked nested repository: git reports it as the directory "nested/".
    mkdirSync(join(dir, "nested"));
    g(join(dir, "nested"), "init", "-q", "-b", "main");
    writeFileSync(join(dir, "nested", "inner.ts"), `NESTED_CANARY=${NESTED_CANARY}\n`);

    const { text, outcome } = canonicalOf(captureWorkspace(dir, "all"));
    expect(text).not.toContain(NESTED_CANARY);
    expect(outcome.manifest.some((m) => m.path.startsWith("nested/"))).toBe(false);
    expect(outcome.manifest.some((m) => m.path.startsWith("was-tracked/"))).toBe(false);
    expect(outcome.manifest.some((m) => m.path === "nested")).toBe(false);
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "nested",
      class: "nested_repository",
    });
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "was-tracked",
      class: "nested_repository",
    });
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["a.ts"]);
  });

  it("--all in a Git repo: a registered submodule stays metadata-only, not a nested repo", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    const headSha = g(dir, "rev-parse", "HEAD").trim();
    g(dir, "update-index", "--add", "--cacheinfo", `160000,${headSha},vendor-lib`);
    // A checked-out submodule has a `.git` file, exactly like a nested repo.
    mkdirSync(join(dir, "vendor-lib"));
    writeFileSync(join(dir, "vendor-lib", ".git"), "gitdir: ../.git/modules/vendor-lib\n");
    const result = captureWorkspace(dir, "all");
    const sub = candidate(result, "vendor-lib");
    expect(sub?.kind).toBe("submodule");
    expect(sub?.blobSha).toBe(headSha);
    expect(result.preExcluded).not.toContainEqual({
      path: "vendor-lib",
      class: "nested_repository",
    });
  });

  it("default mode: a directory TRACKED before it became a nested repo excludes its tracked descendants (TER-40)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "file.ts"), `TRACKED_CANARY=${NESTED_CANARY}\n`);
    commitAll(dir, "base");
    // sub/ was tracked by the parent repo; it now gains its own .git.
    g(join(dir, "sub"), "init", "-q", "-b", "main");
    // Modify the already-tracked file so it surfaces as a git-status record
    // (an unmodified tracked file never appears in `git status` output).
    writeFileSync(join(dir, "sub", "file.ts"), `TRACKED_CANARY=${NESTED_CANARY}-changed\n`);
    const { text, outcome } = canonicalOf(captureWorkspace(dir, "default"));
    expect(text).not.toContain(NESTED_CANARY);
    expect(outcome.manifest.some((m) => m.path.startsWith("sub/"))).toBe(false);
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "sub",
      class: "nested_repository",
    });
  });

  it("staged mode: a directory TRACKED before it became a nested repo excludes its tracked descendants (TER-40)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "file.ts"), `TRACKED_CANARY=${NESTED_CANARY}\n`);
    commitAll(dir, "base");
    g(join(dir, "sub"), "init", "-q", "-b", "main");
    writeFileSync(join(dir, "sub", "file.ts"), `TRACKED_CANARY=${NESTED_CANARY}-changed\n`);
    g(dir, "add", "sub/file.ts");
    const { text, outcome } = canonicalOf(captureWorkspace(dir, "staged"));
    expect(text).not.toContain(NESTED_CANARY);
    expect(outcome.manifest.some((m) => m.path.startsWith("sub/"))).toBe(false);
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "sub",
      class: "nested_repository",
    });
  });

  it("default mode: a registered submodule stays metadata-only, not misclassified as nested", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    const headSha = g(dir, "rev-parse", "HEAD").trim();
    g(dir, "update-index", "--add", "--cacheinfo", `160000,${headSha},vendor-lib`);
    // A checked-out submodule has a real `.git`, exactly like a nested repo —
    // it must be a genuine repository (not a dangling gitdir pointer) so
    // `git status` in the parent doesn't choke walking it.
    mkdirSync(join(dir, "vendor-lib"));
    g(join(dir, "vendor-lib"), "init", "-q", "-b", "main");
    const result = captureWorkspace(dir, "default");
    const sub = candidate(result, "vendor-lib");
    expect(sub?.kind).toBe("submodule");
    expect(sub?.blobSha).toBe(headSha);
    expect(result.preExcluded).not.toContainEqual({
      path: "vendor-lib",
      class: "nested_repository",
    });
  });

  it("staged mode: a registered submodule stays metadata-only, not misclassified as nested", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    const headSha = g(dir, "rev-parse", "HEAD").trim();
    g(dir, "update-index", "--add", "--cacheinfo", `160000,${headSha},vendor-lib`);
    mkdirSync(join(dir, "vendor-lib"));
    g(join(dir, "vendor-lib"), "init", "-q", "-b", "main");
    const result = captureWorkspace(dir, "staged");
    const sub = candidate(result, "vendor-lib");
    expect(sub?.kind).toBe("submodule");
    expect(sub?.blobSha).toBe(headSha);
    expect(result.preExcluded).not.toContainEqual({
      path: "vendor-lib",
      class: "nested_repository",
    });
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

  it("race-safe read: an ancestor directory swapped for a symlink out of the root excludes the file", () => {
    const dir = makeDir();
    const outside = makeDir();
    mkdirSync(join(outside, "pkg"));
    writeFileSync(join(outside, "pkg", "victim.ts"), `ANCESTOR=${NESTED_CANARY}\n`);
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "victim.ts"), "innocent\n");
    writeFileSync(join(dir, "keep.ts"), "kept\n");
    const result = captureWorkspace(dir, "all");
    // The race: after classification, the classified ancestor is moved out of
    // the Workspace Root and replaced by a symlink to an attacker directory.
    renameSync(join(dir, "pkg"), join(outside, "moved-pkg"));
    symlinkSync(join(outside, "pkg"), join(dir, "pkg"));
    const { text, outcome } = canonicalOf(result);
    expect(text).not.toContain(NESTED_CANARY);
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "pkg/victim.ts",
      class: "unverifiable",
    });
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["keep.ts"]);
  });

  it("a symlink passed as the Workspace Root resolves to the physical directory and everything is bounded there", () => {
    const physical = makeDir();
    writeFileSync(join(physical, "real.ts"), "export const x = 1;\n");
    mkdirSync(join(physical, "sub"));
    writeFileSync(join(physical, "sub", "nested.ts"), "export const y = 2;\n");
    // The symlink itself lives outside the physical directory it points at.
    const linkParent = makeDir();
    const rootLink = join(linkParent, "root-link");
    symlinkSync(physical, rootLink);
    const result = captureWorkspace(rootLink, "all");
    // realpath resolution: the Workspace Root is the physical directory, not
    // the symlink path the user passed.
    expect(result.workspace.rootAbs).toBe(physical);
    const paths = capturedPaths(result);
    expect(paths).toEqual(["real.ts", "sub/nested.ts"]);
    // Paths are relative to the physical root — the symlink's parent never
    // appears anywhere in the payload.
    expect(paths.some((p) => p.includes(linkParent))).toBe(false);
    const { outcome } = canonicalOf(result);
    expect(outcome.snapshot?.map((s) => s.path).sort()).toEqual(["real.ts", "sub/nested.ts"]);
    expect(outcome.redaction.withheldFiles).toEqual([]);
  });

  it("verified-chain reads: deeply nested files still capture, and leak no descriptors", () => {
    const dir = makeDir();
    const deep = join("a", "b", "c", "d");
    mkdirSync(join(dir, deep), { recursive: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, deep, `f${i}.ts`), `export const f${i} = ${i};\n`);
    }
    // Unix allocates the lowest free descriptor, so a probe opened before and
    // after the capture lands on the same number unless the chain leaked one.
    const probe = join(dir, deep, "f0.ts");
    const before = openSync(probe, "r");
    closeSync(before);
    const { outcome } = canonicalOf(captureWorkspace(dir, "all"));
    const after = openSync(probe, "r");
    closeSync(after);
    expect(after).toBe(before);
    expect(outcome.snapshot).toHaveLength(40);
    expect(outcome.snapshot?.[0]).toEqual({ path: `a/b/c/d/f0.ts`, content: "export const f0 = 0;\n" });
    expect(outcome.redaction.withheldFiles).toEqual([]);
  });
});

describe("adversarial: sanitized Git subprocess environment (spec 4.2 item 10)", () => {
  // No inherited GIT_* variable may redirect where the collector's `git`
  // subprocess resolves the repository, index, or object database. If it
  // could, `git cat-file blob <sha>` (or the status/diff-index calls that
  // enumerate candidates) could pull bytes from an object store outside the
  // Workspace Root into the payload — breaching the Workspace Root boundary.
  const CANARY = "GIT_ENV_CANARY_7f2c19";

  function hashObject(repoDir: string, content: string): string {
    return execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repoDir,
      input: content,
      env: { ...process.env, ...GIT_ENV },
      encoding: "utf8",
    }).trim();
  }

  function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const prior: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) prior[key] = process.env[key];
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const key of Object.keys(vars)) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key] as string;
      }
    }
  }

  it("readBlob never resolves an inherited GIT_ALTERNATE_OBJECT_DIRECTORIES redirect", () => {
    const victim = makeRepo();
    writeFileSync(join(victim, "a.ts"), "a\n");
    commitAll(victim, "base");
    const result = captureWorkspace(victim, "default");
    const readers = makeContentReaders(result.workspace.rootAbs, result.workspace);

    const attacker = makeRepo();
    const canarySha = hashObject(attacker, CANARY);
    const attackerObjects = join(attacker, ".git", "objects");

    const blob = withEnv({ GIT_ALTERNATE_OBJECT_DIRECTORIES: attackerObjects }, () =>
      readers.readBlob(canarySha),
    );
    // The canary sha does not exist in the victim's own object database.
    // If the child process ever sees the inherited env var, it resolves the
    // sha via the attacker's alternates and returns the canary bytes instead
    // of correctly reporting "object not found".
    expect(blob).toBeNull();
  });

  it("staged and default capture ignore inherited GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY redirects: canary bytes never enter the payload", () => {
    const victim = makeRepo();
    writeFileSync(join(victim, "tracked.ts"), "tracked\n");
    commitAll(victim, "base");
    const baselineStaged = canonicalOf(captureWorkspace(victim, "staged"));
    const baselineDefault = canonicalOf(captureWorkspace(victim, "default"));

    // A scratch repo the collector never targets: it forges an index that
    // stages a file the victim never staged, backed by a canary blob only it
    // knows about.
    const scratch = makeRepo();
    const canarySha = hashObject(scratch, CANARY);
    const forgedIndex = join(scratch, "forged-index");
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `100644,${canarySha},leak.txt`],
      {
        cwd: scratch,
        env: { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: forgedIndex },
        encoding: "utf8",
      },
    );

    withEnv(
      {
        GIT_INDEX_FILE: forgedIndex,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(scratch, ".git", "objects"),
      },
      () => {
        const staged = canonicalOf(captureWorkspace(victim, "staged"));
        expect(staged.text).not.toContain(CANARY);
        expect(staged.text).not.toContain("leak.txt");
        expect(staged.outcome.manifest).toEqual(baselineStaged.outcome.manifest);

        const def = canonicalOf(captureWorkspace(victim, "default"));
        expect(def.text).not.toContain(CANARY);
        expect(def.text).not.toContain("leak.txt");
        expect(def.outcome.manifest).toEqual(baselineDefault.outcome.manifest);
      },
    );
  });
});

describe("adversarial: repo-defined textconv/external-diff drivers never execute during capture (TER-35 finding)", () => {
  // A malicious repository can define a `diff.<name>.textconv` command and
  // map a file to it via `.gitattributes`, or set `diff.external` outright —
  // both are ordinary, non-privileged repo-local Git config. If the
  // collector's `git diff-index` invocations ever ran either driver, that
  // would be arbitrary command execution sourced from files inside the
  // Workspace Root, which spec 4.2/collector-never-executes-repository-code
  // forbids outright.
  const CANARY = "TER35_DRIVER_CANARY_9c2e";

  // Marker files the drivers write on execution, plus a stdout string so a
  // driver that only prints (rather than touching disk) is still caught.
  function installEvilDrivers(dir: string): { textconvMarker: string; externalMarker: string } {
    const textconvMarker = join(dir, "TEXTCONV_EXECUTED");
    const externalMarker = join(dir, "EXTERNAL_EXECUTED");
    const textconvScript = join(dir, "evil-textconv.sh");
    const externalScript = join(dir, "evil-external.sh");
    writeFileSync(
      textconvScript,
      `#!/bin/sh\necho ${CANARY} > "${textconvMarker}"\necho ${CANARY}\n`,
    );
    writeFileSync(
      externalScript,
      `#!/bin/sh\necho ${CANARY} > "${externalMarker}"\necho ${CANARY}\nexit 0\n`,
    );
    chmodSync(textconvScript, 0o755);
    chmodSync(externalScript, 0o755);
    // Repo-local config (spec-relevant attacker surface — GIT_CONFIG_NOSYSTEM
    // only removes /etc/gitconfig, which an attacker committing a repo can
    // never reach anyway).
    g(dir, "config", "diff.evil.textconv", textconvScript);
    g(dir, "config", "diff.external", externalScript);
    writeFileSync(join(dir, ".gitattributes"), "*.bin diff=evil\n");
    return { textconvMarker, externalMarker };
  }

  function bothMarkersAbsent(markers: { textconvMarker: string; externalMarker: string }): boolean {
    return !existsSync(markers.textconvMarker) && !existsSync(markers.externalMarker);
  }

  it("every diff-index invocation carries --no-textconv and --no-ext-diff", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.ts"), "a\n");
    commitAll(dir, "base");
    writeFileSync(join(dir, "b.ts"), "b\n");
    g(dir, "add", "b.ts");
    g(dir, "mv", "a.ts", "renamed.ts");

    gitArgvLog.calls = [];
    captureWorkspace(dir, "staged");
    captureWorkspace(dir, "default");

    const diffIndexCalls = gitArgvLog.calls.filter((argv) => argv.includes("diff-index"));
    expect(diffIndexCalls.length).toBeGreaterThan(0);
    for (const argv of diffIndexCalls) {
      expect(argv).toContain("--no-textconv");
      expect(argv).toContain("--no-ext-diff");
    }
  });

  it("staged mode: no driver marker file appears and no canary bytes reach the payload", () => {
    const dir = makeRepo();
    const markers = installEvilDrivers(dir);
    writeFileSync(join(dir, ".gitattributes"), "*.bin diff=evil\n");
    writeFileSync(join(dir, "evil.bin"), "binary-looking-content ");
    commitAll(dir, "base");
    writeFileSync(join(dir, "evil.bin"), "more-binary-content -changed");
    g(dir, "add", "evil.bin");

    const { text } = canonicalOf(captureWorkspace(dir, "staged"));

    expect(bothMarkersAbsent(markers)).toBe(true);
    expect(text).not.toContain(CANARY);
  });

  it("default mode: a staged rename of the attribute-mapped file still never runs a driver", () => {
    const dir = makeRepo();
    const markers = installEvilDrivers(dir);
    writeFileSync(join(dir, ".gitattributes"), "*.bin diff=evil\n");
    writeFileSync(join(dir, "evil.bin"), "rename-me-binary-content ");
    commitAll(dir, "base");
    // A staged rename routes through parseDiffIndexRenames's diff-index call.
    g(dir, "mv", "evil.bin", "renamed.bin");

    const { text } = canonicalOf(captureWorkspace(dir, "default"));

    expect(bothMarkersAbsent(markers)).toBe(true);
    expect(text).not.toContain(CANARY);
  });

  it("results are byte-identical to a baseline repo with the same content but no driver configured", () => {
    const victim = makeRepo();
    installEvilDrivers(victim);
    writeFileSync(join(victim, ".gitattributes"), "*.bin diff=evil\n");
    writeFileSync(join(victim, "evil.bin"), "shared-binary-content ");
    commitAll(victim, "base");
    writeFileSync(join(victim, "evil.bin"), "shared-binary-content-changed ");
    g(victim, "add", "evil.bin");

    const baseline = makeRepo();
    // Same tracked content, including the same .gitattributes mapping, but no
    // diff.evil.textconv / diff.external configured in this repo's config —
    // isolating the driver config as the only variable.
    writeFileSync(join(baseline, ".gitattributes"), "*.bin diff=evil\n");
    writeFileSync(join(baseline, "evil.bin"), "shared-binary-content ");
    commitAll(baseline, "base");
    writeFileSync(join(baseline, "evil.bin"), "shared-binary-content-changed ");
    g(baseline, "add", "evil.bin");

    const victimStaged = canonicalOf(captureWorkspace(victim, "staged"));
    const baselineStaged = canonicalOf(captureWorkspace(baseline, "staged"));
    expect(victimStaged.outcome.manifest).toEqual(baselineStaged.outcome.manifest);

    const victimDefault = canonicalOf(captureWorkspace(victim, "default"));
    const baselineDefault = canonicalOf(captureWorkspace(baseline, "default"));
    expect(victimDefault.outcome.manifest).toEqual(baselineDefault.outcome.manifest);
  });
});
