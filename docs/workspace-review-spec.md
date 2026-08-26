# Workspace Review: Domain and Threat-Model Specification

Status: Draft for internal dogfooding alpha (single user). Docs-only; no implementation ships with this document.
Scope: Defines the Workspace Review domain, its vocabulary, data-handling rules, limits, capture semantics, the canonical payload contract, and the threat model. Later phases implement against this spec:

- Phase 2 — offline CLI collector under `cli/` (independent project; no npm workspace/monorepo conversion in the alpha)
- Phase 3 — workspace-specific analysis wrapper server-side
- Phase 4 — synchronous internal endpoint authenticated with `TERNARY_CLI_TOKEN`
- Phase 5 — dogfood and measure

Target workflow: build locally → Ternary Workspace Review → fix findings → push → Ternary GitHub Review.

## 1. Relationship to the existing Review (fixed decisions)

These decisions are recorded, not open for relitigation:

1. **The existing `Review` concept is unchanged.** A Review remains Ternary's evaluation of one pull request at one head commit within a Repository Scope. Workspace Review is a **separate** domain concept with `kind: "changeset" | "snapshot"` and an advisory verdict `"pass" | "findings"`. It never approves or requests changes on a PR, and a snapshot has no merge boundary.
2. **No optionality creep on `ReviewRequest`.** `pullNumber`, `installationId`, `headSha`, and `cloneUrl` stay required on the existing `ReviewRequest` (`src/lib/types.ts`). Workspace Review gets its own types; the two request shapes never merge.
3. **Client privacy is the real boundary.** What never leaves the workstation is decided by the collector before any bytes are transmitted. Server-side redaction (`src/lib/secret-redaction.ts`) is defense in depth only, never the primary control.
4. **Evidence provenance is explicit.** `CheckEvidence` carries `origin: "local" | "sandbox"`, `trust: "unverified_client" | "isolated"`, `status: "complete" | "partial" | "unavailable"`. Local evidence is never treated as equivalent to sandbox evidence, in prompts, verdicts, or reporting.
5. **`RepositoryIndexer` is not a direct CLI seam.** Only small pure primitives (source-file filtering, chunking, tokenization, bounded context selection) get extracted or recreated later, after characterization tests exist. No `LocalRepositorySource` is threaded through the server-only `repository-context-service.ts` (it is `import "server-only"` and Redis/GitHub-coupled by construction).
6. **Survivable sync endpoint (amended by ADR-0002, 2026-08-25; originally the Vercel Hobby shape):** at most **two** deadline-bounded attempts against the **same model family** — still **no cross-vendor fallback chain** (the DeepSeek→OpenAI cascade in `review-route-service.ts` stays PR-queue-only) — each with a bounded reasoning budget and deterministic provider routing, a tight server-owned token budget, an end-to-end deadline of **≤ 180 seconds**, and a deterministic timeout that aborts the in-flight model request. Every request consumes one rate-limit slot regardless of outcome. *Rollout status (2026-08-26): step 1 (streaming, stall detection, reasoning bound, provider routing) is deployed on main `f922654` but did **not** clear the ADR-0002 gate (dogfood report §8.6: 66.7% delivery, p50 56.6 s — `effort: "low"` is not honoured by the incumbent model); step 1b makes reasoning effort and provider sort env-tunable ahead of the model experiments and separates a connection drop from a deadline; step 2 (second attempt, 180 s deadline) is not started, so the deployed endpoint still makes **one** attempt under a 120 s deadline.*
7. **Zero-network for the collector is structural, with one explicit transmit boundary.** Capture, deny/redaction, payload-construction, and rendering modules can never import a networking transport — not "don't call", *cannot import*. Exactly one narrowly scoped transmit module MAY import an HTTP client; its only permitted outbound operation is submitting already-finalized canonical bytes to the configured endpoint and receiving the response (including enforcing the client-side timeout in section 6). `--dry-run` and `--manifest` execute through a code path that never imports or instantiates the transmit module — asserted by a module-graph test — and tests additionally assert those modes make zero network calls.
8. **Capture-mode disagreement rule:** in default mode (`ternary review .`), when the Git index and the worktree disagree on a file, the **worktree** version wins.
9. **The versioned canonical payload schema (section 8) is the CLI↔server contract.** Both sides validate against shared fixture payloads.

