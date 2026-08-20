// Git/worktree capture per the capture-mode matrix (spec 7.1/7.2/7.3).
// This is the ONLY collector module that touches the filesystem or Git.
//
// The collector never executes repository code. Git is invoked as a child
// process with hook execution disabled (`-c core.hooksPath=/dev/null`,
// `-c core.fsmonitor=false`, GIT_OPTIONAL_LOCKS=0) and only with read-side
// commands (rev-parse, symbolic-ref, status --porcelain=v2, diff-index,
// ls-files, cat-file) — no checkout, no smudge filters, no LFS downloads.
//
// Race-safe reads (spec 7.3): worktree files are opened with O_NOFOLLOW,
// verified with fstat against the classifying lstat (type + dev/inode), read
// once, with at most one re-classification retry. Node has no openat-style
// per-component no-follow traversal; as the documented platform fallback,
// every ancestor component is lstat-checked to be a non-symlink directory and
// any unverifiable identity EXCLUDES the file with reason code "unverifiable".

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { directoryDenyClass } from "./deny.js";
import type { LoadedPolicy } from "./deny.js";
import { isIgnored, orderRules, parseIgnoreFile } from "./ignore.js";
import type { IgnoreRule } from "./ignore.js";
import { CollectorError } from "./types.js";
import type {
  Candidate,
  CaptureMode,
  CaptureResult,
  ContentReaders,
  FileMode,
  ManifestStatus,
  WorkspaceInfo,
  WorktreeReadResult,
} from "./types.js";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_SHA = /^0+$/;
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;

// --- Hook-safe git invocation ---

