import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_GATE_CONFIG,
  concurrencyKey,
  enterWorkspaceReviewGate,
  inMemoryWorkspaceGateStore,
  rateLimitKey,
  workspaceGateConfigFromEnv,
  type WorkspaceGateStore,
} from "./workspace-review-gate";

const principal = "principal-abc";

/** A store whose every operation throws — the Redis-outage stand-in. */
function unavailableStore(): WorkspaceGateStore {
  return {
    async increment() {
      throw new Error("ECONNREFUSED");
    },
    async decrement() {
      throw new Error("ECONNREFUSED");
    },
  };
}

describe("workspaceGateConfigFromEnv", () => {
  it("uses the documented defaults when unset", () => {
    expect(workspaceGateConfigFromEnv({})).toEqual(DEFAULT_WORKSPACE_GATE_CONFIG);
    expect(DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitMax).toBe(10);
    expect(DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitWindowMs).toBe(3_600_000);
    expect(DEFAULT_WORKSPACE_GATE_CONFIG.maxConcurrent).toBe(1);
    expect(DEFAULT_WORKSPACE_GATE_CONFIG.concurrencyTtlMs).toBe(150_000);
  });

  it("is env-tunable", () => {
    const config = workspaceGateConfigFromEnv({
      WORKSPACE_REVIEW_RATE_LIMIT: "3",
      WORKSPACE_REVIEW_RATE_LIMIT_WINDOW_MS: "60000",
      WORKSPACE_REVIEW_MAX_CONCURRENT: "2",
    });
    expect(config).toMatchObject({ rateLimitMax: 3, rateLimitWindowMs: 60_000, maxConcurrent: 2 });
  });

  it("ignores non-positive and non-integer overrides rather than disabling the limit", () => {
    for (const raw of ["0", "-5", "abc", "1.5", ""]) {
      const config = workspaceGateConfigFromEnv({ WORKSPACE_REVIEW_RATE_LIMIT: raw });
      expect(config.rateLimitMax).toBe(DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitMax);
    }
  });

  it("keeps the concurrency TTL above the 120s end-to-end deadline", () => {
    expect(DEFAULT_WORKSPACE_GATE_CONFIG.concurrencyTtlMs).toBeGreaterThan(120_000);
  });
});