## 2. Vocabulary

These entries follow the CONTEXT.md format (definition plus synonyms to avoid). They extend the existing vocabulary; no existing term is redefined. Section 11 contains the exact text proposed for CONTEXT.md.

**Workspace Review**:
Ternary's advisory evaluation of a local changeset or bounded local workspace snapshot, produced without a hosted pull request and carrying a verdict of pass or findings.
_Avoid_: local review, pre-review, dry-run review, CLI review, Review

**Changeset Review**:
A Workspace Review whose subject is the difference between a base state (usually HEAD) and the captured working state of a Git workspace.
_Avoid_: diff review, uncommitted review, patch review

**Snapshot Review**:
A Workspace Review whose subject is a bounded whole-workspace capture with no base state and no merge boundary.
_Avoid_: full scan, repo audit, directory review

**Workspace Root**:
The single directory that bounds everything a Workspace Review may read; no capture, symlink resolution, or command execution escapes it.
_Avoid_: project dir, cwd, repo root (a Workspace Root need not be a Git repository)

**Local Policy**:
The effective, locally resolved configuration a collector applies before transmission — inclusion/exclusion, caps, and capture mode — recorded verbatim in the Canonical Payload.
_Avoid_: Review Policy, client settings, config blob

**Canonical Payload**:
The versioned, schema-validated byte sequence a collector produces for one Workspace Review; its digest is computed from the exact canonical bytes to be transmitted, and it is the complete CLI↔server contract.
_Avoid_: request body, upload, bundle, wire format

**Principal**:
The single authenticated internal identity (holder of `TERNARY_CLI_TOKEN`) on whose behalf a Workspace Review runs during the alpha.
_Avoid_: user account, tenant, installation

**Workspace Scope**:
The access boundary of one Workspace Review: one Principal plus one Workspace Root at one capture instant; nothing outside it is readable, attributable, or reusable across reviews.
_Avoid_: Repository Scope, session, namespace

## 3. Domain model

### 3.1 Workspace Review

```
WorkspaceReviewRequest = {
  schemaVersion: string;            // canonical payload schema version, e.g. "workspace-review/1"
  kind: "changeset" | "snapshot";
  captureMode: "default" | "staged" | "all";   // see section 7
  workspaceLabel: string;           // human label only; never a filesystem path from outside the root
  payload: CanonicalPayload;        // section 8
}

WorkspaceReviewResult = {
  verdict: "pass" | "findings";     // advisory only
  summary: string;
  findings: WorkspaceFinding[];     // same severity vocabulary as ReviewFinding: blocking | warning | suggestion
  evidence: CheckEvidence[];
  ai?: { model, latencyMs, inputTokens?, outputTokens?, estimatedCostUsd? };  // same shape as ReviewResult.ai
}
```

- `verdict: "pass"` means no findings at or above the reporting threshold; `"findings"` means at least one. There is no `approve`/`request_changes`: a Workspace Review has no merge boundary and no GitHub side effects.
- `WorkspaceFinding` reuses the severity vocabulary and the `ruleId`/`findingKey` identity fields of `ReviewFinding`, but has **no** Finding State lifecycle: with nothing persisted (section 5), there is nothing to reconcile across runs.

### 3.2 Check Evidence

```
CheckEvidence = {
  origin: "local" | "sandbox";
  trust: "unverified_client" | "isolated";
  status: "complete" | "partial" | "unavailable";
  label: string;                     // one evidence SOURCE, e.g. "npm test" or "sandbox sbx_123"
  commands: CommandEvidence[];       // each executed command within that source
  truncation?: { skippedCommands: string[] };
  redaction?: { redactedSpans: number };
  unavailableReason?: string;
}

CommandEvidence = {
  command: string;                   // redacted, bounded
  exitCode?: number;
  output?: string;                   // redacted, bounded (section 4.4)
}
```

