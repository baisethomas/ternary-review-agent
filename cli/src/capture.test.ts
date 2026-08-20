import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
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
import { afterAll, describe, expect, it } from "vitest";
import { captureWorkspace, loadLocalPolicy, makeContentReaders } from "./capture.js";
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

  it("default mode: staged rename whose target is then deleted in the worktree (documents current behavior)", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "before.ts"), "line one\nline two\nline three\n");
    commitAll(dir, "base");
    g(dir, "mv", "before.ts", "after.ts");
    rmSync(join(dir, "after.ts"));
    const result = captureWorkspace(dir, "default");
    // Documents current behavior for a neighboring case surfaced while fixing
    // the staged-deletion finding; not itself part of that fix (see report).
    expect(capturedPaths(result)).toEqual([]);
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
