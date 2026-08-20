// Canonical serialization, path/metadata normalization, and digest.
// Pure module: no filesystem, no git, no network.
//
// Canonical bytes follow RFC 8785 (JSON Canonicalization Scheme) per spec 8.4:
// members sorted lexicographically by UTF-16 code units, no insignificant
// whitespace, minimal escaping, integers only, absent optionals omitted.
// For this schema (ASCII member names, non-negative integers, well-formed
// Unicode strings) JSON.stringify's string serialization coincides with JCS.

import { createHash } from "node:crypto";
import { CollectorError } from "./types.js";
import type { CanonicalPayload, Caps } from "./types.js";

// --- Path normalization (spec 8.3) ---

export function normalizePath(rawPath: string): string {
  let p = rawPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    throw new CollectorError(
      "path_outside_root",
      `absolute path is not allowed in a Workspace Review: ${JSON.stringify(rawPath)}`,
    );
  }
  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new CollectorError(
      "path_outside_root",
      `path escapes the Workspace Root: ${JSON.stringify(rawPath)}`,
    );
  }
  // NFC where representable (spec 8.3); applies to paths only, never contents.
  return segments.join("/").normalize("NFC");
}

// Bytewise (UTF-8) comparison for deterministic manifest ordering (spec 7.2).
export function comparePathsBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// On case-insensitive filesystems two paths differing only by case are an
// error so every platform produces the same manifest and digest (spec 7.2).
export function assertNoCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const folded = p.toLowerCase();
    const prior = seen.get(folded);
    if (prior !== undefined && prior !== p) {
      throw new CollectorError(
        "case_collision",
        `paths differ only by case and cannot be captured deterministically: ${JSON.stringify(prior)} vs ${JSON.stringify(p)}`,
      );
    }
    seen.set(folded, p);
  }
}

// --- RFC 8785 canonical serialization ---

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export function jcsSerialize(value: unknown): string {
  return serializeValue(value as JsonValue, "$");
}

function serializeValue(value: JsonValue, at: string): string {
  if (value === null) {
    throw new CollectorError(
      "canonicalization",
      `null is not permitted in the canonical payload (absent optionals are omitted): ${at}`,
    );
  }
  switch (typeof value) {
    case "string":
      if (!value.isWellFormed()) {
        throw new CollectorError(
          "canonicalization",
          `string is not well-formed Unicode: ${at}`,
        );
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new CollectorError(
          "canonicalization",
          `every number in the schema must be a non-negative integer: ${at} = ${String(value)}`,
        );
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serializeValue(v, `${at}[${i}]`)).join(",")}]`;
      }
      // JCS: sort member names by UTF-16 code units. Array.prototype.sort's
      // default comparison is exactly that ordering.
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      const members = keys.map(
        (k) => `${JSON.stringify(k)}:${serializeValue(value[k] as JsonValue, `${at}.${k}`)}`,
      );
      return `{${members.join(",")}}`;
    }
    default:
      throw new CollectorError(
        "canonicalization",
        `unsupported value type ${typeof value} at ${at}`,
      );
  }
}

export function canonicalBytes(payload: CanonicalPayload): Buffer {
  return Buffer.from(jcsSerialize(payload), "utf8");
}

export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// --- Total payload cap (spec 4.4) ---
// Enforced deterministically: while the canonical bytes exceed the cap, drop
// content from the last content-bearing entry in path order, recording the
// truncation. Exclusion is the failure mode; the collector never fails open.

export interface FinalizedPayload {
  payload: CanonicalPayload;
  bytes: Buffer;
  digest: string;
}

export function finalizePayload(
  payload: CanonicalPayload,
  caps: Caps,
): FinalizedPayload {
  let bytes = canonicalBytes(payload);
  while (bytes.byteLength > caps.payloadBytes) {
    if (!dropLastContent(payload)) {
      throw new CollectorError(
        "payload_too_large",
        `canonical payload is ${bytes.byteLength} bytes with no removable content; the cap is ${caps.payloadBytes} bytes`,
      );
    }
    bytes = canonicalBytes(payload);
  }
  return { payload, bytes, digest: digestOf(bytes) };
}

function dropLastContent(payload: CanonicalPayload): boolean {
  const entries: Array<{ path: string; clear: () => void; kept: string }> = [];
  for (const e of payload.changeset ?? []) {
    const kept = e.patch ?? e.content;
    if (kept !== undefined) {
      entries.push({
        path: e.path,
        kept,
        clear: () => {
          delete e.patch;
          delete e.content;
        },
      });
    }
  }
  for (const e of payload.snapshot ?? []) {
    if (e.content !== "") {
      entries.push({
        path: e.path,
        kept: e.content,
        clear: () => {
          e.content = "";
        },
      });
    }
  }
  const last = entries[entries.length - 1];
  if (last === undefined) return false;
  last.clear();
  const manifestEntry = payload.manifest.find((m) => m.path === last.path);
  if (manifestEntry !== undefined) manifestEntry.contentIncluded = false;
  payload.redaction.truncated.push({
    path: last.path,
    originalBytes: Buffer.byteLength(last.kept, "utf8"),
    keptBytes: 0,
  });
  return true;
}
