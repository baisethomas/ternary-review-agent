// Unit tests for the confirmation prompt's hang-safety (submit.ts). The
// full capture -> confirm -> transmit -> render path is exercised end to
// end in main.test.ts; these tests isolate confirmOrThrow itself so the
// no-hang guarantees can be asserted without a real TTY or a real signal.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirmOrThrow, CONFIRM_TIMEOUT_MS } from "./submit.js";
import { CollectorError } from "./types.js";
import type { SubmitIo } from "./submit.js";

function makeIo(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): SubmitIo {
  return {
    stdout: () => {},
    stderr: () => {},
    env: {},
    stdin,
  };
}

function ttyStream(): PassThrough & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

describe("confirmOrThrow", () => {
  it("resolves when the answer is an explicit yes", async () => {
    const stdin = ttyStream();
    const promise = confirmOrThrow(makeIo(stdin), CONFIRM_TIMEOUT_MS);
    stdin.write("yes\n");
    await expect(promise).resolves.toBeUndefined();
  });

  it("aborts (does not throw a hang) when the answer is not yes", async () => {
    const stdin = ttyStream();
    const promise = confirmOrThrow(makeIo(stdin), CONFIRM_TIMEOUT_MS);
    stdin.write("no\n");
    await expect(promise).rejects.toMatchObject({
      code: "usage",
      message: expect.stringContaining("was not explicit"),
    });
  });

  it("aborts, rather than hanging forever, when stdin ends/closes without ever emitting a line", async () => {
    const stdin = ttyStream();
    const promise = confirmOrThrow(makeIo(stdin), CONFIRM_TIMEOUT_MS);
    // destroy() emits 'close' WITHOUT a preceding 'end' — the exact case
    // where the readline async iterator's `.next()` never settles on its
    // own (verified: a bare `await rl[Symbol.asyncIterator]().next()`
    // hangs forever here, whereas `.end()` alone happens to resolve it).
    stdin.destroy();
    await expect(promise).rejects.toBeInstanceOf(CollectorError);
    await expect(promise).rejects.toMatchObject({ code: "usage" });
  });

  it("aborts with a usage-style error mentioning --yes when the confirmation times out", async () => {
    const stdin = ttyStream();
    // A stream that never sends data and never ends: only the timeout race
    // can end this. Use a short injected timeout so the test stays fast.
    const promise = confirmOrThrow(makeIo(stdin), 20);
    await expect(promise).rejects.toMatchObject({
      code: "usage",
      message: expect.stringContaining("--yes"),
    });
    stdin.end();
  });

  it("refuses immediately for a non-TTY stdin without waiting on the timeout", async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = false;
    await expect(confirmOrThrow(makeIo(stdin), CONFIRM_TIMEOUT_MS)).rejects.toMatchObject({
      code: "usage",
      message: expect.stringContaining("--yes"),
    });
  });
});
