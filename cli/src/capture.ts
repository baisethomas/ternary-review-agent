// Git/worktree capture per the capture-mode matrix (spec 7.1/7.2/7.3).
// This is the ONLY collector module that touches the filesystem or Git.
//
// The collector never executes repository code. Git is invoked as a child
// process with hook execution disabled (`-c core.hooksPath=/dev/null`,
// `-c core.fsmonitor=false`, GIT_OPTIONAL_LOCKS=0) and only with read-side
// commands (rev-parse, symbolic-ref, status --porcelain=v2, diff-index,
// ls-files, cat-file) — no checkout, no smudge filters, no LFS downloads.
//
// Race-safe reads (spec 7.3): every ancestor from the Workspace Root down is
// opened O_NOFOLLOW|O_DIRECTORY and fstat-matched against its own lstat, all
// those descriptors stay open across the leaf read, the leaf is opened
// O_NOFOLLOW and fstat-verified against the classifying lstat, and the chain
// identities are re-checked before any byte is read. One re-classification
// retry; any unverifiable identity EXCLUDES the file with reason code
// "unverifiable".

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
import { basename, join, relative, resolve, sep } from "node:path";
import { directoryDenyClass } from "./deny.js";
import type { LoadedPolicy } from "./deny.js";
import { isIgnored, orderRules, parseIgnoreFile } from "./ignore.js";
import type { IgnoreRule } from "./ignore.js";
import { encodePathBytes } from "./pathbytes.js";
import type { EncodedPath } from "./pathbytes.js";
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

// --- NUL-delimited git output, kept as bytes ---
//
// Git's `-z` output is raw bytes: a path that is not valid UTF-8 arrives as
// such. Decoding the whole buffer to a string would replace those bytes with
// U+FFFD — lossy, and two distinct files could collapse onto one manifest
// path. Tokens are therefore split as bytes and only the ASCII field prefixes
// are decoded as text; paths go through encodePathBytes (spec 7.2).

function splitNulBuffer(out: Buffer): Buffer[] {
  const tokens: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) {
      tokens.push(out.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < out.length) tokens.push(out.subarray(start));
  return tokens;
}

// Split `count` space-delimited ASCII fields off the front of a token; the
// remainder is the raw path.
function splitFieldsBuffer(token: Buffer, count: number): { fields: string[]; path: EncodedPath } {
  let offset = 0;
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    const space = token.indexOf(0x20, offset);
    if (space === -1) {
      fields.push(token.subarray(offset).toString("latin1"));
      offset = token.length;
      continue;
    }
    fields.push(token.subarray(offset, space).toString("latin1"));
    offset = space + 1;
  }
  return { fields, path: encodePathBytes(token.subarray(offset)) };
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
  // A Workspace Root is a directory. Passing a file (`ternary review .env`)
  // is rejected outright rather than treated as a one-file workspace, so no
  // argument can smuggle a denied file past the deny classes.
  if (!lstatSync(rootAbs).isDirectory()) {
    throw new CollectorError(
      "root_not_a_directory",
      `the Workspace Root must be a directory: ${rootAbs}`,
    );
  }
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

export interface StatusRecord {
  path: string;
  pathEncoded: boolean; // path bytes were not valid UTF-8 (spec 7.2)
  from?: string;
  similarity?: number;
  stagedChar: string;
  worktreeChar: string;
  headSha: string; // hH: blob sha in HEAD ("0..." when absent)
  indexSha: string;
  submodule: boolean;
  untracked: boolean;
}

