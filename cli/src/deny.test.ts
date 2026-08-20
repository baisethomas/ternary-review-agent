import { describe, expect, it } from "vitest";
import {
  isBinaryContent,
  isIgnored,
  isKeyMaterialContent,
  isLfsPointer,
  parseIgnoreFile,
  pathDenyClass,
  runExclusionPipeline,
} from "./deny.js";
import { canonicalBytes } from "./payload.js";
import { DEFAULT_CAPS, SCHEMA_VERSION } from "./types.js";
import type {
  Candidate,
  CanonicalPayload,
  CaptureResult,
  ContentReaders,
} from "./types.js";

function fakeCapture(candidates: Candidate[], kind: "changeset" | "snapshot" = "changeset"): CaptureResult {
  return {
    workspace: { rootAbs: "/w", label: "w", vcs: "git", headSha: "a".repeat(40), unborn: false },
    kind,
    captureMode: kind === "snapshot" ? "all" : "default",
    candidates,
    preExcluded: [],
  };
}

function fakeReaders(files: Record<string, string>, blobs: Record<string, string> = {}): ContentReaders {
  return {
    readWorktree(relPath) {
      const content = files[relPath];
      if (content === undefined) return { ok: false, reason: "unverifiable" };
      return { ok: true, bytes: Buffer.from(content, "utf8") };
    },
    readBlob(sha) {
      const content = blobs[sha];
      return content === undefined ? null : Buffer.from(content, "utf8");
    },
  };
}

function worktreeFile(path: string, status: Candidate["status"] = "added"): Candidate {
  return { path, status, kind: "regular", mode: "regular", size: 0, source: "worktree" };
}

const NO_POLICY = { excludeRules: [], excludePatterns: [] };

describe("pathDenyClass (spec 4.2)", () => {
  it("denies env files at any depth, with no override", () => {
    expect(pathDenyClass(".env")).toBe("env_file");
    expect(pathDenyClass(".env.local")).toBe("env_file");
    expect(pathDenyClass("packages/api/.env.production")).toBe("env_file");
    expect(pathDenyClass("env.ts")).toBeNull();
  });

  it("denies key material by name at any depth", () => {
    for (const p of [
      "server.pem", "signing.key", "app.p12", "cert.pfx", "release.jks",
      "release.keystore", "apple.p8", "putty.ppk", "login.keychain-db",
      "id_rsa", "deep/nested/dir/id_rsa", "backup/id_ed25519",
      "keys/id_ecdsa.pub", "id_dsa.bak",
    ]) {
      expect(pathDenyClass(p), p).toBe("key_material");
    }
    // Anything under a .ssh directory is denied as a credential directory —
    // still denied, just a more specific class.
    expect(pathDenyClass(".ssh/id_rsa")).toBe("credential_dir");
    expect(pathDenyClass(".ssh/known_hosts")).toBe("credential_dir");
  });

  it("denies credential directories", () => {
    expect(pathDenyClass(".aws/credentials")).toBe("credential_dir");
    expect(pathDenyClass(".kube/config")).toBe("credential_dir");
    expect(pathDenyClass(".config/gcloud/credentials.db")).toBe("credential_dir");
    expect(pathDenyClass(".docker/config.json")).toBe("credential_dir");
    expect(pathDenyClass(".terraform/terraform.tfstate")).toBe("credential_dir");
  });

  it("denies token stores", () => {
    expect(pathDenyClass(".npmrc")).toBe("token_store");
    expect(pathDenyClass(".netrc")).toBe("token_store");
    expect(pathDenyClass(".git-credentials")).toBe("token_store");
    expect(pathDenyClass("infra/prod.tfstate")).toBe("token_store");
  });

  it("denies VCS metadata, dependency trees, and build outputs", () => {
    expect(pathDenyClass(".git/config")).toBe("vcs_metadata");
    expect(pathDenyClass("sub/.hg/store")).toBe("vcs_metadata");
    expect(pathDenyClass("node_modules/x/index.js")).toBe("dependencies");
    expect(pathDenyClass(".venv/bin/python")).toBe("dependencies");
    expect(pathDenyClass("dist/app.js")).toBe("build_output");
    expect(pathDenyClass(".next/server/page.js")).toBe("build_output");
    expect(pathDenyClass("app.min.js")).toBe("build_output");
    expect(pathDenyClass("app.js.map")).toBe("build_output");
  });

  it("allows ordinary source paths", () => {
    expect(pathDenyClass("src/lib/review.ts")).toBeNull();
    expect(pathDenyClass("README.md")).toBeNull();
  });
});

