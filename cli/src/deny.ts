// Exclusion pipeline: deny classes (spec 4.2), Local Policy excludes, caps.
// First-class stage of the collector — capture output cannot reach the
// payload except through this pipeline. Deny classes are evaluated BEFORE
// policy includes and have no override in the alpha.
//
// Full deny-class hardening (richer secret heuristics, lossless invalid-UTF-8
// path encoding, gitignore fidelity) is TER-36; the pipeline structure and the
// spec's obvious deny classes live here now.
//
// Pure module: all filesystem/git reads are injected via ContentReaders.

import { unifiedDiff } from "./diff.js";
import {
  assertNoCaseCollisions,
  comparePathsBytewise,
  normalizePath,
} from "./payload.js";
import { DENY_RULES_VERSION, REDACTION_RULES_VERSION } from "./types.js";
import type {
  Candidate,
  Caps,
  CaptureResult,
  ChangesetEntry,
  ContentReaders,
  ManifestEntry,
  RedactionMetadata,
  SnapshotEntry,
} from "./types.js";

export { DENY_RULES_VERSION, REDACTION_RULES_VERSION };

// --- Deny classes (spec 4.2). Reason codes are safe to render. ---

export type DenyClass =
  | "env_file"
  | "key_material"
  | "credential_dir"
  | "token_store"
  | "vcs_metadata"
  | "dependencies"
  | "build_output"
  | "nested_repository"
  | "invalid_path"
  | "policy_excluded"
  | "snapshot_file_cap"
  | "submodule_metadata_only"
  | "unverifiable";

const KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const CREDENTIAL_DIRS = new Set([".aws", ".gcloud", ".azure", ".kube"]);
const VCS_DIRS = new Set([".git", ".hg", ".svn"]);
const DEPENDENCY_DIRS = new Set([
  "node_modules",
  "vendor",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);
const BUILD_DIRS = new Set(["dist", "build", ".next", "out", "coverage"]);
const TOKEN_STORE_NAMES = new Set([".npmrc", ".netrc", ".pypirc", ".git-credentials"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".tar", ".7z", ".jar",
  ".class", ".wasm", ".exe", ".dll", ".so", ".dylib", ".a", ".o",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".webm", ".sqlite", ".db",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

// Directory-level deny classes, used by capture to prune walks early and by
// the pipeline as the authoritative check.
export function directoryDenyClass(segment: string): DenyClass | null {
  if (VCS_DIRS.has(segment)) return "vcs_metadata";
  if (DEPENDENCY_DIRS.has(segment)) return "dependencies";
  if (BUILD_DIRS.has(segment)) return "build_output";
  if (CREDENTIAL_DIRS.has(segment)) return "credential_dir";
  return null;
}

export function pathDenyClass(relPath: string): DenyClass | null {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1] as string;
  for (let i = 0; i < segments.length - 1; i++) {
    const dirClass = directoryDenyClass(segments[i] as string);
    if (dirClass !== null) return dirClass;
  }
  // Deny class 1: environment files, at any depth, no override.
  if (base === ".env" || base.startsWith(".env.")) return "env_file";
  // Deny class 2: private keys and signing material by name.
  const ext = extensionOf(base);
  if (KEY_EXTENSIONS.has(ext)) return "key_material";
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return "key_material";
  // Deny class 3: cloud credential paths not caught by directory segments.
  if (relPath.includes(".config/gcloud/")) return "credential_dir";
  if (relPath.endsWith(".docker/config.json")) return "credential_dir";
  if (segments.includes(".terraform")) return "credential_dir";
  // Deny class 4 (name-based part): auth and token stores.
  if (TOKEN_STORE_NAMES.has(base)) return "token_store";
  if (ext === ".tfstate") return "token_store";
  // Deny class 5 covered by directoryDenyClass; also a bare file named .git.
  if (VCS_DIRS.has(base)) return "vcs_metadata";
  // Deny class 7: generated single-file artifacts.
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return "build_output";
  if (ext === ".map" && (base.endsWith(".js.map") || base.endsWith(".css.map"))) {
    return "build_output";
  }
  return null;
}

// --- Content classification ---

export function isBinaryContent(relPath: string, bytes: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extensionOf(relPath))) return true;
  const window = bytes.subarray(0, 8_000);
  if (window.includes(0)) return true;
  // Invalid UTF-8 marks the file binary (spec 7.2).
  return !isValidUtf8(bytes);
}

export function isValidUtf8(bytes: Buffer): boolean {
  return Buffer.compare(Buffer.from(bytes.toString("utf8"), "utf8"), bytes) === 0;
}

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