function git(cwd: string, args: string[]): Buffer {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function gitText(cwd: string, args: string[]): string {
  return git(cwd, args).toString("utf8").trim();
}

function tryGitText(cwd: string, args: string[]): string | null {
  try {
    return gitText(cwd, args);
  } catch {
    return null;
  }
}

// --- Workspace detection ---

export function detectWorkspace(rootAbs: string): WorkspaceInfo {
  const toplevel = tryGitText(rootAbs, ["rev-parse", "--show-toplevel"]);
  if (toplevel === null) {
    return { rootAbs, label: basename(rootAbs), vcs: "none", unborn: false };
  }
  const headSha = tryGitText(rootAbs, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const branch = tryGitText(rootAbs, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return {
    rootAbs,
    label: basename(rootAbs),
    vcs: "git",
    ...(headSha !== null && headSha !== "" ? { headSha } : {}),
    unborn: headSha === null || headSha === "",
    ...(branch !== null && branch !== "" ? { branch } : {}),
  };
}

function gitToplevel(rootAbs: string): string {
  const toplevel = tryGitText(rootAbs, ["rev-parse", "--show-toplevel"]);
  if (toplevel === null) {
    throw new CollectorError("not_a_git_repository", `${rootAbs} is not inside a Git repository`);
  }
  return resolve(toplevel);
}

// Repo-root-relative path -> workspace-root-relative path, or null when the
// path lies outside the Workspace Root (subdirectory invocations).
function toWorkspaceRelative(repoRelPath: string, prefix: string): string | null {
  if (prefix === "") return repoRelPath;
  if (repoRelPath === prefix) return null;
  if (!repoRelPath.startsWith(`${prefix}/`)) return null;
  return repoRelPath.slice(prefix.length + 1);
}

// --- Capture entry point ---

export function captureWorkspace(rootPath: string, mode: CaptureMode): CaptureResult {
  // The Workspace Root is the resolved physical directory: resolving the
  // user-chosen root once keeps containment checks consistent with Git's
  // toplevel (which reports physical paths). Nothing below the root is ever
  // resolved through symlinks.
  const rootAbs = realpathSync(rootPath);
  const workspace = detectWorkspace(rootAbs);
  if (workspace.vcs === "none") {
    if (mode === "staged") {
      throw new CollectorError(
        "staged_outside_git",
        `--staged requires a Git repository; ${rootAbs} is not inside one`,
      );
    }
    const { candidates, preExcluded, policy } = walkWorkspace(rootAbs);
    return { workspace, kind: "snapshot", captureMode: mode, candidates, preExcluded, policy };
  }
  const enumerated =
    mode === "all"
      ? enumerateGitSnapshot(rootAbs)
      : mode === "staged"
        ? enumerateStaged(rootAbs, workspace)
        : enumerateDefault(rootAbs);
  // Nested .ternaryignore files anywhere a candidate lives are part of the
  // effective Local Policy; Git already applied .gitignore for us.
  const policy = loadLocalPolicy(
    rootAbs,
    "git",
    directoriesOf(enumerated.candidates.map((c) => c.path)),
  );
  return {
    workspace,
    kind: mode === "all" ? "snapshot" : "changeset",
    captureMode: mode,
    candidates: enumerated.candidates,
    preExcluded: enumerated.preExcluded,
    policy,
  };
}

// --- Default mode: HEAD vs combined index + worktree, worktree wins ---

interface StatusRecord {
  path: string;
  from?: string;
  similarity?: number;
  stagedChar: string;
  worktreeChar: string;
  headSha: string; // hH: blob sha in HEAD ("0..." when absent)
  indexSha: string;
  submodule: boolean;
  untracked: boolean;
}

function enumerateDefault(rootAbs: string): {
  candidates: Candidate[];
  preExcluded: Array<{ path: string; class: string }>;
} {
  const toplevel = gitToplevel(rootAbs);
  const prefix = relative(toplevel, rootAbs).split(sep).join("/");
  const out = git(toplevel, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "--no-renames",
    "-z",
  ]);
  // Renames are detected separately below; --no-renames keeps worktree-wins
  // merging simple, then staged renames are layered back in from diff-index.
  const records = parseStatusV2(out);
  const stagedRenames = new Map<string, { from: string; similarity: number; baseSha: string }>();
  for (const [to, rename] of parseDiffIndexRenames(toplevel)) {
    const toRel = toWorkspaceRelative(to, prefix);
    if (toRel === null) continue;
    stagedRenames.set(toRel, {
      ...rename,
      from: toWorkspaceRelative(rename.from, prefix) ?? rename.from,
    });
  }
  const preExcluded: Array<{ path: string; class: string }> = [];
  const byPath = new Map<string, StatusRecord>();
  for (const record of records) {
    const rel = toWorkspaceRelative(record.path, prefix);
    if (rel === null) continue;
    record.path = rel;
    const existing = byPath.get(rel);
    if (existing === undefined) {
      byPath.set(rel, record);
    } else {
      // e.g. staged delete + untracked re-add: merge, worktree wins.
      byPath.set(rel, {
        ...existing,
        worktreeChar: record.untracked ? "." : record.worktreeChar,
        untracked: existing.untracked || record.untracked,
        headSha: ZERO_SHA.test(existing.headSha) ? record.headSha : existing.headSha,
      });
    }
  }

  // Rename sources are represented on the renamed entry ({from, to}), never
  // duplicated as a separate deletion (spec 7.2).
  const renameSources = new Set<string>();
  for (const [to, rename] of stagedRenames) {
    if (byPath.has(to)) renameSources.add(rename.from);
  }

  const candidates: Candidate[] = [];
  for (const record of byPath.values()) {
    if (renameSources.has(record.path)) continue;
    if (record.path.endsWith("/")) {
      // Untracked directory entry: only embedded (nested) repositories
      // surface this way under --untracked-files=all.
      const dirRel = record.path.slice(0, -1);
      if (existsSync(join(rootAbs, dirRel, ".git"))) {
        preExcluded.push({ path: dirRel, class: "nested_repository" });
      }
      continue;
    }
    const inHead = !ZERO_SHA.test(record.headSha);
    if (record.submodule) {
      candidates.push({
        path: record.path,
        status: inHead ? "modified" : "added",
        kind: "submodule",
        mode: "regular",
        size: 0,
        source: "worktree",
        ...(ZERO_SHA.test(record.indexSha) ? {} : { blobSha: record.indexSha }),
      });
      continue;
    }
    const worktreeDeleted = record.worktreeChar === "D";
    if (worktreeDeleted) {
      // Worktree wins: absent from the worktree means deleted vs HEAD —
      // unless HEAD never had it, in which case there is nothing to report.
      if (inHead) {
        candidates.push({
          path: record.path,
          status: "deleted",
          kind: "deleted",
          mode: "regular",
          size: 0,
          source: "worktree",
        });
      }
      continue;
    }
    const rename = stagedRenames.get(record.path);
    const status: ManifestStatus = inHead ? "modified" : rename !== undefined ? "renamed" : "added";
    candidates.push(
      classifyWorktreeCandidate(rootAbs, record.path, status, {
        ...(rename !== undefined ? { from: rename.from, similarity: rename.similarity } : {}),
        ...(inHead ? { baseSha: record.headSha } : rename !== undefined ? { baseSha: rename.baseSha } : {}),
      }),
    );
  }
  return { candidates, preExcluded };
}

function parseStatusV2(out: Buffer): StatusRecord[] {
  const tokens = out.toString("utf8").split("\0");
  const records: StatusRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "") continue;
    const type = token[0];
    if (type === "?") {
      records.push({
        path: token.slice(2),
        stagedChar: ".",
        worktreeChar: ".",
        headSha: "0",
        indexSha: "0",
        submodule: false,
        untracked: true,
      });
    } else if (type === "1") {
      const [fields, path] = splitFields(token, 8);
      records.push({
        path,
        stagedChar: (fields[1] as string)[0] as string,
        worktreeChar: (fields[1] as string)[1] as string,
        headSha: fields[6] as string,
        indexSha: fields[7] as string,
        submodule: (fields[2] as string).startsWith("S"),
        untracked: false,
      });
    } else if (type === "2") {
      const [fields, path] = splitFields(token, 9);
      i++; // consume the NUL-separated original path
      records.push({
        path,
        from: tokens[i],
        stagedChar: (fields[1] as string)[0] as string,
        worktreeChar: (fields[1] as string)[1] as string,
        headSha: fields[6] as string,
        indexSha: fields[7] as string,
        submodule: (fields[2] as string).startsWith("S"),
        untracked: false,
      });
    } else if (type === "u") {
      const [fields, path] = splitFields(token, 10);
      records.push({
        path,
        stagedChar: "U",
        worktreeChar: (fields[1] as string)[1] as string,
        headSha: fields[7] as string,
        indexSha: fields[8] as string,
        submodule: (fields[2] as string).startsWith("S"),
        untracked: false,
      });
    }
    // "!" (ignored) and "#" (headers) are not requested and are skipped.
  }
  return records;
}