describe("content classification", () => {
  it("classifies NUL bytes and invalid UTF-8 as binary", () => {
    expect(isBinaryContent("a.bin", Buffer.from([1, 2, 0, 4]))).toBe(true);
    expect(isBinaryContent("a.txt", Buffer.from([0xff, 0xfe, 0x41]))).toBe(true);
    expect(isBinaryContent("a.txt", Buffer.from("plain text"))).toBe(false);
    expect(isBinaryContent("logo.png", Buffer.from("not really an image"))).toBe(true);
  });

  it("detects PEM private key material", () => {
    expect(isKeyMaterialContent("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
    expect(isKeyMaterialContent("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(isKeyMaterialContent("-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe(true);
    expect(isKeyMaterialContent("-----BEGIN CERTIFICATE-----")).toBe(false);
  });

  it("detects LFS pointers", () => {
    expect(isLfsPointer("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n")).toBe(true);
    expect(isLfsPointer("regular file")).toBe(false);
  });
});

// The rule set itself (every pattern, positive and negative) is exercised in
// secrets.test.ts; this file proves the pipeline applies it.

describe("ignore files (.gitignore / .ternaryignore subset)", () => {
  const rules = parseIgnoreFile(
    ["# comment", "", "*.log", "tmp/", "/rooted.txt", "docs/**/draft.md", "!keep.log"].join("\n"),
  );

  it("matches basic patterns", () => {
    expect(isIgnored(rules, "a.log")).toBe(true);
    expect(isIgnored(rules, "nested/deep/b.log")).toBe(true);
    expect(isIgnored(rules, "tmp/scratch.txt")).toBe(true);
    expect(isIgnored(rules, "rooted.txt")).toBe(true);
    expect(isIgnored(rules, "docs/a/b/draft.md")).toBe(true);
  });

  it("honors negation and non-matches", () => {
    expect(isIgnored(rules, "keep.log")).toBe(false);
    expect(isIgnored(rules, "src/main.ts")).toBe(false);
    expect(isIgnored(rules, "subdir/rooted.txt")).toBe(false);
  });
});

describe("exclusion pipeline", () => {
  it("a payload built from a workspace containing denied files contains no bytes of them", () => {
    const secret = "SUPER_SECRET_VALUE_12345";
    const keyBody = "-----BEGIN RSA PRIVATE KEY-----\nMIIkey\n-----END RSA PRIVATE KEY-----";
    const capture = fakeCapture([
      worktreeFile(".env"),
      worktreeFile("id_rsa"),
      worktreeFile("node_modules/pkg/index.js"),
      worktreeFile("inline-key.txt"),
      worktreeFile("src/ok.ts"),
    ]);
    const readers = fakeReaders({
      ".env": `API_KEY=${secret}`,
      id_rsa: keyBody,
      "node_modules/pkg/index.js": secret,
      "inline-key.txt": keyBody,
      "src/ok.ts": "export const ok = 1;\n",
    });
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, readers);
    const payload = payloadFromOutcome(outcome);
    const bytes = canonicalBytes(payload).toString("utf8");
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain("PRIVATE KEY");
    expect(outcome.redaction.withheldFiles).toEqual([
      { path: ".env", class: "env_file" },
      { path: "id_rsa", class: "key_material" },
      { path: "inline-key.txt", class: "key_material" },
      { path: "node_modules/pkg/index.js", class: "dependencies" },
    ]);
    expect(outcome.changeset?.map((c) => c.path)).toEqual(["src/ok.ts"]);
  });

  it("evaluates deny classes before policy excludes (no resurrection)", () => {
    const capture = fakeCapture([worktreeFile(".env.local")]);
    const policy = {
      excludeRules: parseIgnoreFile("!.env.local"),
      excludePatterns: ["!.env.local"],
    };
    const outcome = runExclusionPipeline(capture, policy, DEFAULT_CAPS, fakeReaders({ ".env.local": "X=1" }));
    expect(outcome.redaction.withheldFiles).toEqual([{ path: ".env.local", class: "env_file" }]);
  });

  it("applies .ternaryignore policy excludes with a safe reason code", () => {
    const capture = fakeCapture([worktreeFile("generated/big.ts"), worktreeFile("src/a.ts")]);
    const policy = {
      excludeRules: parseIgnoreFile("generated/"),
      excludePatterns: ["generated/"],
    };
    const outcome = runExclusionPipeline(capture, policy, DEFAULT_CAPS, fakeReaders({
      "generated/big.ts": "x",
      "src/a.ts": "y",
    }));
    expect(outcome.redaction.withheldFiles).toEqual([
      { path: "generated/big.ts", class: "policy_excluded" },
    ]);
  });

  it("marks binary and oversized files in the manifest without content bytes", () => {
    const capture = fakeCapture([worktreeFile("img.bin"), worktreeFile("huge.txt")]);
    const caps = { ...DEFAULT_CAPS, fileBytes: 8 };
    const outcome = runExclusionPipeline(capture, NO_POLICY, caps, fakeReaders({
      "img.bin": "a b",
      "huge.txt": "way more than eight bytes",
    }));
    const img = outcome.manifest.find((m) => m.path === "img.bin");
    const huge = outcome.manifest.find((m) => m.path === "huge.txt");
    expect(img?.binary).toBe(true);
    expect(img?.contentIncluded).toBe(false);
    expect(huge?.oversize).toBe(true);
    expect(huge?.contentIncluded).toBe(false);
    expect(outcome.changeset).toEqual([]);
  });

  it("redacts token spans in otherwise transmittable files and records them", () => {
    const token = `ghp_${"z".repeat(30)}`;
    const capture = fakeCapture([worktreeFile("config.ts")]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({
      "config.ts": `const t = "${token}";\n`,
    }));
    expect(outcome.changeset?.[0]?.content).toContain("[REDACTED]");
    expect(outcome.changeset?.[0]?.content).not.toContain(token);
    expect(outcome.redaction.redactedSpans).toEqual([
      { path: "config.ts", rule: "token.known-prefix", count: 1 },
    ]);
  });

  it("keeps deletions in the manifest with no content", () => {
    const capture = fakeCapture([
      { path: "gone.ts", status: "deleted", kind: "deleted", mode: "regular", size: 0, source: "worktree" },
    ]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}));
    expect(outcome.manifest).toEqual([
      { path: "gone.ts", status: "deleted", size: 0, mode: "regular", contentIncluded: false },
    ]);
    expect(outcome.changeset).toEqual([]);
  });

  it("captures symlinks as link entries, never following them", () => {
    const capture = fakeCapture([
      {
        path: "link.ts",
        status: "added",
        kind: "symlink",
        mode: "symlink",
        size: 11,
        linkTarget: "/etc/passwd",
        source: "worktree",
      },
    ]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}));
    expect(outcome.manifest[0]).toMatchObject({
      path: "link.ts",
      mode: "symlink",
      linkTarget: "/etc/passwd",
      contentIncluded: false,
    });
    expect(outcome.changeset).toEqual([]);
  });

  it("captures submodules as metadata only", () => {
    const sha = "c".repeat(40);
    const capture = fakeCapture([
      { path: "vendor-lib", status: "added", kind: "submodule", mode: "regular", size: 0, source: "worktree", blobSha: sha },
    ]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}));
    expect(outcome.manifest[0]).toMatchObject({ path: "vendor-lib", blobSha: sha, contentIncluded: false });
    expect(outcome.redaction.withheldFiles).toEqual([
      { path: "vendor-lib", class: "submodule_metadata_only" },
    ]);
  });

  it("excludes unverifiable reads with the unverifiable reason code (spec 7.3)", () => {
    const capture = fakeCapture([worktreeFile("racy.ts")]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}));
    expect(outcome.redaction.withheldFiles).toEqual([{ path: "racy.ts", class: "unverifiable" }]);
  });

  it("hard-errors on traversal paths, naming the path", () => {
    const capture = fakeCapture([worktreeFile("../escape.ts")]);
    expect(() => runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}))).toThrowError(
      /escape\.ts/,
    );
  });

  it("truncates deterministically at the changeset budget and records it", () => {
    const caps = { ...DEFAULT_CAPS, changesetChars: 10 };
    const capture = fakeCapture([worktreeFile("a.ts"), worktreeFile("b.ts")]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, caps, fakeReaders({
      "a.ts": "123456789012345",
      "b.ts": "abc",
    }));
    expect(outcome.changeset?.[0]?.content).toBe("1234567890");
    expect(outcome.redaction.truncated).toEqual([
      { path: "a.ts", originalBytes: 15, keptBytes: 10 },
      { path: "b.ts", originalBytes: 3, keptBytes: 0 },
    ]);
  });

  it("caps snapshot files and manifest entries by counting, not listing", () => {
    const caps = { ...DEFAULT_CAPS, snapshotFiles: 3, manifestEntries: 2 };
    const files: Record<string, string> = {
      "a.ts": "a",
      "b.ts": "b",
      "c.ts": "c",
      "d.ts": "d",
    };
    const capture = fakeCapture(
      Object.keys(files).map((p) => ({ ...worktreeFile(p), status: "unchanged" as const })),
      "snapshot",
    );
    const outcome = runExclusionPipeline(capture, NO_POLICY, caps, fakeReaders(files));
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(
      outcome.redaction.withheldFiles.filter((w) => w.class === "snapshot_file_cap").map((w) => w.path),
    ).toEqual(["d.ts"]);
    // Three manifest entries hit the cap of two: one is counted, not listed.
    expect(outcome.manifest).toHaveLength(2);
    expect(outcome.redaction.omittedManifestEntries).toBe(1);
  });

  it("produces patches for modifications and full content for additions (spec 8.2)", () => {
    const baseSha = "d".repeat(40);
    const capture = fakeCapture([
      { ...worktreeFile("mod.ts", "modified"), baseSha },
      worktreeFile("new.ts", "added"),
    ]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders(
      { "mod.ts": "one\nTWO\n", "new.ts": "brand new\n" },
      { [baseSha]: "one\ntwo\n" },
    ));
    const mod = outcome.changeset?.find((c) => c.path === "mod.ts");
    const added = outcome.changeset?.find((c) => c.path === "new.ts");
    expect(mod?.patch).toContain("+TWO");
    expect(mod?.content).toBeUndefined();
    expect(added?.content).toBe("brand new\n");
    expect(added?.patch).toBeUndefined();
  });

  it("redacts the HEAD side of a patch: a secret removed in this change never ships", () => {
    // The base blob is not "content the user is sending" in any intuitive
    // sense, but a unified diff carries its removed lines verbatim. A file
    // that HELD a credential at HEAD and no longer does must still not put
    // that credential in the payload.
    const baseSha = "e".repeat(40);
    const token = `ghp_${"q".repeat(30)}`;
    const capture = fakeCapture([{ ...worktreeFile("config.ts", "modified"), baseSha }]);
    const outcome = runExclusionPipeline(
      capture,
      NO_POLICY,
      DEFAULT_CAPS,
      fakeReaders(
        { "config.ts": "const token = process.env.GH_TOKEN;\n" },
        { [baseSha]: `const token = "${token}";\n` },
      ),
    );
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain(token);
    expect(outcome.redaction.redactedSpans).toContainEqual({
      path: "config.ts",
      rule: "token.known-prefix",
      count: 1,
    });
  });

  it("never emits a patch whose base side is private key material", () => {
    const baseSha = "f".repeat(40);
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIsecretkeybytes\n-----END RSA PRIVATE KEY-----\n";
    const capture = fakeCapture([{ ...worktreeFile("deploy.txt", "modified"), baseSha }]);
    const outcome = runExclusionPipeline(
      capture,
      NO_POLICY,
      DEFAULT_CAPS,
      fakeReaders({ "deploy.txt": "no key here anymore\n" }, { [baseSha]: key }),
    );
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain("PRIVATE KEY");
    expect(bytes).not.toContain("MIIsecretkeybytes");
    expect(outcome.changeset?.[0]?.patch).toBeUndefined();
    expect(outcome.changeset?.[0]?.content).toBe("no key here anymore\n");
    expect(outcome.redaction.redactedSpans).toContainEqual({
      path: "deploy.txt",
      rule: "patch.base-withheld",
      count: 1,
    });
  });

  it("keeps LFS pointer text and marks it lfs (never smudges)", () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n";
    const capture = fakeCapture([worktreeFile("model.bin.lfs", "added")]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({
      "model.bin.lfs": pointer,
    }));
    expect(outcome.manifest[0]?.lfs).toBe(true);
    expect(outcome.changeset?.[0]?.content).toBe(pointer);
  });
});

function payloadFromOutcome(
  outcome: ReturnType<typeof runExclusionPipeline>,
): CanonicalPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "changeset",
    captureMode: "default",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "w", vcs: "git", baseState: { headSha: "a".repeat(40) } },
    manifest: outcome.manifest,
    ...(outcome.changeset !== undefined ? { changeset: outcome.changeset } : {}),
    ...(outcome.snapshot !== undefined ? { snapshot: outcome.snapshot } : {}),
    context: [],
    localPolicy: {
      captureMode: "default",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/1",
      caps: DEFAULT_CAPS,
    },
    redaction: outcome.redaction,
  };
}