export function isKeyMaterialContent(text: string): boolean {
  return PEM_PRIVATE_KEY.test(text);
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

export function isLfsPointer(text: string): boolean {
  return text.startsWith(LFS_POINTER_PREFIX);
}

// --- Token redaction (deny class 4, content part) ---
// Pattern parity with src/lib/secret-redaction.ts; the server applies the
// same rules as defense in depth (spec 4.3).

const TOKEN_RULES: Array<{ rule: string; pattern: RegExp; replace: (m: string) => string }> = [
  {
    rule: "token.known-prefix",
    pattern: /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    replace: () => "[REDACTED]",
  },
  {
    rule: "token.authorization-bearer",
    pattern: /(authorization\s*:\s*bearer\s+)[^\s]+/gi,
    replace: (m) => m.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]"),
  },
];

export function redactTokens(text: string): {
  text: string;
  spans: Array<{ rule: string; count: number }>;
} {
  let out = text;
  const spans: Array<{ rule: string; count: number }> = [];
  for (const { rule, pattern, replace } of TOKEN_RULES) {
    const matches = out.match(pattern);
    if (matches !== null && matches.length > 0) {
      out = out.replace(pattern, (m) => replace(m));
      spans.push({ rule, count: matches.length });
    }
  }
  return { text: out, spans };
}

// --- Ignore files (.gitignore / .ternaryignore) ---
// Deliberately small glob subset for the alpha: blank lines and comments,
// `!` negation, leading `/` anchoring, trailing `/` directory patterns,
// `*`, `?`, and `**`. Full gitignore fidelity is TER-36. In Git capture
// modes Git itself already honors .gitignore (--exclude-standard /
// porcelain status); this matcher covers non-Git walks and .ternaryignore.

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    let body = line;
    let negated = false;
    if (body.startsWith("!")) {
      negated = true;
      body = body.slice(1);
    }
    let dirOnly = false;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (body === "") continue;
    const anchored = body.startsWith("/") || body.slice(0, -1).includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    const regex = globToRegex(body, anchored);
    rules.push({ pattern: line, negated, dirOnly, regex });
  }
  return rules;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "(?:.*)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  return new RegExp(`${prefix}${re}$`);
}

// Matches a normalized relative path against rules; last match wins.
// Pass isDir when the path names a directory so `dir/` rules can match it.
export function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDir = false): boolean {
  let ignored = false;
  const parents = relPath.split("/");
  for (const rule of rules) {
    let matched = rule.regex.test(relPath) && (!rule.dirOnly || isDir);
    if (!matched) {
      // Directory rules (and plain rules matching a parent directory).
      let prefix = "";
      for (let i = 0; i < parents.length - 1; i++) {
        prefix = prefix === "" ? (parents[i] as string) : `${prefix}/${parents[i] as string}`;
        if (rule.regex.test(prefix)) {
          matched = true;
          break;
        }
      }
      if (!matched && rule.dirOnly) continue;
    }
    if (matched) ignored = !rule.negated;
  }
  return ignored;
}

// --- Pipeline ---

export interface PipelineOutcome {
  manifest: ManifestEntry[];
  changeset?: ChangesetEntry[];
  snapshot?: SnapshotEntry[];
  redaction: RedactionMetadata;
  totalSourceBytes: number;
}

export interface LoadedPolicy {
  excludeRules: IgnoreRule[]; // .ternaryignore (+ .gitignore on non-Git walks)
  excludePatterns: string[]; // for EffectiveLocalPolicy, sorted
}

