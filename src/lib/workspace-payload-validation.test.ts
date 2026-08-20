import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_SCHEMA_VERSIONS,
  MAX_CANONICAL_PAYLOAD_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  computePayloadDigest,
  validateWorkspacePayload,
  verifyPayloadDigest,
} from "./workspace-payload-validation";

const fixturesDir = join(process.cwd(), "cli", "fixtures");

/** A minimal valid changeset payload; tests mutate clones of it. */
function basePayload(): Record<string, unknown> {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    kind: "changeset",
    captureMode: "default",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "demo", vcs: "git", baseState: { headSha: "abc123" } },
    manifest: [
      { path: "src/a.ts", status: "modified", size: 12, mode: "regular", contentIncluded: true },
    ],
    changeset: [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
    context: [],
    localPolicy: {
      captureMode: "default",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/2",
      caps: {
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
      },
    },
    redaction: {
      rulesVersion: "ternary-redaction/2",
      withheldFiles: [],
      redactedSpans: [],
      truncated: [],
      omittedManifestEntries: 0,
    },
  };
}

/** Assert the payload is rejected as invalid, naming `field`. */
function expectInvalid(payload: unknown, field: string) {
  const result = validateWorkspacePayload(payload);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected validation to fail");
  expect(result.error.code).toBe("invalid_payload");
  if (result.error.code !== "invalid_payload") throw new Error("expected invalid_payload");
  expect(result.error.field).toBe(field);
  return result.error;
}

describe("shared-fixture conformance (spec fixed decision 9)", () => {
  const fixtureNames = readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".payload.json"))
    .map((name) => name.replace(/\.payload\.json$/, ""))
    .sort();

  it("finds the shipped fixture set", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    describe(name, () => {
      const canonicalBytes = readFileSync(join(fixturesDir, `${name}.canonical.json`));
      const expectedDigest = readFileSync(join(fixturesDir, `${name}.digest.txt`), "utf8").trim();

      it("accepts the logical payload", () => {
        const logical = JSON.parse(readFileSync(join(fixturesDir, `${name}.payload.json`), "utf8")) as unknown;
        const result = validateWorkspacePayload(logical);
        if (!result.ok) throw new Error(`fixture ${name} rejected: ${result.error.message}`);
        expect(result.ok).toBe(true);
      });

      it("accepts the exact canonical bytes the CLI transmits", () => {
        const parsed = JSON.parse(canonicalBytes.toString("utf8")) as unknown;
        const result = validateWorkspacePayload(parsed);
        if (!result.ok) throw new Error(`fixture ${name} canonical bytes rejected: ${result.error.message}`);
        expect(result.ok).toBe(true);
      });

      it("reproduces the shipped digest over the canonical bytes", () => {
        expect(computePayloadDigest(canonicalBytes)).toBe(expectedDigest);
        expect(verifyPayloadDigest(canonicalBytes, expectedDigest)).toEqual({ ok: true, digest: expectedDigest });
      });

      it("stays within the transport byte cap", () => {
        expect(canonicalBytes.byteLength).toBeLessThanOrEqual(MAX_CANONICAL_PAYLOAD_BYTES);
      });
    });
  }
});

