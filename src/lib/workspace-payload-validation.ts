/**
 * Strict validation of the versioned Canonical Payload
 * (docs/workspace-review-spec.md §8.2 / §8.4, docs/workspace-review-endpoint.md §4.4).
 *
 * The payload is the complete CLI↔server contract (spec fixed decision 9), so
 * validation here is deliberately unforgiving:
 *
 *   - unknown fields are rejected ANYWHERE, naming the offending path;
 *   - every number in the schema is a non-negative integer (§8.4) — floats,
 *     `-0`, `NaN`, and numeric strings are all rejected;
 *   - enums are exact;
 *   - absent optionals are OMITTED, never `null` (§8.4), so an explicit `null`
 *     is an error rather than a synonym for absent.
 *
 * The shipped `cli/fixtures/*.payload.json` are the conformance suite for both
 * sides; the sibling test validates every fixture against its canonical bytes
 * and digest.
 */

import { createHash } from "node:crypto";

/** The only schema version this server accepts (spec §8.1). */
export const WORKSPACE_SCHEMA_VERSION = "workspace-review/1";
export const ACCEPTED_SCHEMA_VERSIONS = [WORKSPACE_SCHEMA_VERSION] as const;

/** Canonical-payload byte cap (contract §4.3): spec §4.4's 2,000,000 rounded to 2 MiB, no slack. */
export const MAX_CANONICAL_PAYLOAD_BYTES = 2_097_152;

/** Digest header carrying SHA-256 of the exact canonical bytes (spec §8.3). */
export const PAYLOAD_DIGEST_HEADER = "x-ternary-payload-digest";

// --- Wire types (mirror of cli/src/types.ts; the CLI is a separate project) ---

export type WorkspacePayloadKind = "changeset" | "snapshot";
export type WorkspaceCaptureMode = "default" | "staged" | "all";
export type WorkspaceFileMode = "regular" | "executable" | "symlink";
export type WorkspaceManifestStatus = "added" | "modified" | "deleted" | "renamed" | "unchanged";

export type PayloadCaps = {
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
};

export type PayloadManifestEntry = {
  path: string;
  status: WorkspaceManifestStatus;
  from?: string;
  similarity?: number;
  size: number;
  mode: WorkspaceFileMode;
  linkTarget?: string;
  blobSha?: string;
  binary?: true;
  oversize?: true;
  lfs?: true;
  contentIncluded: boolean;
};

export type PayloadChangesetEntry = {
  path: string;
  status: "added" | "modified" | "renamed";
  from?: string;
  patch?: string;
  content?: string;
};

export type PayloadSnapshotEntry = { path: string; content: string };

export type PayloadContextExcerpt = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

/**
 * Evidence as it travels on the wire. This is the CLI's flat per-check shape
 * (`cli/src/types.ts`), NOT the grouped `CheckEvidence` in
 * `workspace-review-types.ts` that the analysis wrapper consumes. The route
 * adapts one to the other; the CLI is owned elsewhere and is not changed here.
 */
export type PayloadCheckEvidence = {
  origin: "local" | "sandbox";
  trust: "unverified_client" | "isolated";
  status: "complete" | "partial" | "unavailable";
  label: string;
  exitCode?: number;
  output?: string;
  durationMs?: number;
};

export type PayloadRedaction = {
  rulesVersion: string;
  withheldFiles: Array<{ path: string; class: string }>;
  redactedSpans: Array<{ path: string; rule: string; count: number }>;
  truncated: Array<{ path: string; originalBytes: number; keptBytes: number }>;
  omittedManifestEntries: number;
};

export type CanonicalWorkspacePayload = {
  schemaVersion: string;
  kind: WorkspacePayloadKind;
  captureMode: WorkspaceCaptureMode;
  tool: { name: string; version: string };
  workspace: {
    label: string;
    vcs: "git" | "none";
    baseState?: { headSha: string } | "unborn";
    branch?: string;
  };
  manifest: PayloadManifestEntry[];
  changeset?: PayloadChangesetEntry[];
  snapshot?: PayloadSnapshotEntry[];
  context: PayloadContextExcerpt[];
  localPolicy: {
    captureMode: WorkspaceCaptureMode;
    include: string[];
    exclude: string[];
    denyRulesVersion: string;
    caps: PayloadCaps;
  };
  evidence?: PayloadCheckEvidence[];
  redaction: PayloadRedaction;
};

// --- Validation machinery ---