export function runExclusionPipeline(
  capture: CaptureResult,
  policy: LoadedPolicy,
  caps: Caps,
  readers: ContentReaders,
): PipelineOutcome {
  const withheldFiles: Array<{ path: string; class: string }> = [];
  const redactedSpans: Array<{ path: string; rule: string; count: number }> = [];
  const truncated: Array<{ path: string; originalBytes: number; keptBytes: number }> = [];
  const manifest: ManifestEntry[] = [];
  const changeset: ChangesetEntry[] = [];
  const snapshot: SnapshotEntry[] = [];
  const isChangeset = capture.kind === "changeset";
  for (const pre of capture.preExcluded) {
    withheldFiles.push({ path: escapeIllFormed(pre.path), class: pre.class });
  }
  let totalSourceBytes = 0;
  let contentCharsUsed = 0;
  let snapshotBytesUsed = 0;
  let snapshotFilesUsed = 0;

  // Normalize, sort, and validate determinism up front (spec 7.2, 8.3).
  const normalized: Array<{ candidate: Candidate; path: string }> = [];
  for (const candidate of capture.candidates) {
    if (!candidate.path.isWellFormed()) {
      withheldFiles.push({ path: escapeIllFormed(candidate.path), class: "invalid_path" });
      continue;
    }
    normalized.push({ candidate, path: normalizePath(candidate.path) });
  }
  normalized.sort((a, b) => comparePathsBytewise(a.path, b.path));
  assertNoCaseCollisions(normalized.map((n) => n.path));

  for (const { candidate, path } of normalized) {
    // Stage 1: deny classes — evaluated before any policy include (spec 4.2).
    const denied = pathDenyClass(path);
    if (denied !== null) {
      withheldFiles.push({ path, class: denied });
      continue;
    }
    // Stage 2: Local Policy excludes.
    if (isIgnored(policy.excludeRules, path)) {
      withheldFiles.push({ path, class: "policy_excluded" });
      continue;
    }
    // Stage 3: shape-specific handling.
    if (candidate.kind === "deleted") {
      manifest.push({
        path,
        status: "deleted",
        size: 0,
        mode: "regular",
        contentIncluded: false,
        ...(candidate.from !== undefined ? { from: normalizePath(candidate.from) } : {}),
      });
      continue;
    }
    if (candidate.kind === "symlink") {
      // Never followed; the literal target string only (spec 7.2).
      manifest.push({
        path,
        status: candidate.status,
        size: Buffer.byteLength(candidate.linkTarget ?? "", "utf8"),
        mode: "symlink",
        linkTarget: candidate.linkTarget ?? "",
        contentIncluded: false,
      });
      continue;
    }
    if (candidate.kind === "submodule") {
      // Metadata only: path + recorded commit SHA (spec 7.2). No bytes from
      // inside the submodule are ever read.
      manifest.push({
        path,
        status: candidate.status,
        size: 0,
        mode: "regular",
        contentIncluded: false,
        ...(candidate.blobSha !== undefined ? { blobSha: candidate.blobSha } : {}),
      });
      withheldFiles.push({ path, class: "submodule_metadata_only" });
      continue;
    }

    // Stage 4: read once from a verified handle (spec 7.3) and classify the
    // bytes actually read.
    let bytes: Buffer;
    if (candidate.source === "index") {
      const blob = candidate.blobSha !== undefined ? readers.readBlob(candidate.blobSha) : null;
      if (blob === null) {
        withheldFiles.push({ path, class: "unverifiable" });
        continue;
      }
      bytes = blob;
    } else {
      const result = readers.readWorktree(candidate.path, candidate.classifyingStat);
      if (!result.ok) {
        withheldFiles.push({ path, class: result.reason });
        continue;
      }
      bytes = result.bytes;
    }
    const size = bytes.byteLength;
    const baseEntry: ManifestEntry = {
      path,
      status: candidate.status,
      size,
      mode: candidate.mode,
      contentIncluded: false,
      ...(candidate.from !== undefined ? { from: normalizePath(candidate.from) } : {}),
      ...(candidate.similarity !== undefined ? { similarity: candidate.similarity } : {}),
      ...(candidate.blobSha !== undefined ? { blobSha: candidate.blobSha } : {}),
    };
    // Deny class 9: oversized files contribute no content bytes.
    if (size > caps.fileBytes) {
      manifest.push({ ...baseEntry, oversize: true });
      continue;
    }
    // Deny class 8: binary files contribute no content bytes.
    if (isBinaryContent(path, bytes)) {
      manifest.push({ ...baseEntry, binary: true });
      continue;
    }
    let text = bytes.toString("utf8");
    // Deny class 2 (content part): private key material withholds the file.
    if (isKeyMaterialContent(text)) {
      withheldFiles.push({ path, class: "key_material" });
      continue;
    }
    const lfs = isLfsPointer(text);
    // Deny class 4 (content part): token spans are redacted and recorded.
    const redacted = redactTokens(text);
    text = redacted.text;
    for (const span of redacted.spans) {
      redactedSpans.push({ path, rule: span.rule, count: span.count });
    }

    // Stage 5: budgets, deterministic in sorted path order.
    if (isChangeset) {
      const entry = buildChangesetEntry(candidate, path, text, readers);
      const cost = entry.patch?.length ?? entry.content?.length ?? 0;
      let included = true;
      if (contentCharsUsed + cost > caps.changesetChars) {
        const remaining = caps.changesetChars - contentCharsUsed;
        const full = entry.patch ?? entry.content ?? "";
        const kept = remaining > 0 ? full.slice(0, remaining) : "";
        truncated.push({
          path,
          originalBytes: Buffer.byteLength(full, "utf8"),
          keptBytes: Buffer.byteLength(kept, "utf8"),
        });
        if (kept === "") {
          included = false;
        } else if (entry.patch !== undefined) {
          entry.patch = kept;
        } else {
          entry.content = kept;
        }
        contentCharsUsed += kept.length;
      } else {
        contentCharsUsed += cost;
      }
      if (included) {
        changeset.push(entry);
        totalSourceBytes += size;
        manifest.push({ ...baseEntry, contentIncluded: true, ...(lfs ? { lfs: true } : {}) });
      } else {
        manifest.push({ ...baseEntry, ...(lfs ? { lfs: true } : {}) });
      }
    } else {
      if (snapshotFilesUsed >= caps.snapshotFiles) {
        withheldFiles.push({ path, class: "snapshot_file_cap" });
        continue;
      }
      let kept = text;
      if (snapshotBytesUsed + size > caps.snapshotBytes) {
        const remaining = Math.max(0, caps.snapshotBytes - snapshotBytesUsed);
        kept = sliceUtf8(text, remaining);
        truncated.push({
          path,
          originalBytes: size,
          keptBytes: Buffer.byteLength(kept, "utf8"),
        });
        if (kept === "") {
          manifest.push({ ...baseEntry, ...(lfs ? { lfs: true } : {}) });
          continue;
        }
      }
      const keptBytes = Buffer.byteLength(kept, "utf8");
      snapshotBytesUsed += keptBytes;
      snapshotFilesUsed += 1;
      totalSourceBytes += size;
      snapshot.push({ path, content: kept });
      manifest.push({ ...baseEntry, contentIncluded: true, ...(lfs ? { lfs: true } : {}) });
    }
  }

  // Stage 6: manifest cap — paths beyond the cap are counted, not listed.
  let omittedManifestEntries = 0;
  let boundedManifest = manifest;
  if (manifest.length > caps.manifestEntries) {
    omittedManifestEntries = manifest.length - caps.manifestEntries;
    boundedManifest = manifest.slice(0, caps.manifestEntries);
  }

  withheldFiles.sort((a, b) => comparePathsBytewise(a.path, b.path));
  redactedSpans.sort((a, b) => comparePathsBytewise(a.path, b.path));
  truncated.sort((a, b) => comparePathsBytewise(a.path, b.path));

  return {
    manifest: boundedManifest,
    ...(isChangeset ? { changeset } : {}),
    ...(!isChangeset ? { snapshot } : {}),
    redaction: {
      rulesVersion: REDACTION_RULES_VERSION,
      withheldFiles,
      redactedSpans,
      truncated,
      omittedManifestEntries,
    },
    totalSourceBytes,
  };
}

