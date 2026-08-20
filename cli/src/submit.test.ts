// Unit tests for the confirmation prompt's hang-safety (submit.ts). The
// full capture -> confirm -> transmit -> render path is exercised end to
// end in main.test.ts; these tests isolate confirmOrThrow itself so the
// no-hang guarantees can be asserted without a real TTY or a real signal.

import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirmOrThrow, CONFIRM_TIMEOUT_MS } from "./submit.js";
import { TransmitError } from "./transmit.js";
import { CollectorError } from "./types.js";
import type { SubmitIo } from "./submit.js";

function makeIo(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  signal?: AbortSignal,
): SubmitIo {
  return {
    stdout: () => {},
    stderr: () => {},
    env: {},
    stdin,
    signal,
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

  it("aborts immediately (not the 60s timeout) when io.signal fires while the prompt is pending, and tears the prompt down", async () => {
    const stdin = ttyStream();
    const controller = new AbortController();
    const promise = confirmOrThrow(makeIo(stdin, controller.signal), CONFIRM_TIMEOUT_MS);
    // The prompt is now waiting on stdin; nothing is ever written to it —
    // only the signal firing should end this (a real SIGINT during the
    // confirmation prompt).
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();

    await expect(promise).rejects.toBeInstanceOf(TransmitError);
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
    // Fast: the 20ms abort fired, not the 60s CONFIRM_TIMEOUT_MS timer or
    // the (never-closing) stdin.
    expect(Date.now() - start).toBeLessThan(2_000);

    // Prompt teardown: the abort listener this function registered on
    // io.signal must be removed once settled (no leaked listener held past
    // the call), the same discipline transmit.ts's external-signal wiring
    // follows.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("aborts immediately when io.signal is already aborted before the prompt starts", async () => {
    const stdin = ttyStream();
    const controller = new AbortController();
    controller.abort();
    await expect(confirmOrThrow(makeIo(stdin, controller.signal), CONFIRM_TIMEOUT_MS)).rejects.toMatchObject(
      { code: "aborted" },
    );
  });
});