function splitFields(token: string, count: number): [string[], string] {
  const fields: string[] = [];
  let rest = token;
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(" ");
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  return [fields, rest];
}

// Staged rename detection for default mode (worktree-wins statuses come from
// porcelain status; rename pairs and base shas come from plumbing diff-index).
function parseDiffIndexRenames(
  toplevel: string,
): Map<string, { from: string; similarity: number; baseSha: string }> {
  const renames = new Map<string, { from: string; similarity: number; baseSha: string }>();
  const base = tryGitText(toplevel, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (base === null || base === "") return renames;
  const out = git(toplevel, ["diff-index", "--cached", "-M", "-z", base]);
  for (const record of parseDiffIndexZ(out)) {
    if (record.status.startsWith("R")) {
      renames.set(record.path, {
        from: record.fromPath ?? record.path,
        similarity: Number.parseInt(record.status.slice(1), 10) || 0,
        baseSha: record.oldSha,
      });
    }
  }
  return renames;
}

// --- Staged mode: HEAD vs index only ---

interface DiffIndexRecord {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  path: string; // rename/copy: destination
  fromPath?: string;
}

function parseDiffIndexZ(out: Buffer): DiffIndexRecord[] {
  const tokens = out.toString("utf8").split("\0");
  const records: DiffIndexRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i] as string;
    if (!meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(" ");
    const status = parts[4] as string;
    const isPair = status.startsWith("R") || status.startsWith("C");
    const first = tokens[++i] as string;
    if (isPair) {
      const second = tokens[++i] as string;
      records.push({
        oldMode: parts[0] as string,
        newMode: parts[1] as string,
        oldSha: parts[2] as string,
        newSha: parts[3] as string,
        status,
        path: second,
        fromPath: first,
      });
    } else {
      records.push({
        oldMode: parts[0] as string,
        newMode: parts[1] as string,
        oldSha: parts[2] as string,
        newSha: parts[3] as string,
        status,
        path: first,
      });
    }
  }
  return records;
}

