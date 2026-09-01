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
import { isIgnored } from "./ignore.js";
import type { LoadedPolicy } from "./ignore.js";
import { encodePathString } from "./pathbytes.js";
import { isKeyMaterialContent, redactSecretSpans } from "./secrets.js";
import { compareSnapshotPriority } from "./snapshot-priority.js";
import {
  assertNoCaseCollisions,
  comparePathsBytewise,
  normalizePath,
} from "./payload.js";
import { CollectorError, DENY_RULES_VERSION, REDACTION_RULES_VERSION } from "./types.js";
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
  | "hardlink_alias"
  | "unverifiable";

const KEY_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
  // Apple keychain exports and PKCS#8/PKCS#12 variants (spec 4.2 items 2, 4).
  ".keychain", ".keychain-db", ".p8", ".pkcs12", ".ppk",
]);
const CREDENTIAL_DIRS = new Set([
  ".aws", ".gcloud", ".azure", ".kube",
  // Equivalents in the spirit of spec 4.2 item 3 ("or equivalents").
  ".ssh", ".gnupg", ".password-store", ".chef", ".terraform",
]);
// Browser and OS credential stores that show up in home-directory-rooted or
// accidentally-committed workspaces (spec 4.2 item 4: "browser/keychain
// exports"). Matched on the basename at any depth.
const BROWSER_KEYCHAIN_EXPORTS = new Set([
  "login data",
  "login data for account",
  "cookies.sqlite",
  "logins.json",
  "key3.db",
  "key4.db",
  "signons.sqlite",
  "cert9.db",
  "keychain-db",
  "keepass.kdbx",
]);
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
const TOKEN_STORE_NAMES = new Set([
  ".npmrc", ".netrc", "_netrc", ".pypirc", ".git-credentials",
  // Postgres password file and other well-known credential files.
  ".pgpass", ".my.cnf", ".dockercfg", ".s3cfg", ".boto", "credentials.json",
  ".htpasswd", ".rediscli_auth", ".pgservicefile",
]);
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
  // `.envrc` (direnv) is included: it is an environment file in every sense
  // that matters here, and exclusion is always the safe failure mode.
  if (base === ".env" || base === ".envrc" || base.startsWith(".env.")) return "env_file";
  // Deny class 2: private keys and signing material by name, at any depth.
  const ext = extensionOf(base);
  if (KEY_EXTENSIONS.has(ext)) return "key_material";
  if (/^id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)/.test(base)) return "key_material";
  // Deny class 3: cloud credential paths not caught by directory segments.
  if (relPath.includes(".config/gcloud/")) return "credential_dir";
  if (relPath.endsWith(".docker/config.json")) return "credential_dir";
  if (segments.includes(".terraform")) return "credential_dir";
  // Deny class 4 (name-based part): auth and token stores.
  if (TOKEN_STORE_NAMES.has(base)) return "token_store";
  if (ext === ".tfstate" || ext === ".tfvars" || ext === ".kdbx") return "token_store";
  if (BROWSER_KEYCHAIN_EXPORTS.has(base.toLowerCase())) return "token_store";
  // Terraform state backups (`terraform.tfstate.backup`) and rotated secrets.
  if (base.includes(".tfstate.")) return "token_store";
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

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

export function isLfsPointer(text: string): boolean {
  return text.startsWith(LFS_POINTER_PREFIX);
}

// --- Token redaction (deny class 4, content part) ---
// The rules themselves live in secrets.ts; the first two are byte-for-byte
// parity with src/lib/secret-redaction.ts, which the server applies as
// defense in depth (spec 4.3).

export { isKeyMaterialContent, keyMaterialRule, redactSecretSpans } from "./secrets.js";

// --- Ignore files (.gitignore / .ternaryignore) ---
// Full gitignore semantics live in ignore.ts, pinned against Git itself.

export { isIgnored, orderRules, parseIgnoreFile } from "./ignore.js";
export type { IgnoreRule, LoadedPolicy } from "./ignore.js";