describe("enterWorkspaceReviewGate", () => {
  it("allows a request under both limits and releases the slot", async () => {
    const store = inMemoryWorkspaceGateStore();
    const decision = await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0);
    expect(decision.status).toBe("allowed");
    if (decision.status !== "allowed") throw new Error("expected allowed");
    expect(store.counters.get(concurrencyKey(principal))).toBe(1);
    await decision.release();
    expect(store.counters.has(concurrencyKey(principal))).toBe(false);
  });

  it("rate limits after the configured number of requests in the window", async () => {
    const store = inMemoryWorkspaceGateStore();
    const config = { ...DEFAULT_WORKSPACE_GATE_CONFIG, rateLimitMax: 3, maxConcurrent: 5 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decision = await enterWorkspaceReviewGate(store, principal, config, 0);
      expect(decision.status).toBe("allowed");
      if (decision.status === "allowed") await decision.release();
    }
    const denied = await enterWorkspaceReviewGate(store, principal, config, 0);
    expect(denied).toMatchObject({ status: "rate_limited" });
    if (denied.status !== "rate_limited") throw new Error("expected rate_limited");
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(3_600);
  });

  it("does not consume a concurrency slot when the rate limit rejects", async () => {
    const store = inMemoryWorkspaceGateStore();
    const config = { ...DEFAULT_WORKSPACE_GATE_CONFIG, rateLimitMax: 1 };
    const first = await enterWorkspaceReviewGate(store, principal, config, 0);
    if (first.status === "allowed") await first.release();
    await enterWorkspaceReviewGate(store, principal, config, 0);
    expect(store.counters.get(concurrencyKey(principal)) ?? 0).toBe(0);
  });

  it("starts a fresh fixed window after the window rolls over", async () => {
    const store = inMemoryWorkspaceGateStore();
    const config = { ...DEFAULT_WORKSPACE_GATE_CONFIG, rateLimitMax: 1, rateLimitWindowMs: 1_000 };
    const first = await enterWorkspaceReviewGate(store, principal, config, 0);
    if (first.status === "allowed") await first.release();
    expect(await enterWorkspaceReviewGate(store, principal, config, 500)).toMatchObject({ status: "rate_limited" });
    const nextWindow = await enterWorkspaceReviewGate(store, principal, config, 1_500);
    expect(nextWindow.status).toBe("allowed");
  });

  it("isolates counters per Principal", async () => {
    const store = inMemoryWorkspaceGateStore();
    const config = { ...DEFAULT_WORKSPACE_GATE_CONFIG, rateLimitMax: 1 };
    const first = await enterWorkspaceReviewGate(store, "principal-a", config, 0);
    if (first.status === "allowed") await first.release();
    expect(await enterWorkspaceReviewGate(store, "principal-a", config, 0)).toMatchObject({ status: "rate_limited" });
    expect((await enterWorkspaceReviewGate(store, "principal-b", config, 0)).status).toBe("allowed");
  });

  it("enforces the concurrency ceiling and frees the slot the rejected attempt took", async () => {
    const store = inMemoryWorkspaceGateStore();
    const held = await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0);
    expect(held.status).toBe("allowed");

    const denied = await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0);
    expect(denied).toMatchObject({ status: "concurrency_ceiling", retryAfterSeconds: 150 });
    expect(store.counters.get(concurrencyKey(principal))).toBe(1);

    if (held.status !== "allowed") throw new Error("expected allowed");
    await held.release();
    expect((await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0)).status).toBe("allowed");
  });

  it("makes release idempotent so a double release cannot free a foreign slot", async () => {
    const store = inMemoryWorkspaceGateStore();
    const config = { ...DEFAULT_WORKSPACE_GATE_CONFIG, maxConcurrent: 2 };
    const first = await enterWorkspaceReviewGate(store, principal, config, 0);
    const second = await enterWorkspaceReviewGate(store, principal, config, 0);
    if (first.status !== "allowed" || second.status !== "allowed") throw new Error("expected allowed");
    await first.release();
    await first.release();
    expect(store.counters.get(concurrencyKey(principal))).toBe(1);
    await second.release();
  });

  it("FAILS CLOSED when the store is unreachable", async () => {
    const decision = await enterWorkspaceReviewGate(unavailableStore(), principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0);
    expect(decision).toEqual({ status: "gate_unavailable" });
  });

  it("FAILS CLOSED when only the rate-limit counter is unreachable", async () => {
    // The concurrency counter is healthy, so nothing else can catch this:
    // the rate-limit failure alone must stop the request.
    const store: WorkspaceGateStore = {
      async increment(key) {
        if (key.includes(":rate:")) throw new Error("ECONNREFUSED");
        return 1;
      },
      async decrement() {},
    };
    expect(await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0)).toEqual({
      status: "gate_unavailable",
    });
  });

  it("FAILS CLOSED when only the concurrency counter is unreachable", async () => {
    let calls = 0;
    const store: WorkspaceGateStore = {
      async increment() {
        calls += 1;
        if (calls === 1) return 1; // rate-limit counter succeeds
        throw new Error("ECONNREFUSED"); // concurrency counter is down
      },
      async decrement() {},
    };
    expect(await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0)).toEqual({
      status: "gate_unavailable",
    });
  });

  it("never throws out of release, even when the store is down", async () => {
    let increments = 0;
    const store: WorkspaceGateStore = {
      async increment() {
        increments += 1;
        return increments === 1 ? 1 : 1;
      },
      async decrement() {
        throw new Error("ECONNREFUSED");
      },
    };
    const decision = await enterWorkspaceReviewGate(store, principal, DEFAULT_WORKSPACE_GATE_CONFIG, 0);
    if (decision.status !== "allowed") throw new Error("expected allowed");
    await expect(decision.release()).resolves.toBeUndefined();
  });
});

describe("gate keys", () => {
  it("partitions the rate-limit counter by fixed window index", () => {
    expect(rateLimitKey("p", 0, 1_000)).toBe("ternary:workspace-review:v1:rate:p:0");
    expect(rateLimitKey("p", 999, 1_000)).toBe("ternary:workspace-review:v1:rate:p:0");
    expect(rateLimitKey("p", 1_000, 1_000)).toBe("ternary:workspace-review:v1:rate:p:1");
  });

  it("uses a single unwindowed key for concurrency", () => {
    expect(concurrencyKey("p")).toBe("ternary:workspace-review:v1:concurrent:p");
  });
});
