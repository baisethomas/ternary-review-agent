// Regenerates the shared contract fixtures (spec 8.4: canonical-byte
// fixtures). Each case ships three files:
//   <name>.payload.json   — the logical payload (pretty-printed for review)
//   <name>.canonical.json — the exact canonical bytes (RFC 8785)
//   <name>.digest.txt     — sha256 digest of the canonical bytes
// Both the CLI and the Phase 4 server validate against these; regenerate only
// on a deliberate schema change (which bumps schemaVersion).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExclusionPipeline } from "../src/deny.js";
import { canonicalBytes, digestOf } from "../src/payload.js";
import {
  DEFAULT_CAPS,
  DENY_RULES_VERSION,
  REDACTION_RULES_VERSION,
  SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
} from "../src/types.js";
import type { CanonicalPayload, CaptureResult } from "../src/types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const changesetBasic: CanonicalPayload = {
  schemaVersion: SCHEMA_VERSION,
  kind: "changeset",
  captureMode: "default",
  tool: { name: TOOL_NAME, version: TOOL_VERSION },
  workspace: {
    label: "fixture-workspace",
    vcs: "git",
    baseState: { headSha: "8a6e5c78bbdc0b0ea55c4cf7de1c60285dc575c1" },
    branch: "main",
  },
  manifest: [
    {
      path: ".env",
      status: "added",
      size: 0,
      mode: "regular",
      contentIncluded: false,
    },
    {
      path: "src/index.ts",
      status: "modified",
      size: 25,
      mode: "regular",
      contentIncluded: true,
    },
    {
      path: "src/new-module.ts",
      status: "added",
      size: 27,
      mode: "regular",
      contentIncluded: true,
    },
    {
      path: "src/old-name.ts",
      status: "deleted",
      size: 0,
      mode: "regular",
      contentIncluded: false,
    },
  ],
  changeset: [
    {
      path: "src/index.ts",
      status: "modified",
      patch:
        "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,2 +1,2 @@\n export const one = 1;\n-export const two = 2;\n+export const two = 22;\n",
    },
    {
      path: "src/new-module.ts",
      status: "added",
      content: "export const fresh = true;\n",
    },
  ],
  context: [],
  localPolicy: {
    captureMode: "default",
    include: ["**"],
    exclude: ["*.log"],
    denyRulesVersion: DENY_RULES_VERSION,
    caps: DEFAULT_CAPS,
  },
  redaction: {
    rulesVersion: REDACTION_RULES_VERSION,
    withheldFiles: [{ path: ".env", class: "env_file" }],
    redactedSpans: [{ path: "src/index.ts", rule: "token.known-prefix", count: 1 }],
    truncated: [],
    omittedManifestEntries: 0,
  },
};

const snapshotBasic: CanonicalPayload = {
  schemaVersion: SCHEMA_VERSION,
  kind: "snapshot",
  captureMode: "all",
  tool: { name: TOOL_NAME, version: TOOL_VERSION },
  workspace: {
    label: "fixture-snapshot",
    vcs: "none",
  },
  manifest: [
    {
      path: "README.md",
      status: "unchanged",
      size: 15,
      mode: "regular",
      contentIncluded: true,
    },
    {
      path: "bin/run",
      status: "unchanged",
      size: 20,
      mode: "executable",
      contentIncluded: true,
    },
    {
      path: "docs-link",
      status: "unchanged",
      size: 9,
      mode: "symlink",
      linkTarget: "README.md",
      contentIncluded: false,
    },
  ],
  snapshot: [
    { path: "README.md", content: "# Fixture repo\n" },
    { path: "bin/run", content: "#!/bin/sh\nexit 0\n" },
  ],
  context: [],
  localPolicy: {
    captureMode: "all",
    include: ["**"],
    exclude: [],
    denyRulesVersion: DENY_RULES_VERSION,
    caps: DEFAULT_CAPS,
  },
  redaction: {
    rulesVersion: REDACTION_RULES_VERSION,
    withheldFiles: [],
    redactedSpans: [],
    truncated: [],
    omittedManifestEntries: 0,
  },
};

// A third case built by running the REAL exclusion pipeline over synthetic
// inputs, so the golden bytes cover redaction as it is actually applied
// (withheld files, redacted spans, truncation) rather than hand-written
// metadata. Readers are injected, so this stays a pure, offline computation.
const REDACTED_FILES: Record<string, string> = {
  ".env": "API_KEY=fixture-secret-value-not-transmitted\n",
  "certs/server.pem": "-----BEGIN RSA PRIVATE KEY-----\nMIIfixture\n-----END RSA PRIVATE KEY-----\n",
  "src/client.ts": `const token = "ghp_${"f".repeat(30)}";\nexport const client = { token };\n`,
  "src/notes.md": "Deploy with postgres://svc:fixturepassword@db.internal:5432/app\n",
};

const redactedCapture: CaptureResult = {
  workspace: { rootAbs: "/fixture", label: "fixture-redacted", vcs: "git", headSha: "b".repeat(40), unborn: false },
  kind: "changeset",
  captureMode: "default",
  candidates: Object.keys(REDACTED_FILES).map((path) => ({
    path,
    status: "added" as const,
    kind: "regular" as const,
    mode: "regular" as const,
    size: 0,
    source: "worktree" as const,
  })),
  preExcluded: [],
};

const redactedOutcome = runExclusionPipeline(
  redactedCapture,
  { excludeRules: [], excludePatterns: [] },
  DEFAULT_CAPS,
  {
    readWorktree(relPath) {
      const content = REDACTED_FILES[relPath];
      return content === undefined
        ? { ok: false, reason: "unverifiable" }
        : { ok: true, bytes: Buffer.from(content, "utf8") };
    },
    readBlob: () => null,
  },
);

const changesetRedacted: CanonicalPayload = {
  schemaVersion: SCHEMA_VERSION,
  kind: "changeset",
  captureMode: "default",
  tool: { name: TOOL_NAME, version: TOOL_VERSION },
  workspace: {
    label: "fixture-redacted",
    vcs: "git",
    baseState: { headSha: "b".repeat(40) },
  },
  manifest: redactedOutcome.manifest,
  ...(redactedOutcome.changeset !== undefined ? { changeset: redactedOutcome.changeset } : {}),
  context: [],
  localPolicy: {
    captureMode: "default",
    include: ["**"],
    exclude: [],
    denyRulesVersion: DENY_RULES_VERSION,
    caps: DEFAULT_CAPS,
  },
  redaction: redactedOutcome.redaction,
};

mkdirSync(FIXTURES_DIR, { recursive: true });
for (const [name, payload] of Object.entries({
  "changeset-basic": changesetBasic,
  "changeset-redacted": changesetRedacted,
  "snapshot-basic": snapshotBasic,
})) {
  const bytes = canonicalBytes(payload);
  writeFileSync(join(FIXTURES_DIR, `${name}.payload.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(join(FIXTURES_DIR, `${name}.canonical.json`), bytes);
  writeFileSync(join(FIXTURES_DIR, `${name}.digest.txt`), `${digestOf(bytes)}\n`);
  process.stdout.write(`${name}: ${bytes.byteLength} canonical bytes, ${digestOf(bytes)}\n`);
}