// True when the path named by this record is absent from the final
// (worktree-wins) worktree: either the worktree side directly reports "D",
// or it's a staged deletion (`git rm`, index side "D") with no untracked
// file recreated at the path — porcelain then reports it as "D."
// (worktreeChar ".", not "D") rather than the direct worktree-delete shape.
// Worktree-wins still applies: if an untracked file was recreated at the
// path, this record was already merged with that untracked record (see the
// merge loop above), worktreeChar stays "." but `untracked` is set, so this
// returns false and the record falls through to the normal worktree-read
// path so the recreated content wins.
// Exported for direct unit testing of the four-case decision boundary
// (spec 7.1 worktree-wins semantics) — a pure predicate, so this is simpler
// than reconstructing every case through crafted git status output.
export function isWorktreeAbsent(record: StatusRecord): boolean {
  const worktreeDeleted = record.worktreeChar === "D";
  const stagedDeleted =
    !worktreeDeleted && !record.untracked && record.stagedChar === "D" && ZERO_SHA.test(record.indexSha);
  return worktreeDeleted || stagedDeleted;
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
    const fromRel = toWorkspaceRelative(rename.from, prefix);
    // Rename origin outside the Workspace Root (a Git subdirectory review):
    // the destination is captured as an addition, never a rename — leaving
    // it out of `stagedRenames` means the candidate loop below falls through
    // to `status: "added"` with no `from`/`similarity`/`baseSha` (spec
    // 4.1/4.2-10). The repo-relative origin path must never enter the
    // payload.
    if (fromRel === null) continue;
    stagedRenames.set(toRel, { ...rename, from: fromRel });
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
  // duplicated as a separate deletion (spec 7.2) — but only when both sides
  // of the pair still look like a plain rename in the final worktree:
  //   - the destination survives to be emitted as that renamed entry. If it
  //     was itself deleted from the worktree (and never recreated),
  //     suppressing the source too would drop the change entirely: the
  //     rename then collapses to a deletion of the source (TER-41), left to
  //     flow through the normal deletion path below instead of being
  //     suppressed here.
  //   - the source itself was not recreated. `--no-renames` reports a rename
  //     as a delete+add pair, so the source normally carries its own
  //     "absent from the worktree" record; if it was instead recreated as an
  //     untracked file after the rename, that record merges with `untracked:
  //     true` (see the merge loop above) and no longer represents a mere
  //     deletion — it must flow through and be captured as content.
  const renameSources = new Set<string>();
  for (const [to, rename] of stagedRenames) {
    const destRecord = byPath.get(to);
    if (destRecord === undefined || isWorktreeAbsent(destRecord)) continue;
    const sourceRecord = byPath.get(rename.from);
    if (sourceRecord === undefined || isWorktreeAbsent(sourceRecord)) {
      renameSources.add(rename.from);
    }
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
    if (record.pathEncoded) {
      // Invalid UTF-8 in the path: the manifest carries the lossless escaped
      // form, the file is never opened, and no content bytes are captured.
      candidates.push(invalidPathCandidate(record.path, inHead ? "modified" : "added"));
      continue;
    }
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
    if (isWorktreeAbsent(record)) {
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
  const tokens = splitNulBuffer(out);
  const records: StatusRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Buffer;
    if (token.length === 0) continue;
    const type = String.fromCharCode(token[0] as number);
    if (type === "?") {
      const path = encodePathBytes(token.subarray(2));
      records.push({
        path: path.path,
        pathEncoded: path.encoded,
        stagedChar: ".",
        worktreeChar: ".",
        headSha: "0",
        indexSha: "0",
        submodule: false,
        untracked: true,
      });
    } else if (type === "1" || type === "2" || type === "u") {
      const count = type === "1" ? 8 : type === "2" ? 9 : 10;
      const { fields, path } = splitFieldsBuffer(token, count);
      const xy = fields[1] as string;
      const shaFields = type === "u" ? [fields[7], fields[8]] : [fields[6], fields[7]];
      const record: StatusRecord = {
        path: path.path,
        pathEncoded: path.encoded,
        stagedChar: type === "u" ? "U" : (xy[0] as string),
        worktreeChar: xy[1] as string,
        headSha: shaFields[0] as string,
        indexSha: shaFields[1] as string,
        submodule: (fields[2] as string).startsWith("S"),
        untracked: false,
      };
      if (type === "2") {
        i++; // consume the NUL-separated original path
        const original = encodePathBytes((tokens[i] ?? Buffer.alloc(0)) as Buffer);
        record.from = original.path;
        record.pathEncoded = record.pathEncoded || original.encoded;
      }
      records.push(record);
    }
    // "!" (ignored) and "#" (headers) are not requested and are skipped.
  }
  return records;
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
  pathEncoded: boolean;
  fromPath?: string;
}

function parseDiffIndexZ(out: Buffer): DiffIndexRecord[] {
  const tokens = splitNulBuffer(out);
  const records: DiffIndexRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = (tokens[i] as Buffer).toString("latin1");
    if (!meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(" ");
    const status = parts[4] as string;
    const isPair = status.startsWith("R") || status.startsWith("C");
    const first = encodePathBytes(tokens[++i] ?? Buffer.alloc(0));
    const second = isPair ? encodePathBytes(tokens[++i] ?? Buffer.alloc(0)) : null;
    records.push({
      oldMode: parts[0] as string,
      newMode: parts[1] as string,
      oldSha: parts[2] as string,
      newSha: parts[3] as string,
      status,
      path: second === null ? first.path : second.path,
      pathEncoded: first.encoded || (second?.encoded ?? false),
      ...(second === null ? {} : { fromPath: first.path }),
    });
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
    if (rel === null) {
      // The destination lies outside the Workspace Root (a Git subdirectory
      // review). A rename/copy pair whose source is inside the root has, net
      // of the root, only the effect of removing the source — represent that
      // as a deletion (spec 7.2). A copy leaves the source untouched, so only
      // renames (not copies) synthesize a deletion here.
      if (
        !record.pathEncoded &&
        record.fromPath !== undefined &&
        record.status.startsWith("R")
      ) {
        const fromRel = toWorkspaceRelative(record.fromPath, prefix);
        if (fromRel !== null) {
          candidates.push({
            path: fromRel,
            status: "deleted",
            kind: "deleted",
            mode: "regular",
            size: 0,
            source: "index",
          });
        }
      }
      continue;
    }
    // Rename origin outside the Workspace Root: the destination is captured
    // as an addition, never a rename — `from`, `similarity`, and the
    // origin's base blob (`baseSha`) must never enter the payload (spec
    // 4.1/4.2-10). The repo-relative origin path itself must never appear.
    const fromRel =
      record.fromPath !== undefined ? toWorkspaceRelative(record.fromPath, prefix) : undefined;
    const renameOriginOutsideRoot = record.fromPath !== undefined && fromRel === null;
    const letter = record.status[0] as string;
    if (record.pathEncoded) {
      candidates.push(invalidPathCandidate(rel, letter === "A" ? "added" : "modified"));
      continue;
    }
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
      letter === "A" || letter === "C" || renameOriginOutsideRoot
        ? "added"
        : letter === "R"
          ? "renamed"
          : "modified";
    candidates.push({
      path: rel,
      status,
      kind: "regular",
      mode: record.newMode === "100755" ? "executable" : "regular",
      size: 0, // bytes actually read from the index blob win
      source: "index",
      blobSha: record.newSha,
      ...(status !== "added" && !ZERO_SHA.test(record.oldSha) ? { baseSha: record.oldSha } : {}),
      ...(status === "renamed" && fromRel !== undefined && fromRel !== null ? { from: fromRel } : {}),
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
  const gitlinks = new Map<string, string>();
  for (const line of splitNulBuffer(git(toplevel, ["ls-files", "-s", "-z"]))) {
    if (line.length === 0) continue;
    const tab = line.indexOf(0x09);
    const meta = line.subarray(0, tab).toString("latin1").split(" ");
    if (meta[0] === "160000") {
      gitlinks.set(encodePathBytes(line.subarray(tab + 1)).path, meta[1] as string);
    }
  }
  const names = splitNulBuffer(
    git(toplevel, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  )
    .filter((n) => n.length > 0)
    .map((n) => encodePathBytes(n));
  // Nested repositories are excluded entirely, descendants included (spec
  // 7.2). `ls-files` prunes nothing: an embedded repository surfaces as the
  // untracked directory entry `nested/`, and files that were tracked before
  // their directory became a repository keep surfacing individually.
  const nestedRepoDirs = new Map<string, boolean>();
  const isNestedRepoDir = (rel: string): boolean => {
    const cached = nestedRepoDirs.get(rel);
    if (cached !== undefined) return cached;
    const repoRel = prefix === "" ? rel : `${prefix}/${rel}`;
    // A registered submodule also holds a `.git`; it stays metadata-only.
    const nested = !gitlinks.has(repoRel) && existsSync(join(rootAbs, rel, ".git"));
    nestedRepoDirs.set(rel, nested);
    return nested;
  };
  // The shallowest nested-repository ancestor of a path, or null.
  const nestedRepoAncestor = (rel: string): string | null => {
    const segments = rel.split("/");
    for (let i = 1; i <= segments.length - 1; i++) {
      const dir = segments.slice(0, i).join("/");
      if (isNestedRepoDir(dir)) return dir;
    }
    return null;
  };
  const excludedNested = new Set<string>();
  const excludeNested = (dir: string): void => {
    if (excludedNested.has(dir)) return;
    excludedNested.add(dir);
    preExcluded.push({ path: dir, class: "nested_repository" });
  };

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const name of names) {
    const repoRel = name.path;
    if (seen.has(repoRel)) continue;
    seen.add(repoRel);
    const rel = toWorkspaceRelative(repoRel, prefix);
    if (rel === null) continue;
    if (rel.endsWith("/")) {
      // Directory entry: only embedded repositories surface this way.
      const dirRel = rel.slice(0, -1);
      if (isNestedRepoDir(dirRel)) excludeNested(dirRel);
      continue;
    }
    const nestedAncestor = nestedRepoAncestor(rel);
    if (nestedAncestor !== null) {
      excludeNested(nestedAncestor);
      continue;
    }
    if (name.encoded) {
      candidates.push(invalidPathCandidate(rel, "unchanged"));
      continue;
    }
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
    // Dirent names are read as bytes: Node's string decoding replaces invalid
    // UTF-8 with U+FFFD, which would be lossy and could collapse two distinct
    // names onto one manifest path (spec 7.2).
    const entries = readdirSync(dirAbs, { withFileTypes: true, encoding: "buffer" }).sort((a, b) =>
      Buffer.compare(a.name, b.name),
    );
    for (const entry of entries) {
      const decoded = encodePathBytes(entry.name);
      const rel = relPrefix === "" ? decoded.path : `${relPrefix}/${decoded.path}`;
      if (decoded.encoded) {
        // The escaped path does not name the entry on disk, so it is never
        // opened or descended into; only the lossless path is recorded.
        candidates.push(invalidPathCandidate(rel, "unchanged"));
        continue;
      }
      const name = decoded.path;
      if (entry.isDirectory()) {
        const denied = directoryDenyClass(name);
        if (denied !== null) {
          preExcluded.push({ path: rel, class: denied });
          continue;
        }
        if (existsSync(join(dirAbs, name, ".git"))) {
          preExcluded.push({ path: rel, class: "nested_repository" });
          continue;
        }
        if (isIgnored(rules, rel, true)) {
          preExcluded.push({ path: rel, class: "policy_excluded" });
          continue;
        }
        visit(join(dirAbs, name), rel, rules);
      } else if (isIgnored(rules, rel)) {
        // Ignored files never surface, matching Git's own behavior for
        // ignored untracked files in the Git capture modes.
        continue;
      } else if (entry.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(join(dirAbs, name), "utf8");
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

// A candidate whose path bytes are not valid UTF-8: represented losslessly,
// never opened, content always excluded (spec 7.2).
function invalidPathCandidate(encodedPath: string, status: ManifestStatus): Candidate {
  return {
    path: encodedPath,
    status,
    kind: "regular",
    mode: "regular",
    size: 0,
    source: "worktree",
    pathEncoded: true,
  };
}

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

// One verified ancestor: the identity its lstat reported and its open FD
// agreed on. The FD is held until the leaf read completes.
interface ChainLink {
  abs: string;
  dev: number;
  ino: number;
}

const DIR_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;

// Node exposes no openat/fchdir, so each component is still opened by its
// cumulative path; holding every ancestor FD open and requiring lstat and
// fstat to name the same inode detects a persistent replacement, but a
// flip-flop between the two calls would not be seen. That needs a
// concurrently running local attacker process, which spec 12 (Threat model,
// T12 / residual risks) places outside the alpha threat model — see that
// section for the accepted-risk rationale.
function openVerifiedChain(rootAbs: string, relPath: string, fds: number[]): ChainLink[] | null {
  const links: ChainLink[] = [];
  try {
    const rootStat = lstatSync(rootAbs);
    const rootFd = openSync(rootAbs, DIR_OPEN_FLAGS);
    fds.push(rootFd);
    const rootFstat = fstatSync(rootFd);
    if (
      rootStat.isSymbolicLink() ||
      !rootFstat.isDirectory() ||
      rootFstat.dev !== rootStat.dev ||
      rootFstat.ino !== rootStat.ino
    ) {
      throw new Error("identity mismatch");
    }
    links.push({ abs: rootAbs, dev: rootStat.dev, ino: rootStat.ino });
  } catch {
    // The Workspace Root is the anchor of every containment check; losing it
    // is the one condition that is not a per-file exclusion.
    throw new CollectorError(
      "workspace_root_unverifiable",
      `the Workspace Root could not be verified as a directory: ${rootAbs}`,
    );
  }
  const segments = relPath.split("/").slice(0, -1);
  let abs = rootAbs;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    abs = join(abs, segment);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      const fd = openSync(abs, DIR_OPEN_FLAGS);
      fds.push(fd);
      const fst = fstatSync(fd);
      if (!fst.isDirectory() || fst.dev !== st.dev || fst.ino !== st.ino) return null;
      links.push({ abs, dev: st.dev, ino: st.ino });
    } catch {
      return null;
    }
  }
  return links;
}

// Re-check the recorded chain identities after the leaf is open and before
// any byte is read.
function chainStillIntact(links: readonly ChainLink[]): boolean {
  for (const link of links) {
    try {
      const st = lstatSync(link.abs);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
      if (st.dev !== link.dev || st.ino !== link.ino) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function closeAll(fds: readonly number[]): void {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      // Already closed or invalid: nothing left to release.
    }
  }
}

function readWorktreeVerified(
  rootAbs: string,
  relPath: string,
  classify: { dev: number; ino: number } | undefined,
): WorktreeReadResult {
  const abs = join(rootAbs, relPath);
  let expected = classify;
  // Any mismatch, in the chain or at the leaf, gets one bounded
  // re-classification retry and then excludes the path (spec 7.3).
  for (let attempt = 0; attempt < 2; attempt++) {
    const fds: number[] = [];
    try {
      const chain = openVerifiedChain(rootAbs, relPath, fds);
      if (chain === null) {
        expected = undefined;
        continue;
      }
      if (expected === undefined) {
        const st = lstatSync(abs);
        if (!st.isFile()) return { ok: false, reason: "unverifiable" };
        expected = { dev: st.dev, ino: st.ino };
      }
      // O_NOFOLLOW rejects a symlink in the final component (ELOOP).
      const fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      fds.push(fd);
      const fst = fstatSync(fd);
      // Identity (leaf fstat vs. the classifying lstat) and the ancestor
      // chain are re-checked before any byte is read — including before the
      // hardlink check — matching spec 7.3's ordering exactly. A chain break
      // or identity mismatch always resolves to "unverifiable" first; only
      // once identity is confirmed does the hardlink check run.
      if (
        fst.isFile() &&
        fst.dev === expected.dev &&
        fst.ino === expected.ino &&
        chainStillIntact(chain)
      ) {
        if (fst.nlink > 1) {
          // A hard link is the same inode under another name, so an innocent
          // path can alias a denied file (`notes.txt` linked to `.env`) and
          // the path-based deny classes would never see it. The alias cannot
          // be resolved from the open handle, so exclusion is the only safe
          // answer — and it is recorded, never silent.
          return { ok: false, reason: "hardlink_alias" };
        }
        const bytes = readFileSync(fd);
        return { ok: true, bytes };
      }
      expected = undefined;
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      return { ok: false, reason: "unverifiable" };
    } finally {
      closeAll(fds);
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
