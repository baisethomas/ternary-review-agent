import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn(), decr: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    incr = mocks.incr;
    expire = mocks.expire;
    decr = mocks.decr;
  },
}));

describe("workspace-review-gate-redis", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.incr.mockReset();
    mocks.expire.mockReset();
    mocks.decr.mockReset();
    process.env.KV_REST_API_URL = "https://redis.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("sets the TTL only on the first increment of a counter", async () => {
    mocks.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    const store = redisWorkspaceGateStore();

    await expect(store.increment("ternary:workspace-review:v1:rate:p:1", 3_600)).resolves.toBe(1);
    expect(mocks.expire).toHaveBeenCalledWith("ternary:workspace-review:v1:rate:p:1", 3_600);

    mocks.expire.mockClear();
    await expect(store.increment("ternary:workspace-review:v1:rate:p:1", 3_600)).resolves.toBe(2);
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

  it("propagates transport failures so the gate can fail closed", async () => {
    mocks.incr.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { redisWorkspaceGateStore } = await import("./workspace-review-gate-redis");
    await expect(redisWorkspaceGateStore().increment("k", 60)).rejects.toThrow("ECONNREFUSED");
  });
});
