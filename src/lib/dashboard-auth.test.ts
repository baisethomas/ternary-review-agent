import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDashboardActor, isDashboardAuthenticated } from "./dashboard-auth";

const auth = vi.fn();
const currentUser = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => auth(),
  currentUser: () => currentUser(),
}));

function signedIn(email: string | null) {
  auth.mockResolvedValue({ userId: "user_1" });
  currentUser.mockResolvedValue(email === null ? null : { primaryEmailAddress: { emailAddress: email } });
}

const originalAllowlist = process.env.DASHBOARD_ALLOWED_EMAILS;
const originalActor = process.env.POLICY_ACTOR;

beforeEach(() => {
  auth.mockReset();
  currentUser.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAllowlist === undefined) delete process.env.DASHBOARD_ALLOWED_EMAILS;
  else process.env.DASHBOARD_ALLOWED_EMAILS = originalAllowlist;
  if (originalActor === undefined) delete process.env.POLICY_ACTOR;
  else process.env.POLICY_ACTOR = originalActor;
});

describe("isDashboardAuthenticated", () => {
  it("refuses a signed-out visitor", async () => {
    auth.mockResolvedValue({ userId: null });
    process.env.DASHBOARD_ALLOWED_EMAILS = "ada@ternary.test";

    expect(await isDashboardAuthenticated()).toBe(false);
    expect(currentUser).not.toHaveBeenCalled();
  });

  it("fails closed when the allowlist is unset", async () => {
    signedIn("ada@ternary.test");
    delete process.env.DASHBOARD_ALLOWED_EMAILS;

    expect(await isDashboardAuthenticated()).toBe(false);
  });

  it("fails closed when the allowlist is empty or only separators", async () => {
    signedIn("ada@ternary.test");
    process.env.DASHBOARD_ALLOWED_EMAILS = " , ";

    expect(await isDashboardAuthenticated()).toBe(false);
  });

  it("admits an allowlisted user regardless of case and surrounding whitespace", async () => {
    signedIn("  Ada@Ternary.test ");
    process.env.DASHBOARD_ALLOWED_EMAILS = " grace@ternary.test , ADA@ternary.TEST ";

    expect(await isDashboardAuthenticated()).toBe(true);
  });

  it("refuses a signed-in user who is not on the allowlist", async () => {
    signedIn("mallory@example.com");
    process.env.DASHBOARD_ALLOWED_EMAILS = "ada@ternary.test,grace@ternary.test";

    expect(await isDashboardAuthenticated()).toBe(false);
  });

  it("refuses a signed-in user with no primary email address", async () => {
    signedIn(null);
    process.env.DASHBOARD_ALLOWED_EMAILS = "ada@ternary.test";

    expect(await isDashboardAuthenticated()).toBe(false);
  });

  it("refuses when Clerk throws, such as on a route the proxy does not cover", async () => {
    auth.mockRejectedValue(new Error("clerkMiddleware did not run"));
    process.env.DASHBOARD_ALLOWED_EMAILS = "ada@ternary.test";

    expect(await isDashboardAuthenticated()).toBe(false);
  });
});

describe("currentDashboardActor", () => {
  it("records the signed-in user's email", async () => {
    signedIn("Ada@Ternary.test");
    process.env.POLICY_ACTOR = "dashboard-fallback";

    expect(await currentDashboardActor()).toBe("ada@ternary.test");
  });

  it("falls back to POLICY_ACTOR when there is no session", async () => {
    currentUser.mockResolvedValue(null);
    process.env.POLICY_ACTOR = "dashboard-fallback";

    expect(await currentDashboardActor()).toBe("dashboard-fallback");
  });

  it("falls back to POLICY_ACTOR when Clerk throws", async () => {
    currentUser.mockRejectedValue(new Error("clerkMiddleware did not run"));
    process.env.POLICY_ACTOR = "dashboard-fallback";

    expect(await currentDashboardActor()).toBe("dashboard-fallback");
  });

  it("warns loudly, naming the recorded actor, when Clerk failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentUser.mockRejectedValue(new Error("clerkMiddleware did not run"));
    process.env.POLICY_ACTOR = "dashboard-fallback";

    await currentDashboardActor();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("dashboard-fallback");
  });

  it("stays quiet when there is simply no session and no error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentUser.mockResolvedValue(null);
    process.env.POLICY_ACTOR = "dashboard-fallback";

    await currentDashboardActor();

    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the shared default when POLICY_ACTOR is unset", async () => {
    currentUser.mockResolvedValue(null);
    delete process.env.POLICY_ACTOR;

    expect(await currentDashboardActor()).toBe("dashboard-admin");
  });
});
