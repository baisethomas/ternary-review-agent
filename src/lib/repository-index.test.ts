import { describe, expect, it } from "vitest";
import { InMemoryRepositoryIndexStore, RepositoryIndexer, type RepositorySource } from "./repository-index";

function source(files: Record<string, { sha: string; content: string }>) {
  const reads: string[] = [];
  const repositorySource: RepositorySource = {
    async listFiles() { return Object.entries(files).map(([path, file]) => ({ path, blobSha: file.sha, size: file.content.length })); },
    async readFile(_request, file) { reads.push(file.path); return files[file.path].content; },
  };
  return { repositorySource, reads };
}

const request = { installationId: 7, owner: "ternary", repo: "agent", commitSha: "commit-a" };

describe("RepositoryIndexer", () => {
  it("indexes files, chunks, symbols, and explainable source locations", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const fixture = source({
      "src/auth.ts": { sha: "blob-auth", content: "export function authorize(user: User) {\n  return user.isAdmin;\n}" },
      "src/route.ts": { sha: "blob-route", content: "import { authorize } from './auth';\nexport function POST(user: User) { return authorize(user); }" },
    });
    const indexer = new RepositoryIndexer(store, fixture.repositorySource);

    const snapshot = await indexer.update(request);
    const context = await indexer.retrieve(request, "POST authorize admin");

    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.flatMap((file) => file.chunks).flatMap((chunk) => chunk.symbols)).toEqual(expect.arrayContaining(["authorize", "POST"]));
    expect(context.chunks.map((chunk) => chunk.path)).toEqual(expect.arrayContaining(["src/auth.ts", "src/route.ts"]));
    expect(context.chunks[0]).toMatchObject({ path: expect.any(String), startLine: 1, endLine: expect.any(Number), symbols: expect.any(Array) });
    expect(context.text).toContain("src/");
  });

  it("fetches only changed blobs during an incremental update and removes deleted files", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const first = source({ "a.ts": { sha: "a1", content: "export const a = 1" }, "deleted.ts": { sha: "d1", content: "old" } });
    await new RepositoryIndexer(store, first.repositorySource).update(request);
    const second = source({ "a.ts": { sha: "a1", content: "export const a = 1" }, "b.ts": { sha: "b1", content: "export const b = 2" } });

    const snapshot = await new RepositoryIndexer(store, second.repositorySource).update({ ...request, commitSha: "commit-b" });

    expect(second.reads).toEqual(["b.ts"]);
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("rejects stale commits and isolates repositories and installations", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const fixture = source({ "secret.ts": { sha: "s1", content: "export const privateSecret = true" } });
    const indexer = new RepositoryIndexer(store, fixture.repositorySource);
    await indexer.update(request);

    await expect(indexer.retrieve({ ...request, commitSha: "other" }, "privateSecret")).resolves.toMatchObject({ status: "stale", chunks: [] });
    await expect(indexer.retrieve({ ...request, repo: "other" }, "privateSecret")).resolves.toMatchObject({ status: "missing", chunks: [] });
    await expect(indexer.retrieve({ ...request, installationId: 8 }, "privateSecret")).resolves.toMatchObject({ status: "missing", chunks: [] });
  });

  it("retains commit-addressed snapshots for simultaneous pull requests", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const first = source({ "first.ts": { sha: "first", content: "export const firstCommitOnly = true" } });
    const second = source({ "second.ts": { sha: "second", content: "export const secondCommitOnly = true" } });
    await new RepositoryIndexer(store, first.repositorySource).update(request);
    await new RepositoryIndexer(store, second.repositorySource).update({ ...request, commitSha: "commit-b" });

    await expect(new RepositoryIndexer(store, first.repositorySource).retrieve(request, "firstCommitOnly")).resolves.toMatchObject({ status: "fresh", indexedCommitSha: "commit-a" });
    await expect(new RepositoryIndexer(store, second.repositorySource).retrieve({ ...request, commitSha: "commit-b" }, "secondCommitOnly")).resolves.toMatchObject({ status: "fresh", indexedCommitSha: "commit-b" });
  });

  it("deletes repository and installation data when access is revoked", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const fixture = source({ "a.ts": { sha: "a1", content: "export const a = 1" } });
    const indexer = new RepositoryIndexer(store, fixture.repositorySource);
    await indexer.update(request);
    await indexer.update({ ...request, repo: "second" });

    await store.deleteRepository(request);
    await expect(indexer.retrieve(request, "a")).resolves.toMatchObject({ status: "missing" });
    await store.deleteInstallation(request.installationId);
    await expect(indexer.retrieve({ ...request, repo: "second" }, "a")).resolves.toMatchObject({ status: "missing" });
  });

  it("does not resurrect an index when access is revoked during ingestion", async () => {
    const store = new InMemoryRepositoryIndexStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const repositorySource: RepositorySource = {
      async listFiles() { return [{ path: "secret.ts", blobSha: "secret", size: 20 }]; },
      async readFile() { await blocked; return "export const secret = 1"; },
    };
    const indexer = new RepositoryIndexer(store, repositorySource);
    const update = indexer.update(request);
    await Promise.resolve();
    await store.deleteRepository(request);
    release();

    await expect(update).rejects.toThrow("access was revoked");
    await expect(store.getLatest(request)).resolves.toBeNull();
  });

  it("enforces retrieval count and context-character budgets", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`file-${index}.ts`, { sha: `sha-${index}`, content: `export function shared${index}() { return 'shared token ${"x".repeat(2_000)}'; }` }]));
    const fixture = source(files);
    const indexer = new RepositoryIndexer(store, fixture.repositorySource, { maxContextChunks: 4, maxContextChars: 3_000, maxChunks: 6 });
    await indexer.update(request);

    const context = await indexer.retrieve(request, "shared token");
    const snapshot = await store.get(request);
    expect(snapshot!.files.flatMap((file) => file.chunks)).toHaveLength(6);
    expect(context.chunks.length).toBeLessThanOrEqual(4);
    expect(context.text.length).toBeLessThanOrEqual(3_000);
  });

  it("bounds total indexed source bytes and prevents late writes after the deadline", async () => {
    const store = new InMemoryRepositoryIndexStore();
    const fixture = source({
      "a.ts": { sha: "a", content: "a".repeat(80) },
      "b.ts": { sha: "b", content: "b".repeat(80) },
    });
    const indexer = new RepositoryIndexer(store, fixture.repositorySource, { maxSourceBytes: 100 });
    const snapshot = await indexer.update(request);
    expect(snapshot.files).toHaveLength(1);
    expect(fixture.reads).toHaveLength(1);

    class SlowStore extends InMemoryRepositoryIndexStore {
      override async put(snapshot: Parameters<InMemoryRepositoryIndexStore["put"]>[0], deadlineAt?: number) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return super.put(snapshot, deadlineAt);
      }
    }
    const lateStore = new SlowStore();
    const lateSource: RepositorySource = {
      async listFiles() { return [{ path: "late.ts", blobSha: "late", size: 10 }]; },
      async readFile() { return "late write"; },
    };
    await expect(new RepositoryIndexer(lateStore, lateSource).update(request, Date.now() + 1)).rejects.toThrow("deadline exceeded");
    await expect(lateStore.getLatest(request)).resolves.toBeNull();
  });
});
