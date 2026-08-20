import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn(), decr: vi.fn(), eval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    incr = mocks.incr;
    expire = mocks.expire;
    decr = mocks.decr;
    eval = mocks.eval;
  },
}));

describe("workspace-review-gate-redis", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.incr.mockReset();
    mocks.expire.mockReset();
    mocks.decr.mockReset();
    mocks.eval.mockReset();
    process.env.KV_REST_API_URL = "https://redis.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("increments and sets the TTL via a single atomic script call, never separate incr+expire calls", async () => {
    mocks.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    const store = redisWorkspaceGateStore();

    await expect(store.increment("ternary:workspace-review:v1:rate:p:1", 3_600)).resolves.toBe(1);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      ["ternary:workspace-review:v1:rate:p:1"],
      ["3600"],
    );

    await expect(store.increment("ternary:workspace-review:v1:rate:p:1", 3_600)).resolves.toBe(2);
    expect(mocks.eval).toHaveBeenCalledTimes(2);
    // The vulnerable two-round-trip shape (increment, then a separate expire
    // call) must never be used: everything goes through the one atomic
    // script, so there is no network gap in which a process death or a
    // failed second call could leave an incremented key with no TTL.
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it("decrements a concurrency slot", async () => {
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    await redisWorkspaceGateStore().decrement("ternary:workspace-review:v1:concurrent:p");
    expect(mocks.decr).toHaveBeenCalledWith("ternary:workspace-review:v1:concurrent:p");
  });

  it("throws (never silently allows) when Redis is unconfigured", async () => {
    delete process.env.KV_REST_API_URL;
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    await expect(redisWorkspaceGateStore().increment("k", 60)).rejects.toThrow(/not configured/);
  });

  it("propagates a failed atomic increment so the gate can fail closed", async () => {
    mocks.eval.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    await expect(redisWorkspaceGateStore().increment("k", 60)).rejects.toThrow("ECONNREFUSED");
    // A rejected atomic call has no partial effect to strand: unlike a
    // two-call incr-then-expire sequence, there is no separate incr()
    // result left dangling behind the rejected expire() — the whole
    // increment simply never happened.
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it("documents the pre-fix hazard: a separate incr-then-expire sequence can strand a counter with no TTL when expire fails after incr succeeds", async () => {
    // This reproduces the exact failure window the atomic script above
    // closes: incr() succeeds and durably mutates the counter, then the
    // *separate* expire() call fails (transport error, or the process dying
    // between the two REST calls) — leaving the key incremented with no
    // TTL, i.e. a stranded rate-limit counter or concurrency slot that
    // never expires on its own.
    mocks.incr.mockResolvedValueOnce(1);
    mocks.expire.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const value = await mocks.incr("ternary:workspace-review:v1:concurrent:p");
    expect(value).toBe(1); // the increment already landed...
    await expect(mocks.expire("ternary:workspace-review:v1:concurrent:p", 150)).rejects.toThrow(
      "ECONNREFUSED",
    ); // ...but the TTL never got set: the key is now stranded forever.

    // The current store never performs this two-call sequence at all (see
    // the "single atomic script call" test above), so this hazard cannot
    // occur through `redisWorkspaceGateStore().increment(...)`.
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    mocks.eval.mockResolvedValueOnce(1);
    await redisWorkspaceGateStore().increment("ternary:workspace-review:v1:concurrent:p", 150);
    expect(mocks.incr).toHaveBeenCalledTimes(1); // only the hazard-demo call above, never from the store
    expect(mocks.expire).toHaveBeenCalledTimes(1); // ditto
  });
});
