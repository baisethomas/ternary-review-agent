import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertNoCaseCollisions,
  canonicalBytes,
  comparePathsBytewise,
  digestOf,
  finalizePayload,
  jcsSerialize,
  normalizePath,
} from "./payload.js";
import { DEFAULT_CAPS, REDACTION_RULES_VERSION, SCHEMA_VERSION } from "./types.js";
import type { CanonicalPayload } from "./types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("normalizePath", () => {
  it("uses / separators and strips ./ segments", () => {
    expect(normalizePath("./a/./b/c.ts")).toBe("a/b/c.ts");
    expect(normalizePath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });

  it("NFC-normalizes paths (but never contents)", () => {
    const decomposed = "café.ts"; // e + combining acute
    expect(normalizePath(decomposed)).toBe("café.ts");
    expect(normalizePath("café.ts")).toBe("café.ts");
  });

  it("hard-errors on traversal and absolute paths, naming the path", () => {
    expect(() => normalizePath("../outside.ts")).toThrowError(/outside\.ts/);
    expect(() => normalizePath("a/../../b.ts")).toThrowError(/escapes the Workspace Root/);
    expect(() => normalizePath("/etc/passwd")).toThrowError(/absolute path/);
  });
});

describe("case-collision determinism", () => {
  it("rejects paths differing only by case", () => {
    expect(() => assertNoCaseCollisions(["src/A.ts", "src/a.ts"])).toThrowError(
      /differ only by case/,
    );
  });

  it("accepts distinct paths", () => {
    expect(() => assertNoCaseCollisions(["a.ts", "b.ts", "sub/a.ts"])).not.toThrow();
  });
});

describe("jcsSerialize (RFC 8785)", () => {
  it("sorts members by UTF-16 code units with no whitespace", () => {
    expect(jcsSerialize({ b: 1, a: 2, ab: 3 })).toBe('{"a":2,"ab":3,"b":1}');
  });

  it("omits absent optionals and rejects null", () => {
    expect(jcsSerialize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => jcsSerialize({ a: null })).toThrowError(/null is not permitted/);
  });

  it("rejects non-integer and negative numbers", () => {
    expect(() => jcsSerialize({ a: 1.5 })).toThrowError(/non-negative integer/);
    expect(() => jcsSerialize({ a: -1 })).toThrowError(/non-negative integer/);
    expect(jcsSerialize({ a: 0 })).toBe('{"a":0}');
  });

  it("does not Unicode-normalize string values", () => {
    const decomposed = "é";
    expect(jcsSerialize({ s: decomposed })).toBe(`{"s":"${decomposed}"}`);
  });
});

function minimalPayload(): CanonicalPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "changeset",
    captureMode: "default",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "w", vcs: "git", baseState: { headSha: "a".repeat(40) } },
    manifest: [
      {
        path: "a.ts",
        status: "added",
        size: 4,
        mode: "regular",
        contentIncluded: true,
      },
    ],
    changeset: [{ path: "a.ts", status: "added", content: "hi\n" }],
    context: [],
    localPolicy: {
      captureMode: "default",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/1",
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
}

describe("canonical bytes and digest", () => {
  it("is byte-for-byte deterministic for identical logical payloads", () => {
    const one = canonicalBytes(minimalPayload());
    const two = canonicalBytes(minimalPayload());
    expect(Buffer.compare(one, two)).toBe(0);
    expect(digestOf(one)).toBe(digestOf(two));
    expect(digestOf(one)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the digest when any content byte changes", () => {
    const base = minimalPayload();
    const changed = minimalPayload();
    (changed.changeset ?? [])[0]!.content = "hi!\n";
    expect(digestOf(canonicalBytes(base))).not.toBe(digestOf(canonicalBytes(changed)));
  });
});

describe("total payload cap", () => {
  it("drops content deterministically instead of failing open", () => {
    const payload = minimalPayload();
    (payload.changeset ?? [])[0]!.content = "x".repeat(5_000);
    const caps = { ...DEFAULT_CAPS, payloadBytes: 2_000 };
    const finalized = finalizePayload(payload, caps);
    expect(finalized.bytes.byteLength).toBeLessThanOrEqual(2_000);
    expect(finalized.payload.redaction.truncated).toHaveLength(1);
    expect(finalized.payload.manifest[0]!.contentIncluded).toBe(false);
  });
});

describe("bytewise path ordering", () => {
  it("orders by UTF-8 bytes, not locale", () => {
    const paths = ["b.ts", "a.ts", "Z.ts"];
    paths.sort(comparePathsBytewise);
    expect(paths).toEqual(["Z.ts", "a.ts", "b.ts"]);
  });
});

describe("shared contract fixtures (spec 8.4: canonical-byte fixtures)", () => {
  const cases = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".payload.json"))
    .map((f) => f.replace(/\.payload\.json$/, ""));

  it("has at least one changeset and one snapshot fixture", () => {
    expect(cases.some((c) => c.startsWith("changeset"))).toBe(true);
    expect(cases.some((c) => c.startsWith("snapshot"))).toBe(true);
  });

  for (const name of cases) {
    it(`reproduces canonical bytes and digest for ${name}`, () => {
      const logical = JSON.parse(
        readFileSync(join(FIXTURES_DIR, `${name}.payload.json`), "utf8"),
      ) as CanonicalPayload;
      const expectedBytes = readFileSync(join(FIXTURES_DIR, `${name}.canonical.json`));
      const expectedDigest = readFileSync(join(FIXTURES_DIR, `${name}.digest.txt`), "utf8").trim();
      const bytes = canonicalBytes(logical);
      expect(bytes.toString("utf8")).toBe(expectedBytes.toString("utf8"));
      expect(Buffer.compare(bytes, expectedBytes)).toBe(0);
      expect(digestOf(bytes)).toBe(expectedDigest);
    });
  }
});