function enumerateStaged(
  rootAbs: string,
  workspace: WorkspaceInfo,
): { candidates: Candidate[]; preExcluded: Array<{ path: string; class: string }> } {
  const toplevel = gitToplevel(rootAbs);
  const prefix = relative(toplevel, rootAbs).split(sep).join("/");
  const base = workspace.unborn ? EMPTY_TREE_SHA : (workspace.headSha as string);
  const out = git(toplevel, ["diff-index", "--cached", "-M", "-z", base]);
  const candidates: Candidate[] = [];
  for (const record of parseDiffIndexZ(out)) {
    const rel = toWorkspaceRelative(record.path, prefix);
    if (rel === null) continue;
    const from =
      record.fromPath !== undefined
        ? (toWorkspaceRelative(record.fromPath, prefix) ?? record.fromPath)
        : undefined;
    const letter = record.status[0] as string;
    if (letter === "D") {
      candidates.push({
        path: rel,
        status: "deleted",
        kind: "deleted",
        mode: "regular",
        size: 0,
        source: "index",
      });
      continue;
    }
    if (record.newMode === "160000") {
      candidates.push({
        path: rel,
        status: letter === "A" ? "added" : "modified",
        kind: "submodule",
        mode: "regular",
        size: 0,
        source: "index",
        blobSha: record.newSha,
      });
      continue;
    }
    if (record.newMode === "120000") {
      // Symlink: the blob holds the literal target string.
      const target = git(toplevel, ["cat-file", "blob", record.newSha]).toString("utf8");
      candidates.push({
        path: rel,
        status: letter === "A" ? "added" : "modified",
        kind: "symlink",
        mode: "symlink",
        size: Buffer.byteLength(target, "utf8"),
        linkTarget: target,
        source: "index",
      });
      continue;
    }
    const status: ManifestStatus =
      letter === "A" || letter === "C" ? "added" : letter === "R" ? "renamed" : "modified";
    candidates.push({
      path: rel,
      status,
      kind: "regular",
      mode: record.newMode === "100755" ? "executable" : "regular",
      size: 0, // bytes actually read from the index blob win
      source: "index",
      blobSha: record.newSha,
      ...(status !== "added" && !ZERO_SHA.test(record.oldSha) ? { baseSha: record.oldSha } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(status === "renamed"
        ? { similarity: Number.parseInt(record.status.slice(1), 10) || 0 }
        : {}),
    });
  }
  return { candidates, preExcluded: [] };
}

// --- Snapshot in a Git repository (--all) ---

function enumerateGitSnapshot(rootAbs: string): {
  candidates: Candidate[];
  preExcluded: Array<{ path: string; class: string }>;
} {
  const toplevel = gitToplevel(rootAbs);
  const prefix = relative(toplevel, rootAbs).split(sep).join("/");
  const preExcluded: Array<{ path: string; class: string }> = [];
  // Tracked entry metadata (detects gitlinks/submodules without touching them).
  const staged = git(toplevel, ["ls-files", "-s", "-z"]).toString("utf8");
  const gitlinks = new Map<string, string>();
  for (const line of staged.split("\0")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const meta = line.slice(0, tab).split(" ");
    if (meta[0] === "160000") gitlinks.set(line.slice(tab + 1), meta[1] as string);
  }
  const names = git(toplevel, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .toString("utf8")
    .split("\0")
    .filter((n) => n !== "");
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const repoRel of names) {
    if (seen.has(repoRel)) continue;
    seen.add(repoRel);
    const rel = toWorkspaceRelative(repoRel, prefix);
    if (rel === null) continue;
    const gitlinkSha = gitlinks.get(repoRel);
    if (gitlinkSha !== undefined) {
      candidates.push({
        path: rel,
        status: "unchanged",
        kind: "submodule",
        mode: "regular",
        size: 0,
        source: "worktree",
        blobSha: gitlinkSha,
      });
      continue;
    }
    candidates.push(classifyWorktreeCandidate(rootAbs, rel, "unchanged", {}));
  }
  return { candidates, preExcluded };
}

// --- Non-Git bounded snapshot walk ---

// Ignore files that live in one directory, parsed with that directory as
// their base so their rules stay scoped to it (spec: Local Policy is
// resolved locally and recorded verbatim).
function loadIgnoreFilesIn(rootAbs: string, relDir: string, vcs: "git" | "none"): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const name of ignoreFileNames(vcs)) {
    const file = relDir === "" ? join(rootAbs, name) : join(rootAbs, relDir, name);
    if (existsSync(file)) rules.push(...parseIgnoreFile(readFileSync(file, "utf8"), relDir));
  }
  return rules;
}

