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
    await expectMapped(429, { error: "rate_limited", retryAfter: 60 }, "rate_limited");
  });

  it("429 concurrency_ceiling -> concurrency_ceiling", async () => {
    await expectMapped(429, { error: "concurrency_ceiling", retryAfter: 5 }, "concurrency_ceiling");
  });

  it("503 -> gate_unavailable", async () => {
    await expectMapped(503, { error: "gate_unavailable" }, "gate_unavailable");
  });

  it("504 -> workspace_review_timeout", async () => {
    await expectMapped(504, { error: "workspace_review_timeout", deadlineMs: 120_000 }, "workspace_review_timeout");
  });

  it("400 unsupported_schema_version -> unsupported_schema_version", async () => {
    await expectMapped(400, { error: "unsupported_schema_version" }, "unsupported_schema_version");
  });

  it("400 invalid_payload -> invalid_payload, names the field in the message", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_payload", detail: { field: "manifest" } }));
    });
    await expect(
      transmitCanonicalPayload(Buffer.from("{}"), "sha256:" + "22".repeat(32), config(server.url)),
    ).rejects.toMatchObject({ code: "invalid_payload" });
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