describe("schemaVersion gate", () => {
  it("accepts workspace-review/1", () => {
    expect(validateWorkspacePayload(basePayload()).ok).toBe(true);
    expect(ACCEPTED_SCHEMA_VERSIONS).toEqual(["workspace-review/1"]);
  });

  it("rejects an unknown version and names the accepted versions", () => {
    const result = validateWorkspacePayload({ ...basePayload(), schemaVersion: "workspace-review/2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("unsupported_schema_version");
    if (result.error.code !== "unsupported_schema_version") throw new Error("wrong code");
    expect(result.error.acceptedVersions).toEqual(["workspace-review/1"]);
    expect(result.error.received).toBe("workspace-review/2");
  });

  it("rejects a missing or non-string version", () => {
    const withoutVersion = basePayload();
    delete withoutVersion.schemaVersion;
    expect(validateWorkspacePayload(withoutVersion)).toMatchObject({
      ok: false,
      error: { code: "unsupported_schema_version" },
    });
    expect(validateWorkspacePayload({ ...basePayload(), schemaVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "unsupported_schema_version" },
    });
  });

  it("rejects a non-object payload", () => {
    for (const value of [null, "string", 42, []]) {
      expect(validateWorkspacePayload(value)).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    }
  });
});

describe("strict field discipline (spec §8.4)", () => {
  it("rejects an unknown top-level field", () => {
    expectInvalid({ ...basePayload(), extra: 1 }, "payload.extra");
  });

  it("rejects an unknown nested field", () => {
    const payload = basePayload();
    (payload.workspace as Record<string, unknown>).sneaky = "x";
    expectInvalid(payload, "payload.workspace.sneaky");
  });

  it("rejects an unknown field inside an array entry", () => {
    const payload = basePayload();
    (payload.manifest as Record<string, unknown>[])[0].extra = true;
    expectInvalid(payload, "payload.manifest[0].extra");
  });

  it("rejects an unknown cap", () => {
    const payload = basePayload();
    const caps = (payload.localPolicy as Record<string, unknown>).caps as Record<string, unknown>;
    caps.unlimited = 1;
    expectInvalid(payload, "payload.localPolicy.caps.unlimited");
  });

  it("rejects null in place of an omitted optional", () => {
    const payload = basePayload();
    (payload.workspace as Record<string, unknown>).branch = null;
    expectInvalid(payload, "payload.workspace.branch");
  });

  it("rejects null in a required field", () => {
    const payload = basePayload();
    payload.manifest = null;
    expectInvalid(payload, "payload.manifest");
  });

  it("rejects a missing required field", () => {
    const payload = basePayload();
    delete payload.redaction;
    expectInvalid(payload, "payload.redaction");
  });

  it("rejects fractional, negative, -0, NaN, and string numbers", () => {
    for (const [value, label] of [
      [1.5, "fractional"],
      [-1, "negative"],
      [-0, "negative zero"],
      [Number.NaN, "NaN"],
      ["12", "string"],
    ] as const) {
      const payload = basePayload();
      (payload.manifest as Record<string, unknown>[])[0].size = value;
      const error = expectInvalid(payload, "payload.manifest[0].size");
      expect(error.message, label).toContain("payload.manifest[0].size");
    }
  });

  it("rejects an out-of-vocabulary enum", () => {
    expectInvalid({ ...basePayload(), kind: "Changeset" }, "payload.kind");
    expectInvalid({ ...basePayload(), captureMode: "everything" }, "payload.captureMode");
    const payload = basePayload();
    (payload.manifest as Record<string, unknown>[])[0].mode = "directory";
    expectInvalid(payload, "payload.manifest[0].mode");
  });

  it("rejects a marker field that is not the literal true", () => {
    const payload = basePayload();
    (payload.manifest as Record<string, unknown>[])[0].binary = false;
    expectInvalid(payload, "payload.manifest[0].binary");
  });

  it("rejects a foreign tool name", () => {
    const payload = basePayload();
    payload.tool = { name: "other-cli", version: "9" };
    expectInvalid(payload, "payload.tool.name");
  });
});

describe("conditional shape rules", () => {
  it("rejects from/similarity on a non-renamed manifest entry", () => {
    const payload = basePayload();
    (payload.manifest as Record<string, unknown>[])[0].from = "src/old.ts";
    expectInvalid(payload, "payload.manifest[0].from");
  });

  it("accepts from/similarity on a renamed entry and bounds similarity", () => {
    const payload = basePayload();
    payload.manifest = [
      { path: "src/b.ts", status: "renamed", from: "src/a.ts", similarity: 96, size: 4, mode: "regular", contentIncluded: false },
    ];
    payload.changeset = [];
    expect(validateWorkspacePayload(payload).ok).toBe(true);

    const tooSimilar = basePayload();
    tooSimilar.manifest = [
      { path: "src/b.ts", status: "renamed", from: "src/a.ts", similarity: 101, size: 4, mode: "regular", contentIncluded: false },
    ];
    tooSimilar.changeset = [];
    expectInvalid(tooSimilar, "payload.manifest[0].similarity");
  });

  it("rejects linkTarget on a non-symlink entry", () => {
    const payload = basePayload();
    (payload.manifest as Record<string, unknown>[])[0].linkTarget = "elsewhere";
    expectInvalid(payload, "payload.manifest[0].linkTarget");
  });

  it("rejects patch and content together on one changeset entry", () => {
    const payload = basePayload();
    payload.changeset = [{ path: "src/a.ts", status: "added", patch: "p", content: "c" }];
    expectInvalid(payload, "payload.changeset[0].content");
  });

  it("rejects snapshot entries on a changeset and vice versa", () => {
    expectInvalid({ ...basePayload(), snapshot: [] }, "payload.snapshot");
    const snapshot = basePayload();
    snapshot.kind = "snapshot";
    snapshot.captureMode = "all";
    expectInvalid(snapshot, "payload.changeset");
  });

  it("rejects baseState on a snapshot", () => {
    const payload = basePayload();
    payload.kind = "snapshot";
    payload.captureMode = "all";
    delete payload.changeset;
    payload.snapshot = [];
    expectInvalid(payload, "payload.workspace.baseState");
  });

  it("accepts the literal unborn baseState", () => {
    const payload = basePayload();
    (payload.workspace as Record<string, unknown>).baseState = "unborn";
    expect(validateWorkspacePayload(payload).ok).toBe(true);
  });

  it("rejects any other baseState string", () => {
    const payload = basePayload();
    (payload.workspace as Record<string, unknown>).baseState = "orphan";
    expectInvalid(payload, "payload.workspace.baseState");
  });

  it("rejects an inverted context line range", () => {
    const payload = basePayload();
    payload.context = [{ path: "src/a.ts", startLine: 9, endLine: 3, content: "x" }];
    expectInvalid(payload, "payload.context[0].endLine");

    const zeroBased = basePayload();
    zeroBased.context = [{ path: "src/a.ts", startLine: 0, endLine: 3, content: "x" }];
    expectInvalid(zeroBased, "payload.context[0].startLine");
  });

  it("rejects a context excerpt whose path is not a string", () => {
    for (const badPath of [null, 42, { nested: true }, ["a"], true]) {
      const payload = basePayload();
      payload.context = [{ path: badPath, startLine: 1, endLine: 3, content: "x" }];
      expectInvalid(payload, "payload.context[0].path");
    }
  });
});

describe("evidence provenance", () => {
  it("accepts local evidence", () => {
    const payload = basePayload();
    payload.evidence = [
      { origin: "local", trust: "unverified_client", status: "complete", label: "npm test", exitCode: 0, output: "ok" },
    ];
    expect(validateWorkspacePayload(payload).ok).toBe(true);
  });

  it("rejects a forged local/isolated trust pairing", () => {
    const payload = basePayload();
    payload.evidence = [{ origin: "local", trust: "isolated", status: "complete", label: "npm test" }];
    expectInvalid(payload, "payload.evidence[0].trust");
  });

  it("rejects sandbox-origin evidence outright (alpha contract)", () => {
    const payload = basePayload();
    payload.evidence = [{ origin: "sandbox", trust: "isolated", status: "complete", label: "sandbox sbx_1" }];
    expectInvalid(payload, "payload.evidence[0].origin");
  });
});

describe("verifyPayloadDigest", () => {
  const bytes = Buffer.from('{"a":1}', "utf8");
  const digest = computePayloadDigest(bytes);

  it("computes the sha256: prefixed hex form", () => {
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts a matching digest, case-insensitively", () => {
    expect(verifyPayloadDigest(bytes, digest).ok).toBe(true);
    expect(verifyPayloadDigest(bytes, digest.toUpperCase().replace("SHA256", "sha256")).ok).toBe(true);
    expect(verifyPayloadDigest(bytes, ` ${digest} `).ok).toBe(true);
  });

  it("rejects a digest over different bytes", () => {
    expect(verifyPayloadDigest(Buffer.from('{"a":2}', "utf8"), digest)).toMatchObject({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("rejects a missing header", () => {
    expect(verifyPayloadDigest(bytes, null)).toMatchObject({ ok: false, reason: "missing_header" });
    expect(verifyPayloadDigest(bytes, "  ")).toMatchObject({ ok: false, reason: "missing_header" });
  });

  it("rejects a malformed header", () => {
    expect(verifyPayloadDigest(bytes, "deadbeef")).toMatchObject({ ok: false, reason: "malformed_header" });
    expect(verifyPayloadDigest(bytes, "md5:0123")).toMatchObject({ ok: false, reason: "malformed_header" });
  });

  it("never echoes the presented header back as the computed digest", () => {
    const result = verifyPayloadDigest(bytes, "sha256:" + "0".repeat(64));
    expect(result).toMatchObject({ ok: false, reason: "digest_mismatch" });
    expect(result.digest).toBe(digest);
  });
});