function walkWorkspace(rootAbs: string): {
  candidates: Candidate[];
  preExcluded: Array<{ path: string; class: string }>;
  policy: LoadedPolicy;
} {
  const candidates: Candidate[] = [];
  const preExcluded: Array<{ path: string; class: string }> = [];
  const allRules: IgnoreRule[] = [];
  const visit = (dirAbs: string, relPrefix: string, inherited: IgnoreRule[]): void => {
    // Nested ignore files are loaded on the way down, so a deeper file's
    // rules already win for everything below it.
    const own = loadIgnoreFilesIn(rootAbs, relPrefix, "none");
    allRules.push(...own);
    const rules = own.length === 0 ? inherited : [...inherited, ...own];
    const entries = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const denied = directoryDenyClass(entry.name);
        if (denied !== null) {
          preExcluded.push({ path: rel, class: denied });
          continue;
        }
        if (existsSync(join(dirAbs, entry.name, ".git"))) {
          preExcluded.push({ path: rel, class: "nested_repository" });
          continue;
        }
        if (isIgnored(rules, rel, true)) {
          preExcluded.push({ path: rel, class: "policy_excluded" });
          continue;
        }
        visit(join(dirAbs, entry.name), rel, rules);
      } else if (isIgnored(rules, rel)) {
        // Ignored files never surface, matching Git's own behavior for
        // ignored untracked files in the Git capture modes.
        continue;
      } else if (entry.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(join(dirAbs, entry.name), "utf8");
        } catch {
          preExcluded.push({ path: rel, class: "unverifiable" });
          continue;
        }
        candidates.push({
          path: rel,
          status: "unchanged",
          kind: "symlink",
          mode: "symlink",
          size: Buffer.byteLength(target, "utf8"),
          linkTarget: target,
          source: "worktree",
        });
      } else if (entry.isFile()) {
        candidates.push(classifyWorktreeCandidate(rootAbs, rel, "unchanged", {}));
      }
      // Sockets, FIFOs, devices: never captured.
    }
  };
  visit(rootAbs, "", []);
  const ordered = orderRules(allRules);
  const excludePatterns = allRules
    .map((rule) => (rule.base === "" ? rule.pattern : `${rule.base}/:${rule.pattern}`))
    .sort();
  return { candidates, preExcluded, policy: { excludeRules: ordered, excludePatterns } };
}

// --- Worktree classification and race-safe reading (spec 7.3) ---

function classifyWorktreeCandidate(
  rootAbs: string,
  rel: string,
  status: ManifestStatus,
  extra: Partial<Candidate>,
): Candidate {
  try {
    const st = lstatSync(join(rootAbs, rel));
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(join(rootAbs, rel), "utf8");
      } catch {
        // fall through with an empty target; the link is still never followed
      }
      return {
        path: rel,
        status,
        kind: "symlink",
        mode: "symlink",
        size: Buffer.byteLength(target, "utf8"),
        linkTarget: target,
        source: "worktree",
        ...extra,
      };
    }
    const mode: FileMode = (st.mode & 0o100) !== 0 ? "executable" : "regular";
    return {
      path: rel,
      status,
      kind: "regular",
      mode,
      size: st.size,
      source: "worktree",
      classifyingStat: { dev: st.dev, ino: st.ino },
      ...extra,
    };
  } catch {
    // Disappeared between enumeration and classification; the verified read
    // will fail and the pipeline records the exclusion.
    return { path: rel, status, kind: "regular", mode: "regular", size: 0, source: "worktree", ...extra };
  }
}