export type PayloadValidationFailure =
  | { code: "unsupported_schema_version"; message: string; acceptedVersions: string[]; received?: string }
  | { code: "invalid_payload"; message: string; field: string };

export type PayloadValidationResult =
  | { ok: true; payload: CanonicalWorkspacePayload }
  | { ok: false; error: PayloadValidationFailure };

/** Internal signal carrying the failing field path; never escapes this module. */
class PayloadFieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "PayloadFieldError";
  }
}

function fail(field: string, message: string): never {
  throw new PayloadFieldError(field, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enforce the object contract at `field`: it must be a plain object with every
 * required key present and NO key outside required ∪ optional (spec §8.4).
 */
function requireObject(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null) fail(field, `${field} must not be null (absent optional fields are omitted, never null)`);
  if (!isPlainObject(value)) fail(field, `${field} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, `unknown field ${field}.${key} is not part of ${WORKSPACE_SCHEMA_VERSION}`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`${field}.${key}`, `${field}.${key} is required`);
    if (value[key] === null) fail(`${field}.${key}`, `${field}.${key} must not be null`);
  }
  for (const key of optional) {
    if (key in value && value[key] === null) {
      fail(`${field}.${key}`, `${field}.${key} must be omitted when absent, never null`);
    }
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, `${field} must be a string`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, `${field} must be a boolean`);
  return value;
}

/** Every number in the schema is a non-negative integer (spec §8.4). */
function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number") fail(field, `${field} must be a number`);
  if (!Number.isInteger(value)) fail(field, `${field} must be an integer (spec §8.4 permits no fractional numbers)`);
  if (Object.is(value, -0)) fail(field, `${field} must not be -0`);
  if (value < 0) fail(field, `${field} must be >= 0`);
  return value;
}

function requireEnum<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    fail(field, `${field} must be one of: ${options.join(", ")}`);
  }
  return value as T;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field, `${field} must be an array`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  return requireArray(value, field).map((item, index) => requireString(item, `${field}[${index}]`));
}

function requireTrueMarker(value: unknown, field: string): true {
  if (value !== true) fail(field, `${field} may only be the literal true when present`);
  return true;
}

// --- Per-shape validators ---

const CAP_KEYS = [
  "payloadBytes",
  "changesetChars",
  "contextExcerpts",
  "contextChars",
  "snapshotBytes",
  "snapshotFiles",
  "snapshotChunks",
  "fileBytes",
  "evidenceCapturedChars",
  "evidenceModelChars",
  "manifestEntries",
] as const;

function validateCaps(value: unknown, field: string): PayloadCaps {
  const raw = requireObject(value, field, CAP_KEYS);
  const caps = {} as PayloadCaps;
  for (const key of CAP_KEYS) caps[key] = requireNonNegativeInteger(raw[key], `${field}.${key}`);
  return caps;
}

function validateManifestEntry(value: unknown, field: string): PayloadManifestEntry {
  const raw = requireObject(
    value,
    field,
    ["path", "status", "size", "mode", "contentIncluded"],
    ["from", "similarity", "linkTarget", "blobSha", "binary", "oversize", "lfs"],
  );
  const status = requireEnum(raw.status, `${field}.status`, [
    "added",
    "modified",
    "deleted",
    "renamed",
    "unchanged",
  ] as const);
  const mode = requireEnum(raw.mode, `${field}.mode`, ["regular", "executable", "symlink"] as const);

  // Conditional fields (spec §8.2: "renamed only", "symlink only").
  if (status !== "renamed" && ("from" in raw || "similarity" in raw)) {
    fail(`${field}.from`, `${field}.from/similarity are only valid on a renamed entry`);
  }
  if (mode !== "symlink" && "linkTarget" in raw) {
    fail(`${field}.linkTarget`, `${field}.linkTarget is only valid on a symlink entry`);
  }

  const similarity = "similarity" in raw ? requireNonNegativeInteger(raw.similarity, `${field}.similarity`) : undefined;
  if (similarity !== undefined && similarity > 100) fail(`${field}.similarity`, `${field}.similarity must be 0–100`);

  return {
    path: requireString(raw.path, `${field}.path`),
    status,
    ...("from" in raw ? { from: requireString(raw.from, `${field}.from`) } : {}),
    ...(similarity !== undefined ? { similarity } : {}),
    size: requireNonNegativeInteger(raw.size, `${field}.size`),
    mode,
    ...("linkTarget" in raw ? { linkTarget: requireString(raw.linkTarget, `${field}.linkTarget`) } : {}),
    ...("blobSha" in raw ? { blobSha: requireString(raw.blobSha, `${field}.blobSha`) } : {}),
    ...("binary" in raw ? { binary: requireTrueMarker(raw.binary, `${field}.binary`) } : {}),
    ...("oversize" in raw ? { oversize: requireTrueMarker(raw.oversize, `${field}.oversize`) } : {}),
    ...("lfs" in raw ? { lfs: requireTrueMarker(raw.lfs, `${field}.lfs`) } : {}),
    contentIncluded: requireBoolean(raw.contentIncluded, `${field}.contentIncluded`),
  };
}

function validateChangesetEntry(value: unknown, field: string): PayloadChangesetEntry {
  const raw = requireObject(value, field, ["path", "status"], ["from", "patch", "content"]);
  const status = requireEnum(raw.status, `${field}.status`, ["added", "modified", "renamed"] as const);
  if (status !== "renamed" && "from" in raw) {
    fail(`${field}.from`, `${field}.from is only valid on a renamed entry`);
  }
  if ("patch" in raw && "content" in raw) {
    fail(`${field}.content`, `${field}.patch and ${field}.content are mutually exclusive`);
  }
  return {
    path: requireString(raw.path, `${field}.path`),
    status,
    ...("from" in raw ? { from: requireString(raw.from, `${field}.from`) } : {}),
    ...("patch" in raw ? { patch: requireString(raw.patch, `${field}.patch`) } : {}),
    ...("content" in raw ? { content: requireString(raw.content, `${field}.content`) } : {}),
  };
}

function validateSnapshotEntry(value: unknown, field: string): PayloadSnapshotEntry {
  const raw = requireObject(value, field, ["path", "content"]);
  return {
    path: requireString(raw.path, `${field}.path`),
    content: requireString(raw.content, `${field}.content`),
  };
}

function validateContextExcerpt(value: unknown, field: string): PayloadContextExcerpt {
  const raw = requireObject(value, field, ["path", "startLine", "endLine", "content"]);
  const startLine = requireNonNegativeInteger(raw.startLine, `${field}.startLine`);
  const endLine = requireNonNegativeInteger(raw.endLine, `${field}.endLine`);
  if (startLine < 1) fail(`${field}.startLine`, `${field}.startLine is 1-based`);
  if (endLine < startLine) fail(`${field}.endLine`, `${field}.endLine must be >= ${field}.startLine`);
  return { path: raw.path as string, startLine, endLine, content: requireString(raw.content, `${field}.content`) };
}

function validateEvidence(value: unknown, field: string): PayloadCheckEvidence {
  const raw = requireObject(
    value,
    field,
    ["origin", "trust", "status", "label"],
    ["exitCode", "output", "durationMs"],
  );
  const origin = requireEnum(raw.origin, `${field}.origin`, ["local", "sandbox"] as const);
  const trust = requireEnum(raw.trust, `${field}.trust`, ["unverified_client", "isolated"] as const);

  // Structural provenance invariants (spec §3.2).
  if (origin === "local" && trust !== "unverified_client") {
    fail(`${field}.trust`, `${field}: origin "local" requires trust "unverified_client"`);
  }
  if (origin === "sandbox" && trust !== "isolated") {
    fail(`${field}.trust`, `${field}: origin "sandbox" requires trust "isolated"`);
  }
  // Alpha contract (spec §3.2): Workspace Review evidence is local or absent.
  // Rejecting here rather than downgrading keeps forged "isolated" trust out.
  if (origin === "sandbox") {
    fail(`${field}.origin`, `${field}: sandbox-origin evidence is not accepted for a Workspace Review`);
  }

  return {
    origin,
    trust,
    status: requireEnum(raw.status, `${field}.status`, ["complete", "partial", "unavailable"] as const),
    label: requireString(raw.label, `${field}.label`),
    ...("exitCode" in raw ? { exitCode: requireNonNegativeInteger(raw.exitCode, `${field}.exitCode`) } : {}),
    ...("output" in raw ? { output: requireString(raw.output, `${field}.output`) } : {}),
    ...("durationMs" in raw ? { durationMs: requireNonNegativeInteger(raw.durationMs, `${field}.durationMs`) } : {}),
  };
}

function validateRedaction(value: unknown, field: string): PayloadRedaction {
  const raw = requireObject(value, field, [
    "rulesVersion",
    "withheldFiles",
    "redactedSpans",
    "truncated",
    "omittedManifestEntries",
  ]);
  return {
    rulesVersion: requireString(raw.rulesVersion, `${field}.rulesVersion`),
    withheldFiles: requireArray(raw.withheldFiles, `${field}.withheldFiles`).map((item, index) => {
      const entryField = `${field}.withheldFiles[${index}]`;
      const entry = requireObject(item, entryField, ["path", "class"]);
      return {
        path: requireString(entry.path, `${entryField}.path`),
        class: requireString(entry.class, `${entryField}.class`),
      };
    }),
    redactedSpans: requireArray(raw.redactedSpans, `${field}.redactedSpans`).map((item, index) => {
      const entryField = `${field}.redactedSpans[${index}]`;
      const entry = requireObject(item, entryField, ["path", "rule", "count"]);
      return {
        path: requireString(entry.path, `${entryField}.path`),
        rule: requireString(entry.rule, `${entryField}.rule`),
        count: requireNonNegativeInteger(entry.count, `${entryField}.count`),
      };
    }),
    truncated: requireArray(raw.truncated, `${field}.truncated`).map((item, index) => {
      const entryField = `${field}.truncated[${index}]`;
      const entry = requireObject(item, entryField, ["path", "originalBytes", "keptBytes"]);
      return {
        path: requireString(entry.path, `${entryField}.path`),
        originalBytes: requireNonNegativeInteger(entry.originalBytes, `${entryField}.originalBytes`),
        keptBytes: requireNonNegativeInteger(entry.keptBytes, `${entryField}.keptBytes`),
      };
    }),
    omittedManifestEntries: requireNonNegativeInteger(
      raw.omittedManifestEntries,
      `${field}.omittedManifestEntries`,
    ),
  };
}

function validateWorkspaceBlock(value: unknown, field: string): CanonicalWorkspacePayload["workspace"] {
  const raw = requireObject(value, field, ["label", "vcs"], ["baseState", "branch"]);
  let baseState: CanonicalWorkspacePayload["workspace"]["baseState"];
  if ("baseState" in raw) {
    if (raw.baseState === "unborn") {
      baseState = "unborn";
    } else if (typeof raw.baseState === "string") {
      fail(`${field}.baseState`, `${field}.baseState must be { headSha } or the literal "unborn"`);
    } else {
      const base = requireObject(raw.baseState, `${field}.baseState`, ["headSha"]);
      baseState = { headSha: requireString(base.headSha, `${field}.baseState.headSha`) };
    }
  }
  return {
    label: requireString(raw.label, `${field}.label`),
    vcs: requireEnum(raw.vcs, `${field}.vcs`, ["git", "none"] as const),
    ...(baseState !== undefined ? { baseState } : {}),
    ...("branch" in raw ? { branch: requireString(raw.branch, `${field}.branch`) } : {}),
  };
}

/**
 * Validate a parsed Canonical Payload.
 *
 * The schemaVersion gate runs first so a client on a newer/older schema gets
 * `unsupported_schema_version` (naming what we accept) rather than a confusing
 * cascade of field errors from a shape we were never going to accept.
 */
export function validateWorkspacePayload(value: unknown): PayloadValidationResult {
  try {
    if (!isPlainObject(value)) {
      return {
        ok: false,
        error: { code: "invalid_payload", field: "payload", message: "payload must be a JSON object" },
      };
    }
    const version = value.schemaVersion;
    if (typeof version !== "string" || !ACCEPTED_SCHEMA_VERSIONS.includes(version as typeof WORKSPACE_SCHEMA_VERSION)) {
      return {
        ok: false,
        error: {
          code: "unsupported_schema_version",
          message: `unsupported schemaVersion; this server accepts: ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}`,
          acceptedVersions: [...ACCEPTED_SCHEMA_VERSIONS],
          ...(typeof version === "string" ? { received: version } : {}),
        },
      };
    }

    const raw = requireObject(
      value,
      "payload",
      ["schemaVersion", "kind", "captureMode", "tool", "workspace", "manifest", "context", "localPolicy", "redaction"],
      ["changeset", "snapshot", "evidence"],
    );

    const kind = requireEnum(raw.kind, "payload.kind", ["changeset", "snapshot"] as const);
    const captureMode = requireEnum(raw.captureMode, "payload.captureMode", [
      "default",
      "staged",
      "all",
    ] as const);

    const tool = requireObject(raw.tool, "payload.tool", ["name", "version"]);
    const toolName = requireString(tool.name, "payload.tool.name");
    if (toolName !== "ternary-cli") fail("payload.tool.name", `payload.tool.name must be "ternary-cli"`);

    // Kind/entry-list agreement: a changeset never carries snapshot entries and
    // vice versa. Either list may be absent (an empty capture omits it).
    if (kind === "changeset" && "snapshot" in raw) {
      fail("payload.snapshot", `payload.snapshot is not permitted when kind is "changeset"`);
    }
    if (kind === "snapshot" && "changeset" in raw) {
      fail("payload.changeset", `payload.changeset is not permitted when kind is "snapshot"`);
    }
    // baseState is changeset-only (spec §8.2).
    const workspace = validateWorkspaceBlock(raw.workspace, "payload.workspace");
    if (kind === "snapshot" && workspace.baseState !== undefined) {
      fail("payload.workspace.baseState", `payload.workspace.baseState is changeset-only (no merge boundary in a snapshot)`);
    }

    const localPolicyRaw = requireObject(raw.localPolicy, "payload.localPolicy", [
      "captureMode",
      "include",
      "exclude",
      "denyRulesVersion",
      "caps",
    ]);

    return {
      ok: true,
      payload: {
        schemaVersion: version,
        kind,
        captureMode,
        tool: { name: toolName, version: requireString(tool.version, "payload.tool.version") },
        workspace,
        manifest: requireArray(raw.manifest, "payload.manifest").map((entry, index) =>
          validateManifestEntry(entry, `payload.manifest[${index}]`),
        ),
        ...("changeset" in raw
          ? {
              changeset: requireArray(raw.changeset, "payload.changeset").map((entry, index) =>
                validateChangesetEntry(entry, `payload.changeset[${index}]`),
              ),
            }
          : {}),
        ...("snapshot" in raw
          ? {
              snapshot: requireArray(raw.snapshot, "payload.snapshot").map((entry, index) =>
                validateSnapshotEntry(entry, `payload.snapshot[${index}]`),
              ),
            }
          : {}),
        context: requireArray(raw.context, "payload.context").map((entry, index) =>
          validateContextExcerpt(entry, `payload.context[${index}]`),
        ),
        localPolicy: {
          captureMode: requireEnum(localPolicyRaw.captureMode, "payload.localPolicy.captureMode", [
            "default",
            "staged",
            "all",
          ] as const),
          include: requireStringArray(localPolicyRaw.include, "payload.localPolicy.include"),
          exclude: requireStringArray(localPolicyRaw.exclude, "payload.localPolicy.exclude"),
          denyRulesVersion: requireString(localPolicyRaw.denyRulesVersion, "payload.localPolicy.denyRulesVersion"),
          caps: validateCaps(localPolicyRaw.caps, "payload.localPolicy.caps"),
        },
        ...("evidence" in raw
          ? {
              evidence: requireArray(raw.evidence, "payload.evidence").map((entry, index) =>
                validateEvidence(entry, `payload.evidence[${index}]`),
              ),
            }
          : {}),
        redaction: validateRedaction(raw.redaction, "payload.redaction"),
      },
    };
  } catch (error) {
    if (error instanceof PayloadFieldError) {
      return { ok: false, error: { code: "invalid_payload", field: error.field, message: error.message } };
    }
    throw error;
  }
}

// --- Digest verification (spec §8.3) ---

/** SHA-256 over the exact received bytes, in the CLI's `sha256:<hex>` form. */
export function computePayloadDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type DigestVerification =
  | { ok: true; digest: string }
  | { ok: false; reason: "missing_header" | "malformed_header" | "digest_mismatch"; digest: string };

/**
 * Verify the transported digest against the bytes actually received.
 *
 * This is an integrity check on a non-secret value (the payload it covers is
 * already in hand), so a plain comparison is correct — there is no secret to
 * leak through timing here.
 */
export function verifyPayloadDigest(bytes: Uint8Array, header: string | null | undefined): DigestVerification {
  const digest = computePayloadDigest(bytes);
  if (!header || !header.trim()) return { ok: false, reason: "missing_header", digest };
  const presented = header.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(presented)) return { ok: false, reason: "malformed_header", digest };
  if (presented !== digest) return { ok: false, reason: "digest_mismatch", digest };
  return { ok: true, digest };
}