// --- Choke point for the `from` field (spec 4.1/4.2-10) ---
//
// Every candidate that reaches this pipeline is about to become the
// payload's only representation of a file. Only a "renamed" entry — or a
// "deleted" entry recording a rename collapse (TER-41) — may carry `from`.
// Any other status carrying `from` is exactly the leak shape that let a
// cross-Workspace-Root rename origin (a Git subdirectory review) reach the
// payload via a stale fallback: reject rather than transmit, so a future
// capture regression cannot reintroduce this class of leak silently.
function finalizeFrom(
  candidate: Candidate,
  path: string,
  effectiveStatus: string,
): string | undefined {
  if (candidate.from === undefined) return undefined;
  if (effectiveStatus !== "renamed" && effectiveStatus !== "deleted") {
    throw new CollectorError(
      "rename_metadata_leak",
      `candidate ${JSON.stringify(path)} has status ${JSON.stringify(effectiveStatus)} but carries a "from" field; only "renamed" or "deleted" candidates may`,
    );
  }
  return normalizePath(candidate.from);
}

// --- Pipeline ---

export interface PipelineOutcome {
  manifest: ManifestEntry[];
  changeset?: ChangesetEntry[];
  snapshot?: SnapshotEntry[];
  redaction: RedactionMetadata;
  totalSourceBytes: number;
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
    withheldFiles.push({ path: encodePathString(pre.path).path, class: pre.class });
  }
  let totalSourceBytes = 0;
  let contentCharsUsed = 0;
  let snapshotBytesUsed = 0;
  let snapshotFilesUsed = 0;
  // Snapshot mode only: candidates that survived every stage above, held back
  // so the budget can be spent in priority order rather than path order
  // (TER-43). Each carries the manifest entry already parked in bytewise
  // position, so selection can flip `contentIncluded` without reordering the
  // manifest (spec 7.2).
  const pendingSnapshot: Array<{
    path: string;
    text: string;
    size: number;
    entry: ManifestEntry;
  }> = [];
  const fileCapDropped = new Set<ManifestEntry>();

  // Normalize, sort, and validate determinism up front (spec 7.2, 8.3).
  const normalized: Array<{ candidate: Candidate; path: string }> = [];
  for (const candidate of capture.candidates) {
    if (!candidate.path.isWellFormed()) {
      // A path string that is not well-formed Unicode (lone surrogates) is
      // re-encoded losslessly rather than dropped (spec 7.2).
      const encoded = encodePathString(candidate.path);
      normalized.push({
        candidate: { ...candidate, path: encoded.path, pathEncoded: true },
        path: normalizePath(encoded.path),
      });
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
    if (candidate.pathEncoded === true) {
      // Invalid UTF-8 in the path (spec 7.2): the manifest carries the
      // lossless escaped path, the content is excluded, and the exclusion is
      // recorded. The file is never opened — the escaped string does not name
      // it on disk.
      manifest.push({
        path,
        status: candidate.status,
        size: 0,
        mode: candidate.mode,
        contentIncluded: false,
      });
      withheldFiles.push({ path, class: "invalid_path" });
      continue;
    }
    if (candidate.kind === "deleted") {
      const from = finalizeFrom(candidate, path, "deleted");
      manifest.push({
        path,
        status: "deleted",
        size: 0,
        mode: "regular",
        contentIncluded: false,
        ...(from !== undefined ? { from } : {}),
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
    const from = finalizeFrom(candidate, path, candidate.status);
    const baseEntry: ManifestEntry = {
      path,
      status: candidate.status,
      size,
      mode: candidate.mode,
      contentIncluded: false,
      ...(from !== undefined ? { from } : {}),
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
    const redacted = redactSecretSpans(text);
    text = redacted.text;
    for (const span of redacted.spans) {
      redactedSpans.push({ path, rule: span.rule, count: span.count });
    }

    // Stage 5: budgets, deterministic in sorted path order.
    if (isChangeset) {
      const built = buildChangesetEntry(candidate, path, text, readers);
      const entry = built.entry;
      for (const span of built.spans) {
        redactedSpans.push({ path, rule: span.rule, count: span.count });
      }
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
      // Snapshot mode defers the budget decision: park the manifest entry in
      // bytewise position now, choose content in priority order below.
      const entry: ManifestEntry = { ...baseEntry, ...(lfs ? { lfs: true } : {}) };
      manifest.push(entry);
      pendingSnapshot.push({ path, text, size, entry });
    }
  }

  // Stage 5b (snapshot only): spend the snapshot budget in priority order —
  // application source first, docs and generated files last (TER-43). The
  // semantics inside the walk are unchanged from the old bytewise walk: the
  // first file that overflows `snapshotBytes` is sliced to the remaining
  // budget, later files record a keptBytes-0 truncation, and files past
  // `snapshotFiles` are withheld as `snapshot_file_cap` with no manifest entry
  // at all — only the ORDER in which files meet those rules has changed.
  if (!isChangeset) {
    pendingSnapshot.sort((a, b) => compareSnapshotPriority(a.path, b.path));
    for (const p of pendingSnapshot) {
      if (snapshotFilesUsed >= caps.snapshotFiles) {
        withheldFiles.push({ path: p.path, class: "snapshot_file_cap" });
        fileCapDropped.add(p.entry);
        continue;
      }
      let kept = p.text;
      if (snapshotBytesUsed + p.size > caps.snapshotBytes) {
        const remaining = Math.max(0, caps.snapshotBytes - snapshotBytesUsed);
        kept = sliceUtf8(p.text, remaining);
        truncated.push({
          path: p.path,
          originalBytes: p.size,
          keptBytes: Buffer.byteLength(kept, "utf8"),
        });
        if (kept === "") continue;
      }
      const keptBytes = Buffer.byteLength(kept, "utf8");
      snapshotBytesUsed += keptBytes;
      snapshotFilesUsed += 1;
      totalSourceBytes += p.size;
      snapshot.push({ path: p.path, content: kept });
      p.entry.contentIncluded = true;
    }
  }

  // Stage 6: manifest cap — paths beyond the cap are counted, not listed.
  const orderedManifest =
    fileCapDropped.size === 0 ? manifest : manifest.filter((e) => !fileCapDropped.has(e));
  let omittedManifestEntries = 0;
  let boundedManifest = orderedManifest;
  if (orderedManifest.length > caps.manifestEntries) {
    omittedManifestEntries = orderedManifest.length - caps.manifestEntries;
    boundedManifest = orderedManifest.slice(0, caps.manifestEntries);
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

// A unified diff carries the HEAD-side lines verbatim, so the base blob is
// transmitted content and gets the same treatment as the worktree bytes:
// key material withholds the patch entirely (the new text is carried instead)
// and token spans are redacted, both recorded against the entry's path.
function buildChangesetEntry(
  candidate: Candidate,
  path: string,
  text: string,
  readers: ContentReaders,
): { entry: ChangesetEntry; spans: Array<{ rule: string; count: number }> } {
  if (candidate.status === "added" || candidate.baseSha === undefined) {
    const from = finalizeFrom(candidate, path, "added");
    return {
      entry: { path, status: "added", content: text, ...(from !== undefined ? { from } : {}) },
      spans: [],
    };
  }
  const status = candidate.status === "renamed" ? "renamed" : "modified";
  const from = finalizeFrom(candidate, path, status);
  const fromField = from !== undefined ? { from } : {};
  const baseBytes = readers.readBlob(candidate.baseSha);
  if (baseBytes === null || isBinaryContent(path, baseBytes)) {
    // No usable text base: carry the full new text instead of a patch.
    return { entry: { path, status, content: text, ...fromField }, spans: [] };
  }
  const baseText = baseBytes.toString("utf8");
  if (isKeyMaterialContent(baseText)) {
    // Deny class 2 applies to the base side too: no patch may exist.
    return {
      entry: { path, status, content: text, ...fromField },
      spans: [{ rule: "patch.base-withheld", count: 1 }],
    };
  }
  const redactedBase = redactSecretSpans(baseText);
  const patch = unifiedDiff(path, redactedBase.text, text);
  return { entry: { path, status, patch, ...fromField }, spans: redactedBase.spans };
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

