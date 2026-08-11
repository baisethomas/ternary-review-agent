import { afterEach, describe, expect, it, vi } from "vitest";
import { syncFindingReviewComments } from "./github";

const currentHead = (headSha: string) => ({ getCurrentHead: async () => headSha });

describe("GitHub finding comments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves a stable finding to a new anchor and resolves its obsolete thread", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 10, body: "<!-- ternary-finding:finding-auth -->", path: "src/old/auth.ts", line: 9, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: false, comments: { nodes: [{ databaseId: 10 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ id: 11 }))
      .mockResolvedValueOnce(Response.json({ data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } } }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "new-head", "token", [{ findingId: "finding-auth", body: "Moved line\n\n<!-- ternary-finding:finding-auth -->", path: "src/moved/auth.ts", line: 42 }], { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2][0]).toContain("/pulls/8/comments");
    expect(JSON.parse(fetch.mock.calls[2][1]?.body as string)).toMatchObject({ path: "src/moved/auth.ts", line: 42 });
    expect(fetch.mock.calls[3][1]?.body).toContain("TernaryResolveReviewThread");
  });

  it("updates and reopens the same thread when the finding location is unchanged", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 10, body: "<!-- ternary-finding:finding-auth -->", path: "src/auth.ts", line: 42, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: true, comments: { nodes: [{ databaseId: 10 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ id: 10 }))
      .mockResolvedValueOnce(Response.json({ data: { unresolveReviewThread: { thread: { id: "thread-1", isResolved: false } } } }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "new-head", "token", [{ findingId: "finding-auth", body: "Still here\n\n<!-- ternary-finding:finding-auth -->", path: "src/auth.ts", line: 42 }], { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") });

    expect(fetch.mock.calls[2][0]).toContain("/pulls/comments/10");
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: "PATCH" });
    expect(fetch.mock.calls[3][1]?.body).toContain("TernaryUnresolveReviewThread");
  });

  it("converges after a retry when replacement creation succeeded before old-thread cleanup", async () => {
    const marker = "<!-- ternary-finding:finding-auth -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([
        { id: 10, body: marker, path: "src/old/auth.ts", line: 9, user: { login: "ternary-review-agent[bot]", type: "Bot" } },
        { id: 11, body: marker, path: "src/auth.ts", line: 42, user: { login: "ternary-review-agent[bot]", type: "Bot" } },
      ]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: "thread-old", isResolved: false, comments: { nodes: [{ databaseId: 10 }] } },
        { id: "thread-current", isResolved: false, comments: { nodes: [{ databaseId: 11 }] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ id: 11 }))
      .mockResolvedValueOnce(Response.json({ data: { resolveReviewThread: { thread: { id: "thread-old", isResolved: true } } } }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-auth", body: `Current\n\n${marker}`, path: "src/auth.ts", line: 42 }], { botLogin: "ternary-review-agent[bot]", ...currentHead("head") });

    expect(fetch.mock.calls[2][0]).toContain("/pulls/comments/11");
    expect(fetch.mock.calls[3][1]?.body).toContain("TernaryResolveReviewThread");
  });

  it("keeps one old thread active when GitHub rejects both replacement anchors", async () => {
    const marker = "<!-- ternary-finding:finding-auth -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 10, body: marker, path: "src/old/auth.ts", line: 9, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: "thread-old", isResolved: false, comments: { nodes: [{ databaseId: 10 }] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(new Response("line is outside the diff", { status: 422 }))
      .mockResolvedValueOnce(new Response("path is outside the diff", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ id: 10 }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-auth", body: `Moved\n\n${marker}`, path: "src/new/auth.ts", line: 42 }], { botLogin: "ternary-review-agent[bot]", ...currentHead("head") });

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[4][0]).toContain("/pulls/comments/10");
    expect(fetch.mock.calls[4][1]).toMatchObject({ method: "PATCH" });
    expect(fetch.mock.calls.some((call) => String(call[1]?.body).includes("TernaryResolveReviewThread"))).toBe(false);
  });

  it("falls back to a file-level thread when GitHub rejects a moved line", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response("line is outside the diff", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ id: 11 }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-auth", body: "Finding\n\n<!-- ternary-finding:finding-auth -->", path: "src/auth.ts", line: 42 }], currentHead("head"));

    expect(JSON.parse(fetch.mock.calls[2][1]?.body as string)).toMatchObject({ subject_type: "file", path: "src/auth.ts" });
  });

  it("keeps the summary review publishable when a finding is outside the diff", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response("line is outside the diff", { status: 422 }))
      .mockResolvedValueOnce(new Response("path is outside the diff", { status: 422 }));
    vi.stubGlobal("fetch", fetch);

    await expect(syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-context", body: "Finding\n\n<!-- ternary-finding:finding-context -->", path: "src/context.ts", line: 42 }], currentHead("head"))).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("skips an unavailable file-level thread without failing the review", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response("path is outside the diff", { status: 422 }));
    vi.stubGlobal("fetch", fetch);

    await expect(syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-file", body: "Finding\n\n<!-- ternary-finding:finding-file -->", path: "src/context.ts" }], currentHead("head"))).resolves.toBeUndefined();
  });

  it("never overwrites marked human comments or marked replies", async () => {
    const marker = "<!-- ternary-finding:finding-auth -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([
        { id: 20, body: marker, user: { login: "maintainer", type: "User" } },
        { id: 21, body: marker, in_reply_to_id: 10, user: { login: "ternary-review-agent[bot]", type: "Bot" } },
      ]))
      .mockResolvedValueOnce(Response.json({ id: 22 }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-auth", body: `Finding\n\n${marker}`, path: "src/auth.ts" }], { botLogin: "ternary-review-agent[bot]", ...currentHead("head") });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("does not match a spoofed marker before another finding's canonical marker", async () => {
    const spoofed = "<!-- ternary-finding:finding-auth -->\n\n<!-- ternary-finding:finding-other -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 25, body: spoofed, path: "src/auth.ts", subject_type: "file", user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ id: 26 }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head", "token", [{ findingId: "finding-auth", body: "Real\n\n<!-- ternary-finding:finding-auth -->", path: "src/auth.ts" }], { botLogin: "ternary-review-agent[bot]", ...currentHead("head") });

    expect(fetch.mock.calls[2][1]).toMatchObject({ method: "POST" });
  });

  it("resolves an owned finding thread when a clean review no longer reports it", async () => {
    const marker = "<!-- ternary-finding:finding-fixed -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 30, body: marker, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-fixed", isResolved: false, comments: { nodes: [{ databaseId: 30 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ data: { resolveReviewThread: { thread: { id: "thread-fixed", isResolved: true } } } }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "new-head", "token", [], { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1]?.body).toContain("TernaryResolveReviewThread");
  });

  it("keeps a clean review publishable when the app cannot access review threads", async () => {
    const marker = "<!-- ternary-finding:finding-fixed -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 30, body: marker, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({
        data: { repository: { pullRequest: null } },
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(syncFindingReviewComments(
      "ternary",
      "agent",
      8,
      "new-head",
      "token",
      [],
      { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") },
    )).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { errors: [{ type: "INTERNAL", message: "Something went wrong" }] },
    { errors: [
      { type: "FORBIDDEN", message: "Resource not accessible by integration" },
      { type: "INTERNAL", message: "Something went wrong" },
    ] },
  ])("propagates non-permission review-thread errors", async ({ errors }) => {
    const marker = "<!-- ternary-finding:finding-fixed -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 30, body: marker, user: { login: "ternary-review-agent[bot]", type: "Bot" } }]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: null } }, errors }));
    vi.stubGlobal("fetch", fetch);

    await expect(syncFindingReviewComments(
      "ternary",
      "agent",
      8,
      "new-head",
      "token",
      [],
      { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") },
    )).rejects.toThrow("Something went wrong");
  });

  it("resolves only absent findings while updating findings that remain", async () => {
    const activeMarker = "<!-- ternary-finding:finding-active -->";
    const fixedMarker = "<!-- ternary-finding:finding-fixed -->";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([
        { id: 40, body: activeMarker, path: "src/active.ts", subject_type: "file", user: { login: "ternary-review-agent[bot]", type: "Bot" } },
        { id: 41, body: fixedMarker, user: { login: "ternary-review-agent[bot]", type: "Bot" } },
      ]))
      .mockResolvedValueOnce(Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: "thread-active", isResolved: false, comments: { nodes: [{ databaseId: 40 }] } },
        { id: "thread-fixed", isResolved: false, comments: { nodes: [{ databaseId: 41 }] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } } }))
      .mockResolvedValueOnce(Response.json({ data: { resolveReviewThread: { thread: { id: "thread-fixed", isResolved: true } } } }))
      .mockResolvedValueOnce(Response.json({ id: 40 }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "new-head", "token", [{ findingId: "finding-active", body: `Still active\n\n${activeMarker}`, path: "src/active.ts" }], { botLogin: "ternary-review-agent[bot]", ...currentHead("new-head") });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2][1]?.body).toContain("TernaryResolveReviewThread");
    expect(fetch.mock.calls[3][0]).toContain("/pulls/comments/40");
    expect(fetch.mock.calls[3][1]).toMatchObject({ method: "PATCH" });
  });

  it("does not let an obsolete review mutate threads from the current head", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ head: { sha: "head-current" } }));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head-old", "token", [{
      findingId: "finding-old", body: "Old\n\n<!-- ternary-finding:finding-old -->", path: "src/old.ts",
    }]);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops before mutation when the head changes during comment discovery", async () => {
    const getCurrentHead = vi.fn().mockResolvedValueOnce("head-old").mockResolvedValue("head-current");
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetch);

    await syncFindingReviewComments("ternary", "agent", 8, "head-old", "token", [{
      findingId: "finding-old", body: "Old\n\n<!-- ternary-finding:finding-old -->", path: "src/old.ts",
    }], { getCurrentHead });

    expect(fetch).toHaveBeenCalledOnce();
    expect(getCurrentHead).toHaveBeenCalledTimes(2);
  });
});
