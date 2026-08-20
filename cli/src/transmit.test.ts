import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  resolveTransmitConfig,
  TransmitError,
  transmitCanonicalPayload,
} from "./transmit.js";
import type { TransmitConfig } from "./transmit.js";

const CANARY_TOKEN = "sk-super-secret-canary-token-do-not-leak";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/api/workspace-reviews`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      }),
  };
}

function config(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): TransmitConfig {
  return { endpoint: url, token: CANARY_TOKEN, timeoutMs };
}

const VALID_RESULT_BODY = {
  verdict: "pass" as const,
  summary: "no findings",
  findings: [],
  evidence: [],
  redactionApplied: 0,
  droppedFindings: { unknownPath: 0 },
};

describe("resolveTransmitConfig", () => {
  it("requires TERNARY_ENDPOINT (no default endpoint)", () => {
    expect(() => resolveTransmitConfig({})).toThrowError(TransmitError);
    try {
      resolveTransmitConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).code).toBe("usage_missing_endpoint");
    }
  });

  it("requires TERNARY_CLI_TOKEN", () => {
    expect(() => resolveTransmitConfig({ TERNARY_ENDPOINT: "http://x" })).toThrowError(TransmitError);
    try {
      resolveTransmitConfig({ TERNARY_ENDPOINT: "http://x" });
    } catch (err) {
      expect((err as TransmitError).code).toBe("usage_missing_token");
    }
  });

  it("defaults the client timeout to 130000ms", () => {
    const cfg = resolveTransmitConfig({ TERNARY_ENDPOINT: "http://x", TERNARY_CLI_TOKEN: "t" });
    expect(cfg.timeoutMs).toBe(130_000);
  });
});

describe("transmitCanonicalPayload: success round-trip", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends the exact bytes with the required headers and parses the result", async () => {
    const bytes = Buffer.from('{"a":1}', "utf8");
    const digest = "sha256:" + "ab".repeat(32);

    let capturedMethod = "";
    let capturedHeaders: http.IncomingHttpHeaders = {};
    let capturedBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    server = await startServer((req, res, body) => {
      capturedMethod = req.method ?? "";
      capturedHeaders = req.headers;
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(VALID_RESULT_BODY));
    });

    const result = await transmitCanonicalPayload(bytes, digest, config(server.url));

    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["authorization"]).toBe(`Bearer ${CANARY_TOKEN}`);
    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["x-ternary-payload-digest"]).toBe(digest);
    expect(capturedHeaders["content-encoding"]).toBe("identity");
    expect(capturedBody.equals(bytes)).toBe(true);
    expect(result).toEqual(VALID_RESULT_BODY);
  });

  it("returns a findings verdict with the full result shape", async () => {
    const findingsBody = {
      verdict: "findings" as const,
      summary: "one finding",
      findings: [
        {
          ruleId: "r1",
          findingKey: "k1",
          severity: "blocking" as const,
          file: "a.ts",
          line: 3,
          title: "t",
          explanation: "e",
        },
      ],
      evidence: [],
      redactionApplied: 1,
      droppedFindings: { unknownPath: 0 },
      ai: { model: "m", latencyMs: 10 },
    };
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(findingsBody));
    });
    const result = await transmitCanonicalPayload(
      Buffer.from("{}", "utf8"),
      "sha256:" + "00".repeat(32),
      config(server.url),
    );
    expect(result).toEqual(findingsBody);
  });
});

describe("transmitCanonicalPayload: error status mappings", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function expectMapped(
    status: number,
    body: unknown,
    expectedCode: string,
  ): Promise<void> {
    server = await startServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "11".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: expectedCode, httpStatus: status });
  }

  it("401 -> unauthorized", async () => {
    await expectMapped(401, { error: "unauthorized" }, "unauthorized");
  });

  it("413 -> payload_too_large", async () => {
    await expectMapped(413, { error: "payload_too_large" }, "payload_too_large");
  });

  it("429 rate_limited -> rate_limited", async () => {
    // retryAfterSeconds is the field the server actually sends (see
    // src/lib/workspace-review-route.ts / workspace-review-gate.ts and their
    // tests) — never a bare `retryAfter`.
    await expectMapped(429, { error: "rate_limited", retryAfterSeconds: 60 }, "rate_limited");
  });

  it("429 concurrency_ceiling -> concurrency_ceiling", async () => {
    await expectMapped(429, { error: "concurrency_ceiling", retryAfterSeconds: 5 }, "concurrency_ceiling");
  });

  it("503 -> gate_unavailable", async () => {
    await expectMapped(503, { error: "gate_unavailable" }, "gate_unavailable");
  });

  it("rate_limited message carries the retry hint from the body's retryAfterSeconds", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 1_800 }));
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "cc".repeat(32), config(server.url));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).toContain("retry after 1800s");
    }
  });

  it("concurrency_ceiling message carries the retry hint from the body's retryAfterSeconds", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "concurrency_ceiling", retryAfterSeconds: 150 }));
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "dd".repeat(32), config(server.url));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).toContain("retry after 150s");
    }
  });

  it("prefers the standard Retry-After response header over the body field when both are present", async () => {
    server = await startServer((_req, res) => {
      // Header says 42s; body disagrees at 999s — the header should win.
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "42" });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 999 }));
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "ee".repeat(32), config(server.url));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).toContain("retry after 42s");
      expect((err as TransmitError).message).not.toContain("999");
    }
  });

  it("falls back to the body's retryAfterSeconds when no Retry-After header is present", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 7 }));
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "ff".repeat(32), config(server.url));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).toContain("retry after 7s");
    }
  });

  it("504 -> workspace_review_timeout", async () => {
    await expectMapped(504, { error: "workspace_review_timeout", deadlineMs: 120_000 }, "workspace_review_timeout");
  });

  it("400 unsupported_schema_version -> unsupported_schema_version", async () => {
    await expectMapped(400, { error: "unsupported_schema_version" }, "unsupported_schema_version");
  });

  it("400 invalid_payload -> invalid_payload, names the field in the message", async () => {
    // The server's actual shape (src/lib/workspace-review-route.ts step 4):
    // `field` and `message` flat on the body, never nested under `detail`.
    server = await startServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_payload", field: "manifest", message: "manifest must be an array" }));
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "22".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: "invalid_payload", message: expect.stringContaining("manifest") });
  });

  it("422 -> digest_mismatch", async () => {
    await expectMapped(422, { error: "digest_mismatch" }, "digest_mismatch");
  });

  it("an unrecognized error code still produces a TransmitError, not a crash", async () => {
    await expectMapped(500, { error: "something_new" }, "unexpected_status");
  });

  it("malformed JSON response body -> malformed_response", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json{{{");
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "33".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("200 with a body that doesn't match the result shape -> malformed_response", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "44".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });
});

// isWorkspaceReviewResult must deep-validate every field renderResult (and
// the CLI↔server contract) touches, not just the top-level arrays/scalars —
// a shallow check lets a malformed 200 body (e.g. findings: [null], a
// finding missing `file`, ai: null) through as if it were a valid result,
// and renderResult then dereferences it and throws a raw TypeError instead
// of a TransmitError the CLI knows how to report (see main.ts's
// error-to-exit-code mapping). Every case below must reject with
// TransmitError code "malformed_response", never resolve and never throw
// anything else.
describe("transmitCanonicalPayload: 200 responses are deep-validated against the result shape", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function expectMalformed(body: unknown): Promise<void> {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "55".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: "malformed_response" });
  }

  it("a null entry in findings", async () => {
    await expectMalformed({ ...VALID_RESULT_BODY, findings: [null] });
  });

  it("a finding missing file", async () => {
    await expectMalformed({
      ...VALID_RESULT_BODY,
      verdict: "findings",
      findings: [
        {
          ruleId: "r1",
          findingKey: "k1",
          severity: "blocking",
          // file is missing
          title: "t",
          explanation: "e",
        },
      ],
    });
  });

  it("a finding with a non-integer line", async () => {
    await expectMalformed({
      ...VALID_RESULT_BODY,
      verdict: "findings",
      findings: [
        {
          ruleId: "r1",
          findingKey: "k1",
          severity: "blocking",
          file: "a.ts",
          line: 3.5,
          title: "t",
          explanation: "e",
        },
      ],
    });
  });

  it("a finding with an out-of-enum severity", async () => {
    await expectMalformed({
      ...VALID_RESULT_BODY,
      verdict: "findings",
      findings: [
        {
          ruleId: "r1",
          findingKey: "k1",
          severity: "critical", // not blocking | warning | suggestion
          file: "a.ts",
          title: "t",
          explanation: "e",
        },
      ],
    });
  });

  it("ai: null", async () => {
    await expectMalformed({ ...VALID_RESULT_BODY, ai: null });
  });

  it("ai missing latencyMs", async () => {
    await expectMalformed({ ...VALID_RESULT_BODY, ai: { model: "m" } });
  });

  it("malformed droppedFindings (unknownPath as a string)", async () => {
    await expectMalformed({ ...VALID_RESULT_BODY, droppedFindings: { unknownPath: "0" } });
  });

  it("malformed droppedFindings (missing entirely)", async () => {
    const rest: Record<string, unknown> = { ...VALID_RESULT_BODY };
    delete rest.droppedFindings;
    await expectMalformed(rest);
  });

  it("an evidence entry with an invalid origin/trust combination shape", async () => {
    await expectMalformed({
      ...VALID_RESULT_BODY,
      evidence: [
        {
          origin: "local",
          trust: "isolated", // wrong pairing per spec, but shape-wise: still must have commands
          status: "complete",
          label: "npm test",
          commands: "not-an-array",
        },
      ],
    });
  });

  it("an evidence entry with a command missing `command`", async () => {
    await expectMalformed({
      ...VALID_RESULT_BODY,
      evidence: [
        {
          origin: "local",
          trust: "unverified_client",
          status: "complete",
          label: "npm test",
          commands: [{ exitCode: 0, output: "ok" }],
        },
      ],
    });
  });

  it("redactionApplied as a non-number", async () => {
    await expectMalformed({ ...VALID_RESULT_BODY, redactionApplied: "0" });
  });

  it("a well-formed result with every optional field present still passes through", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          verdict: "findings",
          summary: "one finding",
          findings: [
            {
              ruleId: "r1",
              findingKey: "k1",
              severity: "warning",
              file: "a.ts",
              line: 3,
              title: "t",
              explanation: "e",
              suggestedFix: "fix it",
            },
          ],
          evidence: [
            {
              origin: "sandbox",
              trust: "isolated",
              status: "complete",
              label: "sandbox sbx_1",
              commands: [{ command: "npm test", exitCode: 0, output: "ok" }],
              truncation: { skippedCommands: ["npm run lint"] },
              redaction: { redactedSpans: 2 },
            },
          ],
          redactionApplied: 1,
          droppedFindings: { unknownPath: 2 },
          ai: { model: "m", latencyMs: 10, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 },
        }),
      );
    });
    const result = await transmitCanonicalPayload(
      Buffer.from("{}"),
      "sha256:" + "66".repeat(32),
      config(server.url),
    );
    expect(result.verdict).toBe("findings");
  });
});

describe("transmitCanonicalPayload: timeout", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("aborts and reports a local timeout when the server never responds", async () => {
    server = await startServer(() => {
      // Never call res.end() / res.write(): the connection just hangs.
    });
    const start = Date.now();
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "55".repeat(32), config(server.url, 80)),
    ).rejects.toMatchObject({ code: "client_timeout" });
    // The injected 80ms timeout must actually be the one that fired, not the
    // 130s default.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it(
    "still fires the deadline when headers arrive but the response body stalls",
    async () => {
      server = await startServer((_req, res) => {
        // Headers (and a status) arrive — fetch() resolves — but the body
        // never finishes: res.end() is never called. Before the fix, the
        // deadline timer was cleared right after fetch() resolved, so this
        // hung past the deadline; the injected 80ms timeout must still be
        // the one that fires.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"verdict":"pass"');
      });
      const start = Date.now();
      await expect(
        transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "cd".repeat(32), config(server.url, 80)),
      ).rejects.toMatchObject({ code: "client_timeout" });
      expect(Date.now() - start).toBeLessThan(5_000);
    },
    5_000,
  );
});

describe("transmitCanonicalPayload: external abort during body read", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it(
    "maps to \"aborted\" when the external signal fires while headers arrived but the body is still stalled",
    async () => {
      server = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"verdict":"pass"');
        // Never res.end(): only the external signal should end this.
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const start = Date.now();
      await expect(
        transmitCanonicalPayload(
          Buffer.from("{}"),
          "sha256:" + "ce".repeat(32),
          config(server.url, 5_000), // a long client timeout that must NOT be the one that fires
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "aborted" });
      expect(Date.now() - start).toBeLessThan(2_000);
    },
    5_000,
  );
});

describe("transmitCanonicalPayload: external abort (e.g. CLI SIGINT)", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("maps an externally-aborted request to code \"aborted\", never client_timeout", async () => {
    server = await startServer(() => {
      // Never respond: only the external signal ends this request.
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await expect(
      transmitCanonicalPayload(
        Buffer.from("{}"),
        "sha256:" + "99".repeat(32),
        config(server.url, 5_000), // a long client timeout that must NOT be the one that fires
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("aborts immediately when the signal is already aborted before the call", async () => {
    server = await startServer(() => {
      /* never respond */
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      transmitCanonicalPayload(
        Buffer.from("{}"),
        "sha256:" + "aa".repeat(32),
        config(server.url),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("carries no config/usage-style text in the aborted error's message", async () => {
    server = await startServer(() => {
      /* never respond */
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await transmitCanonicalPayload(
        Buffer.from("{}"),
        "sha256:" + "bb".repeat(32),
        config(server.url),
        controller.signal,
      );
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      const message = (err as TransmitError).message.toLowerCase();
      expect(message).not.toContain("timed out");
      expect(message).not.toContain("token");
      expect(message).not.toContain("endpoint");
    }
  });
});

describe("transmitCanonicalPayload: token never leaks", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("the raw token does not appear in a mapped error's message", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "66".repeat(32), config(server.url));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).not.toContain(CANARY_TOKEN);
    }
  });

  it("the raw token does not appear in a network-error message", async () => {
    // Nothing listening on this port: fetch fails with ECONNREFUSED.
    const cfg: TransmitConfig = { endpoint: "http://127.0.0.1:1", token: CANARY_TOKEN, timeoutMs: 5_000 };
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "77".repeat(32), cfg);
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TransmitError);
      expect((err as TransmitError).message).not.toContain(CANARY_TOKEN);
    }
  });

  it("the raw token does not appear in a client-timeout message", async () => {
    server = await startServer(() => {
      /* hang */
    });
    try {
      await transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "88".repeat(32), config(server.url, 60));
      throw new Error("expected transmitCanonicalPayload to reject");
    } catch (err) {
      expect((err as TransmitError).message).not.toContain(CANARY_TOKEN);
    }
  });

  it("the raw token does not appear in resolveTransmitConfig's usage errors", () => {
    try {
      resolveTransmitConfig({ TERNARY_ENDPOINT: "http://x", TERNARY_CLI_TOKEN: "" });
      throw new Error("expected resolveTransmitConfig to throw");
    } catch (err) {
      expect((err as TransmitError).message).not.toContain(CANARY_TOKEN);
    }
  });
});
