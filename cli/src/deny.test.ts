import { describe, expect, it } from "vitest";
import {
  isBinaryContent,
  isIgnored,
  isKeyMaterialContent,
  isLfsPointer,
  parseIgnoreFile,
  orderRules,
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

  it("represents invalid-UTF-8 paths losslessly and excludes their content", () => {
    // capture.ts hands the pipeline an already-encoded path; this is the
    // pipeline half of spec 7.2 (the encoder itself is pathbytes.test.ts).
    const capture = fakeCapture([
      { ...worktreeFile("caf%E9.ts", "added"), pathEncoded: true as const },
      worktreeFile("ok.ts"),
    ]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({
      "caf%E9.ts": "must never be read",
      "ok.ts": "fine\n",
    }));
    expect(outcome.manifest).toContainEqual({
      path: "caf%E9.ts",
      status: "added",
      size: 0,
      mode: "regular",
      contentIncluded: false,
    });
    expect(outcome.redaction.withheldFiles).toContainEqual({
      path: "caf%E9.ts",
      class: "invalid_path",
    });
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain("must never be read");
  });

  it("re-encodes ill-formed path strings instead of dropping them", () => {
    const lone = `bad${String.fromCharCode(0xdc80)}.ts`;
    const capture = fakeCapture([worktreeFile(lone)]);
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({}));
    expect(outcome.redaction.withheldFiles).toEqual([
      { path: "bad%ED%B2%80.ts", class: "invalid_path" },
    ]);
    expect(canonicalBytes(payloadFromOutcome(outcome)).toString("utf8")).toContain(
      "bad%ED%B2%80.ts",
    );
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

  // TER-47 fix-round (PR #56, Ternary ⛔): the coverage math in render.ts's
  // snapshotCoverage() assumes a sliced snapshot file's manifest `size` is
  // the ORIGINAL on-disk byte length, and that the bytes actually lost to
  // slicing are visible only via redaction.truncated (originalBytes -
  // keptBytes). This pins that assumption against the real pipeline: if a
  // future change ever set `size` to the post-slice length instead, this
  // test — not just render.test.ts's fixture — would catch it.
  it("a sliced snapshot file's manifest size stays the ORIGINAL on-disk length, not the kept length (TER-47)", () => {
    const caps = { ...DEFAULT_CAPS, snapshotBytes: 5 };
    const capture = fakeCapture([worktreeFile("big.ts", "unchanged")], "snapshot");
    const outcome = runExclusionPipeline(
      capture,
      NO_POLICY,
      caps,
      fakeReaders({ "big.ts": "1234567890" }), // 10 bytes on disk, budget only fits 5
    );
    expect(outcome.redaction.truncated).toEqual([{ path: "big.ts", originalBytes: 10, keptBytes: 5 }]);
    const entry = outcome.manifest.find((m) => m.path === "big.ts");
    expect(entry?.contentIncluded).toBe(true);
    expect(entry?.size).toBe(10); // NOT 5 — size is never mutated after slicing
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

// --- Adversarial matrix: one sample per deny class, proven on CANONICAL
// BYTES rather than on the include list. A file that never reaches the
// changeset can still leak through the manifest, the redaction records, or a
// patch, so the assertion is always "these bytes do not appear anywhere".

const CANARY = "CANARY_SECRET_9f2b7c41";

const DENY_SAMPLES: Array<{ label: string; path: string; content: string; class: string }> = [
  { label: "1 env file", path: ".env", content: `API_KEY=${CANARY}`, class: "env_file" },
  {
    label: "1 env file, deeply nested",
    path: "packages/a/b/c/d/.env.production.local",
    content: `API_KEY=${CANARY}`,
    class: "env_file",
  },
  {
    label: "2 key material by name",
    path: "certs/server.pem",
    content: CANARY,
    class: "key_material",
  },
  {
    label: "2 key material by name at depth",
    path: "deep/dir/id_ed25519",
    content: CANARY,
    class: "key_material",
  },
  {
    label: "2 key material by content under an innocent name",
    path: "notes.txt",
    content: `meeting notes\n-----BEGIN OPENSSH PRIVATE KEY-----\n${CANARY}\n-----END OPENSSH PRIVATE KEY-----\n`,
    class: "key_material",
  },
  {
    label: "3 cloud credential directory",
    path: ".aws/credentials",
    content: CANARY,
    class: "credential_dir",
  },
  {
    label: "3 docker config",
    path: ".docker/config.json",
    content: CANARY,
    class: "credential_dir",
  },
  {
    label: "3 kube config",
    path: ".kube/config",
    content: CANARY,
    class: "credential_dir",
  },
  {
    label: "3 terraform credentials",
    path: ".terraform/terraform.tfstate",
    content: CANARY,
    class: "credential_dir",
  },
  { label: "4 npmrc token store", path: ".npmrc", content: CANARY, class: "token_store" },
  { label: "4 pgpass", path: ".pgpass", content: CANARY, class: "token_store" },
  {
    label: "4 browser credential export",
    path: "profile/logins.json",
    content: CANARY,
    class: "token_store",
  },
  { label: "5 VCS metadata", path: ".git/config", content: CANARY, class: "vcs_metadata" },
  {
    label: "6 dependency tree",
    path: "node_modules/pkg/index.js",
    content: CANARY,
    class: "dependencies",
  },
  { label: "7 build output", path: "dist/bundle.js", content: CANARY, class: "build_output" },
  { label: "7 minified artifact", path: "app.min.js", content: CANARY, class: "build_output" },
];

describe("deny-class completeness (spec 4.2 items 1-10)", () => {
  it("no sample's bytes appear anywhere in the canonical payload", () => {
    const capture = fakeCapture(DENY_SAMPLES.map((s) => worktreeFile(s.path)));
    const files = Object.fromEntries(DENY_SAMPLES.map((s) => [s.path, s.content]));
    const outcome = runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders(files));
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain(CANARY);
    expect(bytes).not.toContain("PRIVATE KEY");
    expect(outcome.changeset).toEqual([]);
    for (const sample of DENY_SAMPLES) {
      expect(
        outcome.redaction.withheldFiles,
        `${sample.label} (${sample.path})`,
      ).toContainEqual({ path: sample.path, class: sample.class });
    }
  });

  it("items 8-10: binary, oversize, and outside-root candidates carry no content bytes", () => {
    const capture = fakeCapture([
      worktreeFile("blob.bin"),
      worktreeFile("huge.txt"),
      {
        path: "link.ts",
        status: "added",
        kind: "symlink",
        mode: "symlink",
        size: 0,
        linkTarget: "../../../etc/passwd",
        source: "worktree",
      },
    ]);
    const outcome = runExclusionPipeline(
      capture,
      NO_POLICY,
      { ...DEFAULT_CAPS, fileBytes: 4 },
      fakeReaders({
        "blob.bin": `\0${CANARY}`,
        "huge.txt": CANARY,
        "link.ts": "never read",
      }),
    );
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain(CANARY);
    expect(bytes).not.toContain("never read");
    expect(outcome.changeset).toEqual([]);
    // The link entry is metadata only: the target string is recorded, never followed.
    expect(outcome.manifest.find((m) => m.path === "link.ts")?.linkTarget).toBe(
      "../../../etc/passwd",
    );
  });

  it("NO include pattern can resurrect ANY denied class", () => {
    // Local Policy includes/negations are evaluated after deny classes and
    // can never win (spec 4.2, last paragraph). Proven per class, not once.
    for (const sample of DENY_SAMPLES) {
      const negations = [`!${sample.path}`, "!*", `!${sample.path.split("/").pop() as string}`];
      const policy = {
        excludeRules: orderRules(parseIgnoreFile(negations.join("\n"))),
        excludePatterns: negations,
      };
      const capture = fakeCapture([worktreeFile(sample.path)]);
      const outcome = runExclusionPipeline(
        capture,
        policy,
        DEFAULT_CAPS,
        fakeReaders({ [sample.path]: sample.content }),
      );
      const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
      expect(bytes, sample.label).not.toContain(CANARY);
      expect(outcome.redaction.withheldFiles, sample.label).toEqual([
        { path: sample.path, class: sample.class },
      ]);
    }
  });

  it("records every withheld, redacted, and truncated action with its class or rule", () => {
    const token = `ghp_${"x".repeat(30)}`;
    const capture = fakeCapture([
      worktreeFile(".env"),
      worktreeFile("app.ts"),
      worktreeFile("long.ts"),
    ]);
    const outcome = runExclusionPipeline(
      capture,
      NO_POLICY,
      { ...DEFAULT_CAPS, changesetChars: 30 },
      fakeReaders({
        ".env": `SECRET=${CANARY}`,
        "app.ts": `const t = "${token}";\n`,
        "long.ts": "y".repeat(200),
      }),
    );
    expect(outcome.redaction.withheldFiles).toEqual([{ path: ".env", class: "env_file" }]);
    expect(outcome.redaction.redactedSpans).toEqual([
      { path: "app.ts", rule: "token.known-prefix", count: 1 },
    ]);
    expect(outcome.redaction.truncated).toEqual([
      { path: "long.ts", originalBytes: 200, keptBytes: 30 - `const t = "[REDACTED]";\n`.length },
    ]);
    const bytes = canonicalBytes(payloadFromOutcome(outcome)).toString("utf8");
    expect(bytes).not.toContain(CANARY);
    expect(bytes).not.toContain(token);
  });

  it("hard-errors when a rename source escapes the Workspace Root", () => {
    const capture = fakeCapture([
      { ...worktreeFile("inside.ts", "renamed"), from: "../outside/secret.ts" },
    ]);
    expect(() =>
      runExclusionPipeline(capture, NO_POLICY, DEFAULT_CAPS, fakeReaders({ "inside.ts": "x" })),
    ).toThrowError(/escapes the Workspace Root/);
  });
});

// TER-43: the snapshot budget is spent source-first, not alphabetically.
// Measured motivation in dogfood §8.11 — a 513 KB `--all` payload carried 47
// content entries and zero source files because docs sorted early.
describe("snapshot content priority (TER-43)", () => {
  function snapshotOutcome(files: Record<string, string>, caps = DEFAULT_CAPS) {
    const capture = fakeCapture(
      Object.keys(files).map((p) => ({ ...worktreeFile(p), status: "unchanged" as const })),
      "snapshot",
    );
    return runExclusionPipeline(capture, NO_POLICY, caps, fakeReaders(files));
  }

  it("spends the byte budget on source before docs, whatever the path order", () => {
    const outcome = snapshotOutcome(
      { "AAA.md": "docs!", "zzz.swift": "swift" },
      { ...DEFAULT_CAPS, snapshotBytes: 5 },
    );
    expect(outcome.snapshot).toEqual([{ path: "zzz.swift", content: "swift" }]);
    expect(outcome.redaction.truncated).toEqual([
      { path: "AAA.md", originalBytes: 5, keptBytes: 0 },
    ]);
    const md = outcome.manifest.find((m) => m.path === "AAA.md");
    expect(md?.contentIncluded).toBe(false);
    expect(outcome.manifest.find((m) => m.path === "zzz.swift")?.contentIncluded).toBe(true);
    expect(outcome.totalSourceBytes).toBe(5);
  });

  it("walks the tier ladder: source, then config, then docs, then the rest", () => {
    const outcome = snapshotOutcome(
      { "a.md": "docs", "b.csv": "rest", "c.json": "conf", "d.ts": "srce" },
      { ...DEFAULT_CAPS, snapshotBytes: 8 },
    );
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["d.ts", "c.json"]);
    expect(outcome.redaction.truncated).toEqual([
      { path: "a.md", originalBytes: 4, keptBytes: 0 },
      { path: "b.csv", originalBytes: 4, keptBytes: 0 },
    ]);
  });

  it("demotes lockfiles below docs", () => {
    const outcome = snapshotOutcome(
      { "package-lock.json": "lock", "readme.md": "docs" },
      { ...DEFAULT_CAPS, snapshotBytes: 4 },
    );
    expect(outcome.snapshot).toEqual([{ path: "readme.md", content: "docs" }]);
    expect(outcome.redaction.truncated).toEqual([
      { path: "package-lock.json", originalBytes: 4, keptBytes: 0 },
    ]);
  });

  it("keeps the manifest bytewise while the snapshot array leads with source (spec 7.2)", () => {
    const outcome = snapshotOutcome({ "AAA.md": "docs", "zzz.swift": "swift" });
    expect(outcome.manifest.map((m) => m.path)).toEqual(["AAA.md", "zzz.swift"]);
    expect(outcome.snapshot?.map((s) => s.path)).toEqual(["zzz.swift", "AAA.md"]);
  });

  it("applies the snapshot file cap in priority order", () => {
    const outcome = snapshotOutcome(
      { "AAA.md": "docs", "zzz.swift": "swift" },
      { ...DEFAULT_CAPS, snapshotFiles: 1 },
    );
    expect(outcome.snapshot).toEqual([{ path: "zzz.swift", content: "swift" }]);
    expect(outcome.redaction.withheldFiles).toEqual([
      { path: "AAA.md", class: "snapshot_file_cap" },
    ]);
    // A file withheld by the count cap gets no manifest entry at all.
    expect(outcome.manifest.map((m) => m.path)).toEqual(["zzz.swift"]);
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