export function makeContentReaders(rootAbs: string, workspace: WorkspaceInfo): ContentReaders {
  const gitCwd = workspace.vcs === "git" ? rootAbs : null;
  return {
    readWorktree(relPath, classify): WorktreeReadResult {
      return readWorktreeVerified(rootAbs, relPath, classify);
    },
    readBlob(sha) {
      if (gitCwd === null || ZERO_SHA.test(sha)) return null;
      try {
        return git(gitCwd, ["cat-file", "blob", sha]);
      } catch {
        return null;
      }
    },
  };
}

function readWorktreeVerified(
  rootAbs: string,
  relPath: string,
  classify: { dev: number; ino: number } | undefined,
): WorktreeReadResult {
  // Platform fallback for openat-per-component: every ancestor must be a
  // real (non-symlink) directory under the Workspace Root.
  const abs = join(rootAbs, relPath);
  let ancestor = dirname(abs);
  try {
    while (ancestor.length >= rootAbs.length && ancestor !== dirname(ancestor)) {
      if (lstatSync(ancestor).isSymbolicLink()) return { ok: false, reason: "unverifiable" };
      if (ancestor === rootAbs) break;
      ancestor = dirname(ancestor);
    }
  } catch {
    return { ok: false, reason: "unverifiable" };
  }

  let expected = classify;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | null = null;
    try {
      if (expected === undefined) {
        const st = lstatSync(abs);
        if (!st.isFile()) return { ok: false, reason: "unverifiable" };
        expected = { dev: st.dev, ino: st.ino };
      }
      // O_NOFOLLOW rejects a symlink in the final component (ELOOP).
      fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const fst = fstatSync(fd);
      if (fst.isFile() && fst.dev === expected.dev && fst.ino === expected.ino) {
        const bytes = readFileSync(fd);
        return { ok: true, bytes };
      }
      // Identity mismatch: one bounded re-classification retry (spec 7.3).
      expected = undefined;
    } catch {
      return { ok: false, reason: "unverifiable" };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return { ok: false, reason: "unverifiable" };
}

// --- Local Policy loading ---
//
// `.ternaryignore` is always ours to interpret (Git knows nothing about it).
// `.gitignore` is Git's in Git capture modes — ignored files never become
// candidates there — and ours only in a non-Git workspace.
//
// Nested ignore files are honored: every directory that contributes a
// candidate is checked for its own ignore files, and a deeper file's rules
// win (ignore.ts orderRules).

export function ignoreFileNames(vcs: "git" | "none"): string[] {
  return vcs === "git" ? [".ternaryignore"] : [".gitignore", ".ternaryignore"];
}

/** Every directory prefix of the given relative paths, including "" (root). */
export function directoriesOf(relPaths: readonly string[]): string[] {
  const dirs = new Set<string>([""]);
  for (const rel of relPaths) {
    const segments = rel.split("/");
    for (let i = 0; i < segments.length - 1; i++) {
      dirs.add(segments.slice(0, i + 1).join("/"));
    }
  }
  return [...dirs].sort();
}

export function loadLocalPolicy(
  rootAbs: string,
  vcs: "git" | "none",
  dirs: readonly string[] = [""],
): LoadedPolicy {
  const excludeRules: IgnoreRule[] = [];
  const excludePatterns: string[] = [];
  for (const dir of [...dirs].sort()) {
    for (const name of ignoreFileNames(vcs)) {
      const file = dir === "" ? join(rootAbs, name) : join(rootAbs, dir, name);
      if (!existsSync(file)) continue;
      const rules = parseIgnoreFile(readFileSync(file, "utf8"), dir);
      excludeRules.push(...rules);
      for (const rule of rules) {
        excludePatterns.push(dir === "" ? rule.pattern : `${dir}/:${rule.pattern}`);
      }
    }
  }
  excludePatterns.sort();
  return { excludeRules: orderRules(excludeRules), excludePatterns };
}
