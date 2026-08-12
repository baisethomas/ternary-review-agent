import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = mocks.set;
  },
}));

describe("ops-alert-cooldown-redis", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.set.mockReset();
    process.env.KV_REST_API_URL = "https://redis.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("claims with SET NX EX and treats OK as a successful claim", async () => {
    mocks.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const { redisOpsAlertCooldownStore } = await import("./ops-alert-cooldown-redis");
    const store = redisOpsAlertCooldownStore();
    await expect(store.claim("queue_growth", 60_000, 1_000)).resolves.toBe(true);
    await expect(store.claim("queue_growth", 60_000, 1_000)).resolves.toBe(false);
    expect(mocks.set).toHaveBeenCalledWith(
      "ternary:ops-alert:cooldown:v1:queue_growth",
      "1000",
      { nx: true, ex: 60 },
    );
  });
});
