// Lossless, deterministic representation of filesystem paths whose bytes are
// not valid UTF-8 (spec 7.2: "Invalid UTF-8 in a path is represented with an
// escaped, lossless byte encoding in the manifest and the file's contents are
// excluded").
//
// Encoding: valid UTF-8 sequences pass through as themselves; every byte that
// is not part of a valid sequence becomes `%XX` (uppercase hex). Inside an
// encoded path a literal `%` byte becomes `%25`, so the encoding is
// invertible — {@link decodePathBytes} reproduces the original bytes exactly.
//
// A path whose bytes are already valid UTF-8 is returned untouched and is NOT
// escaped, so ordinary paths containing `%` keep their literal form and the
// canonical bytes of an ordinary workspace never change. The manifest marks
// encoded paths by carrying them with a redaction record of class
// `invalid_path`, which is also what tells a reader to apply the inverse.
//
// Platform note: this encoder is unit-tested on raw byte inputs rather than
// real directory entries because APFS (and any HFS+ volume) rejects filenames
// that are not valid UTF-8 outright, so such a name cannot be created on the
// development platform. Linux/ext4 and Windows both can produce them, hence
// the encoder. Node also decodes dirent names lossily when asked for strings,
// so callers must hand this function the raw bytes (`{ encoding: "buffer" }`
// on readdir, raw Buffers from `git -z` output).
//
// Pure module: no filesystem, no git, no network.

export interface EncodedPath {
  path: string;
  /** True when at least one byte had to be escaped. */
  encoded: boolean;
}

/** Length of the UTF-8 sequence starting at `i`, or 0 when it is invalid. */
function sequenceLength(bytes: Buffer, i: number): number {
  const b0 = bytes[i] as number;
  if (b0 < 0x80) return 1;
  const cont = (index: number, lo = 0x80, hi = 0xbf): boolean => {
    const b = bytes[index];
    return b !== undefined && b >= lo && b <= hi;
  };
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(i + 1) ? 2 : 0;
  if (b0 === 0xe0) return cont(i + 1, 0xa0, 0xbf) && cont(i + 2) ? 3 : 0;
  if (b0 >= 0xe1 && b0 <= 0xec) return cont(i + 1) && cont(i + 2) ? 3 : 0;
  // ED A0..BF would be a surrogate: not valid UTF-8.
  if (b0 === 0xed) return cont(i + 1, 0x80, 0x9f) && cont(i + 2) ? 3 : 0;
  if (b0 >= 0xee && b0 <= 0xef) return cont(i + 1) && cont(i + 2) ? 3 : 0;
  if (b0 === 0xf0) return cont(i + 1, 0x90, 0xbf) && cont(i + 2) && cont(i + 3) ? 4 : 0;
  if (b0 >= 0xf1 && b0 <= 0xf3) return cont(i + 1) && cont(i + 2) && cont(i + 3) ? 4 : 0;
  if (b0 === 0xf4) return cont(i + 1, 0x80, 0x8f) && cont(i + 2) && cont(i + 3) ? 4 : 0;
  return 0; // C0/C1 (overlong), F5..FF (out of range), or a stray continuation
}

export function isValidUtf8Bytes(bytes: Buffer): boolean {
  for (let i = 0; i < bytes.length; ) {
    const length = sequenceLength(bytes, i);
    if (length === 0) return false;
    i += length;
  }
  return true;
}

function escapeByte(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Encode raw path bytes for the manifest. Valid UTF-8 is returned unchanged;
 * otherwise every invalid byte (and every literal `%`) is percent-escaped.
 */
export function encodePathBytes(bytes: Buffer): EncodedPath {
  if (isValidUtf8Bytes(bytes)) return { path: bytes.toString("utf8"), encoded: false };
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const length = sequenceLength(bytes, i);
    if (length === 0) {
      out += escapeByte(bytes[i] as number);
      i += 1;
      continue;
    }
    const chunk = bytes.subarray(i, i + length);
    out += length === 1 && chunk[0] === 0x25 ? "%25" : chunk.toString("utf8");
    i += length;
  }
  return { path: out, encoded: true };
}

/** Inverse of {@link encodePathBytes} for a path that was encoded. */
export function decodePathBytes(path: string): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < path.length; ) {
    if (path[i] === "%" && /^[0-9A-F]{2}$/.test(path.slice(i + 1, i + 3))) {
      parts.push(Buffer.from([Number.parseInt(path.slice(i + 1, i + 3), 16)]));
      i += 3;
      continue;
    }
    const codePoint = path.codePointAt(i) as number;
    const char = String.fromCodePoint(codePoint);
    parts.push(Buffer.from(char, "utf8"));
    i += char.length;
  }
  return Buffer.concat(parts);
}

/**
 * Encode a path that arrived as a JS string. Well-formed strings pass through;
 * lone surrogates (Windows, WTF-8 sources) are escaped as their WTF-8 bytes so
 * the result is still well-formed Unicode and still invertible.
 */
export function encodePathString(path: string): EncodedPath {
  if (path.isWellFormed()) return { path, encoded: false };
  let out = "";
  for (const unit of path) {
    if (unit.isWellFormed()) {
      out += unit === "%" ? "%25" : unit;
      continue;
    }
    const code = unit.charCodeAt(0);
    // WTF-8 encoding of the lone surrogate: 3 bytes, ED xx xx.
    out +=
      escapeByte(0xe0 | (code >> 12)) +
      escapeByte(0x80 | ((code >> 6) & 0x3f)) +
      escapeByte(0x80 | (code & 0x3f));
  }
  return { path: out, encoded: true };
}