function buildChangesetEntry(
  candidate: Candidate,
  path: string,
  text: string,
  readers: ContentReaders,
): ChangesetEntry {
  if (candidate.status === "added" || candidate.baseSha === undefined) {
    return { path, status: "added", content: text };
  }
  const status = candidate.status === "renamed" ? "renamed" : "modified";
  const baseBytes = readers.readBlob(candidate.baseSha);
  if (baseBytes === null || isBinaryContent(path, baseBytes)) {
    // No usable text base: carry the full new text instead of a patch.
    return {
      path,
      status,
      content: text,
      ...(candidate.from !== undefined ? { from: normalizePath(candidate.from) } : {}),
    };
  }
  const patch = unifiedDiff(path, baseBytes.toString("utf8"), text);
  return {
    path,
    status,
    patch,
    ...(candidate.from !== undefined ? { from: normalizePath(candidate.from) } : {}),
  };
}

// Truncate a string so its UTF-8 encoding fits maxBytes without splitting a
// code point. Recorded truncation only — never a silent normalization.
function sliceUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  // Avoid splitting a surrogate pair.
  const sliced = text.slice(0, end);
  return sliced.isWellFormed() ? sliced : text.slice(0, Math.max(0, end - 1));
}

// Ill-formed path strings (invalid UTF-8 on disk) are excluded; the recorded
// path escapes each lone surrogate so the record itself stays well-formed.
// Byte-lossless encoding of invalid paths is TER-36.
export function escapeIllFormed(path: string): string {
  let out = "";
  for (const unit of path.split("")) {
    const code = unit.charCodeAt(0);
    out +=
      code >= 0xd800 && code <= 0xdfff && !unit.isWellFormed()
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : unit;
  }
  return out;
}
