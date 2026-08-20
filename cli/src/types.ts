// Shared types and tunable defaults for the Workspace Review collector.
// The canonical payload shapes below implement docs/workspace-review-spec.md
// sections 8.2 and 8.4 exactly; any change here is a schema-version change.

export const SCHEMA_VERSION = "workspace-review/1";
export const TOOL_NAME = "ternary-cli";
export const TOOL_VERSION = "0.1.0";
// Bumped by TER-36: broader path deny classes (browser/keychain exports,
// .pgpass, .ssh/.gnupg, id_* at any depth), content heuristics beyond the
// server's mirrored patterns, and HEAD-side patch redaction. The canonical
// payload SHAPE is unchanged, so schemaVersion stays workspace-review/1
// (spec 8.1); only the rule-set versions move.
export const DENY_RULES_VERSION = "ternary-deny/2";
export const REDACTION_RULES_VERSION = "ternary-redaction/2";

export type ReviewKind = "changeset" | "snapshot";
export type CaptureMode = "default" | "staged" | "all";
export type FileMode = "regular" | "executable" | "symlink";
export type ManifestStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "unchanged";

// Tunable default limits (spec section 4.4). Every value is a non-negative
// integer; caps are enforced deterministically (truncate/skip and record).
export interface Caps {
  payloadBytes: number;
  changesetChars: number;
  contextExcerpts: number;
  contextChars: number;
  snapshotBytes: number;
  snapshotFiles: number;
  snapshotChunks: number;
  fileBytes: number;
  evidenceCapturedChars: number;
  evidenceModelChars: number;
  manifestEntries: number;
}

export const DEFAULT_CAPS: Caps = {
  payloadBytes: 2_000_000,
  changesetChars: 160_000,
  contextExcerpts: 8,
  contextChars: 20_000,
  snapshotBytes: 400_000,
  snapshotFiles: 500,
  snapshotChunks: 500,
  fileBytes: 200_000,
  evidenceCapturedChars: 24_000,
  evidenceModelChars: 1_500,
  manifestEntries: 5_000,
};

// --- Canonical payload schema (spec 8.2) ---

export interface ManifestEntry {
  path: string;
  status: ManifestStatus;
  from?: string;
  similarity?: number; // renamed only: integer 0-100
  size: number;
  mode: FileMode;
  linkTarget?: string; // symlink only: literal target string, never resolved
  blobSha?: string; // Git blob SHA when known (submodules: recorded commit SHA)
  binary?: true;
  oversize?: true;
  lfs?: true;
  contentIncluded: boolean;
}

export interface ChangesetEntry {
  path: string;
  status: "added" | "modified" | "renamed";
  from?: string;
  patch?: string; // unified diff text, UTF-8, no timestamps or index lines
  content?: string; // full file text for additions (mutually exclusive with patch)
}

export interface SnapshotEntry {
  path: string;
  content: string;
}

export interface ContextExcerpt {
  path: string;
  startLine: number; // 1-based, integer
  endLine: number; // inclusive, integer
  content: string;
}

export interface EffectiveLocalPolicy {
  captureMode: CaptureMode;
  include: string[]; // resolved glob patterns, sorted
  exclude: string[]; // resolved glob patterns, sorted
  denyRulesVersion: string;
  caps: Caps;
}

export interface CheckEvidence {
  origin: "local" | "sandbox";
  trust: "unverified_client" | "isolated";
  status: "complete" | "partial" | "unavailable";
  label: string;
  exitCode?: number;
  output?: string;
  durationMs?: number;
}

export interface RedactionMetadata {
  rulesVersion: string;
  withheldFiles: Array<{ path: string; class: string }>;
  redactedSpans: Array<{ path: string; rule: string; count: number }>;
  truncated: Array<{ path: string; originalBytes: number; keptBytes: number }>;
  // v1 addition beyond the spec 8.2 prose: spec 4.4 requires manifest paths
  // beyond the cap to be "counted, not listed"; this is that count.
  omittedManifestEntries: number;
}

export interface CanonicalPayload {
  schemaVersion: string;
  kind: ReviewKind;
  captureMode: CaptureMode;
  tool: { name: string; version: string };
  workspace: {
    label: string;
    vcs: "git" | "none";
    baseState?: { headSha: string } | "unborn"; // changeset only
    branch?: string;
  };
  manifest: ManifestEntry[];
  changeset?: ChangesetEntry[];
  snapshot?: SnapshotEntry[];
  context: ContextExcerpt[];
  localPolicy: EffectiveLocalPolicy;
  evidence?: CheckEvidence[];
  redaction: RedactionMetadata;
}

// --- Capture intermediates (collector-internal, never serialized) ---

export type CandidateKind = "regular" | "symlink" | "submodule" | "deleted";

export interface Candidate {
  path: string; // workspace-relative, "/" separators, pre-normalization
  status: ManifestStatus;
  from?: string;
  similarity?: number;
  kind: CandidateKind;
  mode: FileMode;
  size: number; // classifying size (bytes actually read wins later)
  linkTarget?: string;
  blobSha?: string; // content blob sha when the source is the Git index
  baseSha?: string; // HEAD-side blob sha, for patch bases
  source: "worktree" | "index";
  classifyingStat?: { dev: number; ino: number }; // for TOCTOU verification (7.3)
}

export interface WorkspaceInfo {
  rootAbs: string;
  label: string;
  vcs: "git" | "none";
  headSha?: string;
  unborn: boolean;
  branch?: string;
}

export interface CaptureResult {
  workspace: WorkspaceInfo;
  kind: ReviewKind;
  captureMode: CaptureMode;
  candidates: Candidate[];
  // Exclusions decided during enumeration (pruned deny-class directories,
  // nested repositories); merged into redaction.withheldFiles by the pipeline.
  preExcluded: Array<{ path: string; class: string }>;
}

// Content readers are injected into the exclusion pipeline so that deny.ts
// stays free of filesystem/git access (capture.ts owns all reads).
export type WorktreeReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "unverifiable" };

export interface ContentReaders {
  readWorktree(
    relPath: string,
    classify: { dev: number; ino: number } | undefined,
  ): WorktreeReadResult;
  readBlob(sha: string): Buffer | null;
}

export class CollectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CollectorError";
    this.code = code;
  }
}
