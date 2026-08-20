import { describe, expect, it } from "vitest";
import {
  decodePathBytes,
  encodePathBytes,
  encodePathString,
  isValidUtf8Bytes,
} from "./pathbytes.js";

// These tests operate on raw bytes, never on real directory entries: APFS
// (the development platform's filesystem) refuses to create a filename whose
// bytes are not valid UTF-8, and Node's string-returning readdir would decode
// such a name lossily anyway. The encoder is therefore specified and tested at
// the byte level; capture.ts is responsible for handing it raw bytes.

const INVALID_SEQUENCES: Array<[string, number[]]> = [
  ["lone continuation byte", [0x61, 0x80, 0x62]],
  ["truncated 2-byte sequence", [0xc3]],
  ["truncated 3-byte sequence", [0xe2, 0x82]],
  ["overlong encoding of '/'", [0xc0, 0xaf]],
  ["UTF-16 surrogate half", [0xed, 0xa0, 0x80]],
  ["out-of-range lead byte", [0xf5, 0x80, 0x80, 0x80]],
  ["Latin-1 'é' (not UTF-8)", [0x63, 0x61, 0x66, 0xe9]],
  ["raw 0xff", [0xff]],
];

describe("isValidUtf8Bytes", () => {
  it("accepts valid UTF-8 including multi-byte and 4-byte sequences", () => {
    for (const text of ["", "a/b.ts", "café.ts", "日本語.md", "emoji-🙂.txt"]) {
      expect(isValidUtf8Bytes(Buffer.from(text, "utf8")), text).toBe(true);
    }
  });

  it("rejects every invalid sequence shape", () => {
    for (const [label, bytes] of INVALID_SEQUENCES) {
      expect(isValidUtf8Bytes(Buffer.from(bytes)), label).toBe(false);
    }
  });
});

describe("encodePathBytes", () => {
  it("passes valid UTF-8 through untouched, including a literal %", () => {
    for (const text of ["src/a.ts", "weird %20 name.txt", "日本語/ファイル.md"]) {
      expect(encodePathBytes(Buffer.from(text, "utf8"))).toEqual({ path: text, encoded: false });
    }
  });

  it("escapes only the invalid bytes and keeps the rest readable", () => {
    const bytes = Buffer.from([...Buffer.from("caf", "utf8"), 0xe9, ...Buffer.from(".ts", "utf8")]);
    expect(encodePathBytes(bytes)).toEqual({ path: "caf%E9.ts", encoded: true });
  });

  it("round-trips every invalid sequence losslessly", () => {
    for (const [label, raw] of INVALID_SEQUENCES) {
      const bytes = Buffer.from(raw);
      const { path, encoded } = encodePathBytes(bytes);
      expect(encoded, label).toBe(true);
      expect(path.isWellFormed(), label).toBe(true);
      expect(Buffer.compare(decodePathBytes(path), bytes), label).toBe(0);
    }
  });

  it("round-trips a literal % alongside invalid bytes (no ambiguity)", () => {
    const bytes = Buffer.from([...Buffer.from("a%41b", "utf8"), 0xff]);
    const { path } = encodePathBytes(bytes);
    expect(path).toBe("a%2541b%FF");
    expect(Buffer.compare(decodePathBytes(path), bytes)).toBe(0);
  });

  it("is deterministic and platform-independent (uppercase hex, byte order)", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41]);
    expect(encodePathBytes(bytes).path).toBe("%FF%FEA");
    expect(encodePathBytes(bytes)).toEqual(encodePathBytes(Buffer.from([0xff, 0xfe, 0x41])));
  });
});

describe("encodePathString", () => {
  it("passes well-formed strings through", () => {
    expect(encodePathString("src/a.ts")).toEqual({ path: "src/a.ts", encoded: false });
  });

  it("escapes lone surrogates as their WTF-8 bytes, keeping the result well-formed", () => {
    const lone = `a${String.fromCharCode(0xd800)}b`;
    const { path, encoded } = encodePathString(lone);
    expect(encoded).toBe(true);
    expect(path).toBe("a%ED%A0%80b");
    expect(path.isWellFormed()).toBe(true);
    // Decoding yields the WTF-8 bytes of the lone surrogate, losslessly.
    expect([...decodePathBytes(path)]).toEqual([0x61, 0xed, 0xa0, 0x80, 0x62]);
  });
});