(Amended 2026-08-20 with the Phase 4 endpoint contract: the grouped shape above is what `src/lib/workspace-review-types.ts` implements and the `SandboxResult` adapter produces — one entry per evidence source, one `CommandEvidence` per executed command. It replaces this section's earlier flat per-check shape.)

Invariants (each testable):

- `origin: "local"` implies `trust: "unverified_client"`, always.
- `origin: "sandbox"` implies `trust: "isolated"`, always.
- In the alpha, all Workspace Review evidence is `origin: "local"` or absent; the sandbox pipeline is not invoked for Workspace Reviews.
- Prompts and rendered output must label local evidence as client-reported; a Workspace Review must never present local evidence with the wording used for isolated sandbox evidence.

## 4. Data transmission policy

Every statement in this section is written to be directly convertible into an automated test against the collector.

### 4.1 Data that MAY be transmitted

- Source file contents that survive the deny classes in 4.2, the Local Policy excludes, and the caps in 4.4.
- Relative, normalized paths under the Workspace Root (see 8.3).
- The changeset or snapshot representation (section 7), the manifest, and the selected bounded context.
- File metadata: size, mode bits reduced to `{regular, executable, symlink}`, rename/delete markers, blob hashes.
- The effective Local Policy and redaction metadata (counts and rule identifiers of what was withheld — never the withheld bytes).
- Evidence output that the user explicitly opted to include, after redaction and bounding (sections 4.4, 6).
- The schema version, capture mode, review kind, tool version, and the payload digest.

### 4.2 Data that may NEVER be transmitted (deny classes — no override in the alpha)

Each item below is a testable statement of the form "a payload built from a workspace containing X contains no bytes of X".

1. **Environment files.** No file named `.env` or matching `.env.*` (at any depth) contributes any bytes to the payload, including when staged, tracked, or explicitly passed as an argument.
2. **Private keys and signing material.** No file whose content matches PEM armor (`-----BEGIN … PRIVATE KEY-----`, `-----BEGIN CERTIFICATE-----` with key material), and no file with a keystore/signing extension (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.asc` private blocks, `id_rsa*`, `id_ed25519*`) contributes any bytes.
3. **Cloud provider credential directories.** No file under `.aws/`, `.gcloud/`, `.config/gcloud/`, `.azure/`, `.kube/`, `.docker/config.json`, `.terraform/` credentials, or equivalents contributes any bytes.
4. **Auth and token stores.** No file matching `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `*.tfstate`, browser/keychain exports, or files whose content matches the token patterns in `secret-redaction.ts` (`gh[opsu]_…`, `github_pat_…`, `sk-…`, `Authorization: Bearer …`) contributes those bytes; a file that is otherwise transmittable has such spans replaced with `[REDACTED]` and the replacement is recorded in redaction metadata.
5. **VCS metadata.** No bytes from `.git/` (or any other VCS metadata directory: `.hg/`, `.svn/`) are transmitted. Derived facts (current branch name, HEAD SHA, dirty flag) MAY be transmitted as explicit manifest fields; raw config, hooks, reflogs, and object stores may not.
6. **Dependency trees and caches.** No bytes from `node_modules/`, `vendor/`, `.pnpm-store/`, `.yarn/`, `.venv/`, `__pycache__/`, `.turbo/`, `.cache/` are transmitted.
7. **Build outputs and generated artifacts.** No bytes from `dist/`, `build/`, `.next/`, `out/`, `coverage/`, `*.min.js`, source maps, or paths matched by generated-artifact rules are transmitted.
8. **Binary files.** No file classified as binary (NUL byte in the first 8,000 bytes, or a known binary extension) contributes content bytes; at most its path, size, and a `binary: true` marker appear in the manifest.
9. **Oversized files.** No file larger than the configured per-file cap (4.4) contributes content bytes; at most path, size, and an `oversize: true` marker appear.
10. **Anything outside the Workspace Root.** No bytes read through a symlink, submodule, nested repository, or path that resolves outside the Workspace Root are transmitted (section 7.2).

Deny classes are evaluated **before** Local Policy includes: an include pattern cannot resurrect a denied file in the alpha. There is no override flag.

### 4.3 Defense in depth on the server

The Phase 4 endpoint applies `redactSecrets` to all inbound text it embeds in prompts or error messages, exactly as the PR pipeline does at ledger/error/evidence boundaries. This is a second net, not the boundary; a payload that relies on server redaction has already failed the collector's contract.

### 4.4 Limits (tunable defaults)

Every number below is a **tunable default**, chosen from the measured budgets in `review-invocation-limits.ts`, `repository-index.ts`, `sandbox.ts`, and `openrouter-review-provider.ts`, plus the Vercel Hobby constraints. Each is enforced deterministically (truncate/skip and record, never fail open).

| Limit | Default | Grounding |
| --- | --- | --- |
| Canonical Payload total size | 2,000,000 bytes | Comfortable under serverless body limits; ~5× the PR pipeline's total model-visible input |
| Changeset content budget | 160,000 chars | Matches `MAX_DIFF_CHARS` default in `openrouter-review-provider.ts` |
| Selected bounded context | 8 excerpts / 20,000 chars | Matches `maxContextChunks`/`maxContextChars` in `repository-index.ts` and `repositoryContextCharacterBudget` |
| Snapshot source budget | 400,000 bytes / 500 files / 500 chunks | Matches `maxSourceBytes`/`maxFiles`/`maxChunks` index budgets |
| Per-file content cap | 200,000 bytes | Matches `maxFileBytes` index budget |
| Evidence output per check | 24,000 chars captured, 1,500 chars model-visible | Matches `OUTPUT_LIMIT` and `SANDBOX_MODEL_OUTPUT_LIMIT` in `sandbox.ts` |
| Findings returned | 50 max | New cap; PR pipeline has none, but a bounded advisory report must stay readable |
| Model output tokens (server-owned) | 4,096 max_tokens | Tight budget per the Hobby decision; server sets it, client cannot raise it |
| Manifest entries | 5,000 paths | Bounds pathological workspaces; paths beyond the cap are counted, not listed |

## 5. Retention

**The Phase 4 synchronous endpoint persists nothing.** No Review Event, no ledger row, no queue job, no index snapshot, no payload bytes at rest. The response is the only artifact; when the connection ends, the review is gone.

Consequences (all deliberate for the alpha):

- **No idempotency.** There is no `Idempotency-Key` semantics (unlike `POST /api/reviews/run`); an identical resubmission performs and bills a fresh model call. The client-computed payload digest identifies a payload for logging/comparison, not for dedup.
- **No Finding State.** Findings cannot be open/fixed/dismissed/superseded/stale; each run stands alone.
- **No Analytics or Memory input.** Workspace Reviews do not appear in the ledger-backed dashboards.
- **No replay or audit.** Operational logs may record request metadata (timing, sizes, model, cost) but never payload contents.

## 6. Timeouts

- **Server end-to-end deadline: ≤ 180,000 ms** (ADR-0002; was 120,000 ms), measured from request receipt, enforced with a deterministic timer that **aborts the in-flight model request** (AbortController, as in `generateOpenRouterReview`) and returns a structured timeout response — never a platform kill. Suggested split (tunable defaults, sums to 180s): ~5s parse/validate + up to two model attempts of ≤ 80s each + ~15s response assembly reserve; the second attempt is only started if at least its full budget remains before the deadline. Inside the route's `maxDuration = 300`.
- **At most two attempts, same model family, no cross-vendor cascade** (fixed decision 6 as amended). Each attempt streams and is aborted early if the generation stalls; the second attempt is routed away from the provider that failed. If neither yields a complete, schema-valid review the request fails deterministically.
- **Client-side timeout:** the collector aborts its own request at server deadline + 10s network slack and reports a local timeout; it never hangs on a dead connection.
- *Rollout status (2026-08-26): step 1 (streaming, stall detection, reasoning bound, provider routing) is deployed on main `f922654` but did **not** clear the ADR-0002 gate (dogfood report §8.6: 66.7% delivery, p50 56.6 s — `effort: "low"` is not honoured by the incumbent model); step 1b makes reasoning effort and provider sort env-tunable ahead of the model experiments and separates a connection drop from a deadline; step 2 (second attempt, 180 s deadline) is not started, so the deployed endpoint still makes **one** attempt under a 120 s deadline, with `cli/src/transmit.ts` still on the matching 130 s client timeout.*

## 7. Change capture

### 7.1 Capture-mode matrix

There is **no `--uncommitted` flag**; the default mode covers that intent.

| Invocation | Kind | Base | Captured state |
| --- | --- | --- | --- |
| `ternary review .` (default) | changeset | HEAD | Combined index + worktree, including safe untracked files (files passing section 4.2 and Local Policy). Where index and worktree disagree on a file, the **worktree version wins**. |
| `ternary review . --staged` | changeset | HEAD | Git index only; worktree-only edits and untracked files are excluded. |
| `ternary review . --all` | snapshot | none | Bounded whole-workspace snapshot under the limits in 4.4. |
| Unborn HEAD (repo with no commits) | changeset | empty tree | Deterministic all-new-files representation: every captured file is an addition against the empty base; the manifest marks `baseState: "unborn"`. |
| Non-Git directory | snapshot | none | Bounded whole-workspace snapshot; the manifest marks `vcs: "none"`. `--staged` is an error here. |

### 7.2 Edge-case semantics (each testable)

- **Renames** are represented as `{status: "renamed", from, to, similarity}` when Git reports them; otherwise as delete+add. Never as silent content duplication.
- **Deletions** appear as manifest entries `{status: "deleted", path}` with no content bytes.
- **LFS pointers** are transmitted as the pointer text (which is what the worktree holds), marked `lfs: true`; the collector never smudges/downloads LFS objects.
- **Submodules** contribute metadata only: path, recorded commit SHA, and dirty flag. No bytes from inside a submodule are captured.
- **Nested repositories** (a `.git` below the Workspace Root that is not a submodule) are excluded entirely; their paths appear only as a counted exclusion in redaction metadata.
- **Symlinks** are captured as link entries (path + target string). They are **never followed**; a symlink whose target resolves outside the Workspace Root contributes nothing but the link entry.
- **Invalid UTF-8** in file contents marks the file `binary: true` (deny class 8). Invalid UTF-8 in a *path* is represented with an escaped, lossless byte encoding in the manifest and the file's contents are excluded.
- **Path traversal:** any candidate path that, after normalization, contains `..` segments or resolves outside the Workspace Root is **rejected** (hard error listing the path), not skipped silently.
- **Case-sensitivity determinism:** manifest ordering is a bytewise sort of normalized paths; on case-insensitive filesystems, two paths differing only by case are an error, so the same workspace produces the same manifest (and digest) on every platform.

### 7.3 Race-safe capture (TOCTOU)

Classification (section 4.2) and capture must act on the **same bytes**: a file may be replaced with a symlink, grow past a cap, or gain secret content between the moment it is classified and the moment it is read. The capture algorithm is therefore normative:

- Files are opened with **directory-relative, no-follow** handles (`openat`-style traversal from the Workspace Root with `O_NOFOLLOW` on every component, or the platform equivalent). Root containment is established by handle-based traversal, never by string-prefix checks on resolved paths.
- After open, the handle is verified with `fstat`: file type must be a regular file, and device/inode identity must match the `lstat` that classified the candidate. On mismatch the collector performs at most one bounded re-classification retry, then rejects the path with a hard error naming it.
- Deny, binary, size-cap, and secret checks apply to the **bytes actually read from the verified handle**, and those same bytes (post-redaction, post-truncation, both recorded) are what enters the payload. Read once; never re-open a path between check and use.
- On platforms without no-follow primitives, the sequence is `lstat` → open → `fstat` compare (device, inode, type, size); if identity cannot be verified, the file is **excluded** with reason code `unverifiable` — exclusion is always the failure mode, inclusion never is.

## 8. Canonical payload schema

### 8.1 Versioning

The payload opens with `schemaVersion` (e.g. `"workspace-review/1"`). The server rejects unknown versions with a structured error naming the versions it accepts. Any change to field semantics, normalization, or digest computation bumps the version. Shared fixture payloads live with the schema; **both** the CLI and the server validate against the same fixtures (fixed decision 9).

### 8.2 Shape

```
CanonicalPayload = {
  schemaVersion: string;
  kind: "changeset" | "snapshot";
  captureMode: "default" | "staged" | "all";
  tool: { name: "ternary-cli"; version: string };
  workspace: {
    label: string;
    vcs: "git" | "none";
    baseState?: { headSha: string } | "unborn";   // changeset only
    branch?: string;
  };
  manifest: ManifestEntry[];        // every path considered, with status/size/markers; sorted (7.2)
  changeset?: ChangesetEntry[];     // kind: "changeset"
  snapshot?: SnapshotEntry[];       // kind: "snapshot"
  context: ContextExcerpt[];        // client-selected bounded context (4.4)
  localPolicy: EffectiveLocalPolicy; // the exact policy applied, fully resolved
  evidence?: CheckEvidence[];       // opt-in, origin:"local", trust:"unverified_client"
  redaction: {
    rulesVersion: string;
    withheldFiles: Array<{ path: string; class: string }>;
    redactedSpans: Array<{ path: string; rule: string; count: number }>;
    truncated: Array<{ path: string; originalBytes: number; keptBytes: number }>;
  };
}
```

Referenced entry types (all part of the versioned schema; every field shown is normative):

```
ManifestEntry = {
  path: string;                       // normalized per 8.3
  status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
  from?: string;                      // renamed only: prior path
  similarity?: number;                // renamed only: integer 0–100
  size: number;                       // bytes, integer ≥ 0
  mode: "regular" | "executable" | "symlink";
  linkTarget?: string;                // symlink only: the literal target string, never resolved
  blobSha?: string;                   // Git blob SHA when known
  binary?: true;                      // deny class 8
  oversize?: true;                    // deny class 9
  lfs?: true;                         // LFS pointer (7.2)
  contentIncluded: boolean;           // whether this file's bytes appear in changeset/snapshot
}

ChangesetEntry = {
  path: string;
  status: "added" | "modified" | "renamed";   // deletions carry no content and live only in the manifest
  from?: string;                      // renamed only
  patch?: string;                     // unified diff text, UTF-8, no timestamps or index lines
  content?: string;                   // full file text for additions (patch and content are mutually exclusive)
}

SnapshotEntry = {
  path: string;
  content: string;                    // full file text, UTF-8, post-redaction/truncation (recorded in redaction)
}

ContextExcerpt = {
  path: string;
  startLine: number;                  // 1-based, integer
  endLine: number;                    // inclusive, integer
  content: string;
}

EffectiveLocalPolicy = {
  captureMode: "default" | "staged" | "all";
  include: string[];                  // resolved glob patterns, sorted
  exclude: string[];                  // resolved glob patterns, sorted
  denyRulesVersion: string;           // version of the deny-class rule set applied (4.2)
  caps: {                             // the effective values of every limit in 4.4, integers
    payloadBytes: number; changesetChars: number; contextExcerpts: number;
    contextChars: number; snapshotBytes: number; snapshotFiles: number;
    snapshotChunks: number; fileBytes: number; evidenceCapturedChars: number;
    evidenceModelChars: number; manifestEntries: number;
  };
}
```

### 8.3 Normalization and digest

- **Paths are normalized deliberately:** relative to the Workspace Root, `/` separators, no `.`/`..` segments, NFC-normalized where representable, bytewise-sorted.
- **Metadata is normalized deliberately:** timestamps are excluded from digested content; sizes are byte counts; mode bits reduce to the three-value set in 4.1.
- **Source contents are never silently normalized:** no newline conversion, no whitespace trimming, no encoding transcode of file bytes. The only content mutations are the explicit, recorded operations in `redaction` (redacted spans, truncation).
- **Digest:** SHA-256 over the **exact canonical bytes to be transmitted** — the serialized payload itself, not a reconstruction. The digest travels in a transport header/envelope field, outside the digested bytes.

### 8.4 Canonical serialization (normative)

The canonical bytes are UTF-8 JSON produced under **RFC 8785 (JSON Canonicalization Scheme)**:

- Object members sorted per JCS (lexicographic by UTF-16 code units); no insignificant whitespace; minimal string escaping per JCS.
- **Every number in this schema is a non-negative integer** — the schema deliberately contains no fractional or floating-point values, so JCS number serialization stays trivial (no exponents, no leading zeros, no `-0`).
- File contents embedded in the payload are always valid UTF-8 text (invalid UTF-8 marks a file binary and excludes its content, per 7.2), carried as JSON strings. **String values are not Unicode-normalized** — only paths are NFC-normalized, per 8.3; content bytes pass through untouched apart from the recorded redaction/truncation operations.
- Optional fields that are absent are **omitted entirely**, never serialized as `null`.
- **Fixtures are canonical-byte fixtures:** the shared fixture set (fixed decision 9) contains, for each case, the logical payload, the expected canonical byte sequence, and the expected SHA-256 digest. Both the CLI and the server must reproduce the bytes and digest exactly; a fixture mismatch on either side is a contract break, not a warning.

## 9. Local command trust boundary

**The alpha executes no local commands.** `ternary review` reads files; it never runs the project's build, lint, or tests itself. Evidence, if present, is output the user explicitly attached.

If local command execution is ever added, it is called **command-execution hardening** — never "sandboxing", because a local process is not isolated — and every one of the following is mandatory:

- The exact command and argv are printed before execution, verbatim.
- Execution is explicit opt-in per invocation; no config flag silently enables it.
- The working directory is fixed to the Workspace Root; the command cannot be pointed elsewhere.
- Bounded wall-clock time, bounded output bytes, and bounded process tree (children are killed with the parent).
- The environment is sanitized to an allowlist; the parent's env (tokens, keys) is not inherited wholesale.
- Output passes through redaction (4.2 rule 4) before it can enter a payload.
- Resulting evidence is marked `origin: "local"`, `trust: "unverified_client"` — no exceptions.

## 10. Terminal-output trust

Everything the CLI renders — filenames, model output, server errors, finding titles and explanations — is untrusted text that may contain control characters. The renderer must neutralize ANSI/terminal-control sequences (ESC, CSI, OSC, C1 controls, raw CR tricks) in all untrusted fields before writing to a TTY, so a hostile filename or a prompt-injected model response cannot rewrite the screen, hide output, or spoof the verdict line. Testable statement: rendering any untrusted string containing `\x1b`, `\x9b`, or bare `\r` produces output whose only escape sequences are the CLI's own.

## 11. Proposed CONTEXT.md additions (exact text)

The following block is appended to `CONTEXT.md` under a new `## Workspace Review Language` heading. No existing entry changes.

```markdown
## Workspace Review Language

**Workspace Review**:
Ternary's advisory evaluation of a local changeset or bounded local workspace snapshot, produced without a hosted pull request and carrying a verdict of pass or findings.
_Avoid_: local review, pre-review, dry-run review, CLI review, Review

**Changeset Review**:
A Workspace Review whose subject is the difference between a base state (usually HEAD) and the captured working state of a Git workspace.
_Avoid_: diff review, uncommitted review, patch review

**Snapshot Review**:
A Workspace Review whose subject is a bounded whole-workspace capture with no base state and no merge boundary.
_Avoid_: full scan, repo audit, directory review

**Workspace Root**:
The single directory that bounds everything a Workspace Review may read; no capture, symlink resolution, or command execution escapes it.
_Avoid_: project dir, cwd, repo root

**Local Policy**:
The effective, locally resolved configuration a collector applies before transmission — inclusion/exclusion, caps, and capture mode — recorded verbatim in the Canonical Payload.
_Avoid_: Review Policy, client settings, config blob

**Canonical Payload**:
The versioned, schema-validated byte sequence a collector produces for one Workspace Review; its digest is computed from the exact canonical bytes transmitted, and it is the complete CLI↔server contract.
_Avoid_: request body, upload, bundle, wire format

**Principal**:
The single authenticated internal identity (holder of `TERNARY_CLI_TOKEN`) on whose behalf a Workspace Review runs during the alpha.
_Avoid_: user account, tenant, installation

**Workspace Scope**:
The access boundary of one Workspace Review: one Principal plus one Workspace Root at one capture instant; nothing outside it is readable, attributable, or reusable across reviews.
_Avoid_: Repository Scope, session, namespace
```

## 12. Threat model

Assumptions: single internal Principal, internal endpoint, Hobby-plan hosting, nothing persisted server-side.

### Assets

A1. Workstation secrets (env files, keys, credential stores) — the highest-value asset.
A2. Proprietary source not intended for transmission (denied/excluded files).
A3. `TERNARY_CLI_TOKEN`.
A4. The developer's terminal and trust in the rendered verdict.
A5. OpenRouter spend.

### Trust boundaries

B1. Workstation filesystem → collector (deny classes, Workspace Root, symlink/traversal rules).
B2. Collector → network (structural zero-network until the single explicit transmit step; digest over exact bytes).
B3. Server → model provider (server-side redaction, server-owned token budget).
B4. Model/server output → terminal (control-sequence neutralization).
B5. Local evidence → review reasoning (`unverified_client` labeling).

### Threats and mitigations

| # | Threat | Boundary | Mitigation (spec section) |
| --- | --- | --- | --- |
| T1 | Secret exfiltration via capture (env files, keys, cred dirs swept into a payload) | B1 | Deny classes with no override, evaluated before includes (4.2); redaction metadata makes withholding visible (8.2) |
| T2 | Escape from Workspace Root via symlink, submodule, nested repo, or `..` path | B1 | Links never followed; submodule metadata only; nested repos excluded; traversal is a hard error (7.2) |
| T3 | Silent transmission by a buggy or compromised collector path | B2 | Structural zero-network module graph; dry-run asserts zero network calls; one explicit transmit step (decision 7) |
| T4 | Payload tampering or drift between what was reviewed and what was shown | B2 | Digest over exact canonical bytes; deterministic manifest ordering (8.3, 7.2) |
| T5 | Prompt injection from workspace contents steering the model to a false "pass" | B3/B5 | Advisory verdict only — no GitHub side effects; PR-time Review with isolated evidence remains the merge gate (1.1, 3.2) |
| T6 | Forged local evidence upgrading trust ("tests passed") | B5 | `trust: "unverified_client"` is structural and rendered; local evidence never worded as sandbox evidence (3.2) |
| T7 | Terminal escape-sequence injection via filenames or model output | B4 | ANSI/control neutralization of all untrusted text (10) |
| T8 | `TERNARY_CLI_TOKEN` leakage (logs, payloads, evidence) | B2/B3 | Token never enters the payload; server redaction patterns cover bearer tokens; env-sanitized command execution if ever added (4.2, 9) |
| T9 | Cost/DoS: oversized payloads or hot-loop resubmission (no idempotency) | B3 | Hard payload caps (4.4), server-owned token budget, ≤120s deadline with model abort (6); single Principal limits blast radius; spend monitoring stays advisory |
| T10 | Server-side retention creating a new data store to breach | B3 | Nothing persisted (5); logs carry metadata only |
| T11 | Replay of a captured payload by a network observer | B2 | Internal endpoint over TLS with bearer token; acceptable residual risk for a single-user alpha — revisit before any multi-user phase |
| T12 | Filesystem race (TOCTOU): a classified-safe file is swapped for a symlink or secret-bearing content before it is read | B1 | Race-safe capture: no-follow directory-relative opens, post-open `fstat` identity verification, checks applied to the bytes actually read, exclusion as the only failure mode (7.3) |

### Residual risks (accepted for the alpha)

- Local evidence is honest-user-only; nothing prevents a user from fabricating it (mitigated by labeling, not prevention).
- No idempotency means retries cost money (T9); acceptable at single-user scale.
- Content-based secret detection (deny class 4) is pattern-bound and will miss novel token formats; the primary control is the file-class deny list, not content scanning.
- Race-safe capture (7.3) detects persistent ancestor replacement via FD/lstat identity agreement; a flip-flop between the `lstat` of a path component and the by-path `open` of the next remains theoretically possible (Node lacks `openat`). It requires a concurrently running local attacker process, which the alpha assumptions place outside the threat model; exclusion remains the only failure mode when identity cannot be verified.
