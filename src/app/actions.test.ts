import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const currentUser = vi.fn();
const updateRepositoryWatch = vi.fn();
const getInstalledRepository = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => auth(),
  currentUser: () => currentUser(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));
vi.mock("@/lib/dashboard-change-service", () => ({ announceDashboardChange: vi.fn() }));
vi.mock("@/lib/dashboard-data", () => ({
  getInstalledRepository: (...args: unknown[]) => getInstalledRepository(...args),
  getRepositoryDashboardData: vi.fn(),
}));
vi.mock("@/lib/repository-watch-service", () => ({
  updateRepositoryWatch: (...args: unknown[]) => updateRepositoryWatch(...args),
}));
vi.mock("@/lib/usage-budget-service", () => ({ saveUsageBudget: vi.fn() }));

const { setRepositoryWatchAction } = await import("./actions");

function watchForm() {
  const formData = new FormData();
  formData.set("repository", "ternary/agent");
  formData.set("watched", "true");
  return formData;
}

beforeEach(() => {
  auth.mockReset();
  currentUser.mockReset();
  updateRepositoryWatch.mockReset();
  getInstalledRepository.mockReset();
  getInstalledRepository.mockResolvedValue({ installation: { id: 1 } });
  process.env.DASHBOARD_ALLOWED_EMAILS = "ada@ternary.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Server Action authentication", () => {
  // ADR-0003 / proxy.ts: a Server Action is a POST to the page path it is bound to.
  // If that path ever falls outside the proxy matcher, Clerk's context is absent and
  // auth() throws. This pins the consequence: the action fails CLOSED and returns its
  // ordinary unauthenticated result — it does not throw, and it does not write.
  it("refuses and does not write when Clerk context is missing entirely", async () => {
    auth.mockRejectedValue(new Error("clerkMiddleware did not run"));

    const result = await setRepositoryWatchAction({ error: null }, watchForm());

    expect(result).toEqual({ error: "Your session expired. Refresh and sign in again." });
    expect(updateRepositoryWatch).not.toHaveBeenCalled();
  });

  // Pins the ordering the reviewer worried about: the gate must short-circuit before
  // any actor lookup, so a rejected caller never reaches currentDashboardActor().
  it("does not look up an actor for a caller the gate rejects", async () => {
    auth.mockResolvedValue({ userId: null });

    const result = await setRepositoryWatchAction({ error: null }, watchForm());

    expect(result.error).toBe("Your session expired. Refresh and sign in again.");
    expect(currentUser).not.toHaveBeenCalled();
    expect(updateRepositoryWatch).not.toHaveBeenCalled();
  });

  it("records the signed-in user as the actor once the gate has passed", async () => {
    auth.mockResolvedValue({ userId: "user_1" });
    currentUser.mockResolvedValue({ primaryEmailAddress: { emailAddress: "Ada@Ternary.test" } });

    const result = await setRepositoryWatchAction({ error: null }, watchForm());

    expect(result).toEqual({ error: null });
    expect(updateRepositoryWatch).toHaveBeenCalledWith(
      "ternary/agent",
      true,
      { installation: { id: 1 } },
      { actor: "ada@ternary.test" },
    );
  });
});
