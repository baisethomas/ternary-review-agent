export type RepositoryScope = {
  installationId: number;
  owner: string;
  repo: string;
};

export type RepositoryIndexRequest = RepositoryScope & {
  commitSha: string;
};

export type RepositoryFileDescriptor = { path: string; blobSha: string; size: number };

export type RepositoryIndexChunk = {
  path: string;
  startLine: number;
  endLine: number;
  symbols: string[];
  content: string;
};

export type RepositoryIndexFile = RepositoryFileDescriptor & { chunks: RepositoryIndexChunk[] };

export type RepositoryIndexSnapshot = RepositoryIndexRequest & {
  indexedAt: number;
  files: RepositoryIndexFile[];
};

export class RepositoryAccessRevokedError extends Error {
  constructor(scope: RepositoryScope) {
    super(`Repository access was revoked for ${scope.installationId}:${scope.owner}/${scope.repo}`);
    this.name = "RepositoryAccessRevokedError";
  }
}

export interface RepositoryIndexStore {
  get(request: RepositoryIndexRequest): Promise<RepositoryIndexSnapshot | null>;
  getLatest(request: RepositoryScope): Promise<RepositoryIndexSnapshot | null>;
  put(snapshot: RepositoryIndexSnapshot, deadlineAt?: number): Promise<"stored" | "revoked" | "deadlineExceeded">;
  deleteRepository(request: RepositoryScope, changedAt?: number, forceAuthoritativeRevocation?: boolean): Promise<number | null>;
  deleteInstallation(installationId: number, changedAt?: number, forceAuthoritativeRevocation?: boolean): Promise<number | null>;
  restoreRepositoryAccess(request: RepositoryScope, changedAt?: number, forceAuthoritativeRestoration?: boolean): Promise<number | null>;
  restoreInstallationAccess(installationId: number, changedAt?: number, forceAuthoritativeRestoration?: boolean): Promise<number | null>;
}

export interface RepositorySource {
  listFiles(request: RepositoryIndexRequest): Promise<RepositoryFileDescriptor[]>;
  readFile(request: RepositoryIndexRequest, file: RepositoryFileDescriptor): Promise<string>;
}

type RepositoryIndexBudgets = {
  maxFiles: number;
  maxFileBytes: number;
  chunkLines: number;
  chunkOverlapLines: number;
  maxContextChunks: number;
  maxContextChars: number;
  fileReadConcurrency: number;
  maxSourceBytes: number;
  maxChunks: number;
};

const defaultBudgets: RepositoryIndexBudgets = {
  maxFiles: 500,
  maxFileBytes: 200_000,
  chunkLines: 120,
  chunkOverlapLines: 20,
  maxContextChunks: 8,
  maxContextChars: 20_000,
  fileReadConcurrency: 8,
  maxSourceBytes: 400_000,
  maxChunks: 500,
};

const sourceExtension = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|sh|sql|ya?ml|json|toml|md)$/i;
const symbolPattern = /\b(?:class|interface|type|enum|function|def|func|const|let|var|export\s+function|export\s+class)\s+([A-Za-z_$][\w$]*)/g;
const ignoredTokens = new Set(["const", "function", "return", "export", "import", "from", "class", "interface", "this", "that", "with", "into"]);

function repositoryScope(request: RepositoryScope) {
  return `${request.installationId}:${request.owner.toLowerCase()}/${request.repo.toLowerCase()}`;
}

function tokenize(value: string) {
  return new Set(value.toLowerCase().match(/[a-z_$][a-z0-9_$]{2,}/g)?.filter((token) => !ignoredTokens.has(token)) ?? []);
}

function symbols(content: string) {
  return [...content.matchAll(symbolPattern)].map((match) => match[1]);
}

function chunkFile(file: RepositoryFileDescriptor, content: string, budgets: RepositoryIndexBudgets): RepositoryIndexFile {
  const lines = content.split("\n");
  const chunks: RepositoryIndexChunk[] = [];
  const step = Math.max(1, budgets.chunkLines - budgets.chunkOverlapLines);
  for (let start = 0; start < lines.length; start += step) {
    const chunkLines = lines.slice(start, start + budgets.chunkLines);
    if (!chunkLines.length) break;
    const chunkContent = chunkLines.join("\n");
    chunks.push({ path: file.path, startLine: start + 1, endLine: start + chunkLines.length, symbols: symbols(chunkContent), content: chunkContent });
    if (start + budgets.chunkLines >= lines.length) break;
  }
  return { ...file, chunks };
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, transform: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await transform(values[index]);
    }
  }));
  return results;
}

export class InMemoryRepositoryIndexStore implements RepositoryIndexStore {
  private readonly snapshots = new Map<string, Map<string, RepositoryIndexSnapshot>>();
  private readonly latest = new Map<string, string>();
  private readonly revokedRepositories = new Set<string>();
  private readonly repositoryAccessChangedAt = new Map<string, number>();
  private readonly installationAccess = new Map<number, { revoked: boolean; changedAt: number }>();

  async get(request: RepositoryIndexRequest) {
    return structuredClone(this.snapshots.get(repositoryScope(request))?.get(request.commitSha) ?? null);
  }

  async getLatest(request: RepositoryScope) {
    const scope = repositoryScope(request);
    const commitSha = this.latest.get(scope);
    return structuredClone(commitSha ? this.snapshots.get(scope)?.get(commitSha) ?? null : null);
  }

  async put(snapshot: RepositoryIndexSnapshot, deadlineAt = Infinity) {
    const scope = repositoryScope(snapshot);
    if (Date.now() > deadlineAt) return "deadlineExceeded" as const;
    if (this.installationAccess.get(snapshot.installationId)?.revoked || this.revokedRepositories.has(scope)) return "revoked" as const;
    const commits = this.snapshots.get(scope) ?? new Map<string, RepositoryIndexSnapshot>();
    commits.set(snapshot.commitSha, structuredClone(snapshot));
    this.snapshots.set(scope, commits);
    this.latest.set(scope, snapshot.commitSha);
    return "stored" as const;
  }

  async deleteRepository(request: RepositoryScope, changedAt = Date.now(), forceAuthoritativeRevocation = false) {
    const scope = repositoryScope(request);
    const currentAt = this.repositoryAccessChangedAt.get(scope) ?? -1;
    const active = !this.revokedRepositories.has(scope);
    if ((currentAt > changedAt && !(forceAuthoritativeRevocation && active)) || (!forceAuthoritativeRevocation && currentAt === changedAt && active)) return null;
    const effectiveAt = Math.max(currentAt, changedAt);
    this.repositoryAccessChangedAt.set(scope, effectiveAt);
    this.revokedRepositories.add(scope);
    this.snapshots.delete(scope);
    this.latest.delete(scope);
    return effectiveAt;
  }

  async deleteInstallation(installationId: number, changedAt = Date.now(), forceAuthoritativeRevocation = false) {
    const current = this.installationAccess.get(installationId);
    if (current && ((current.changedAt > changedAt && !(forceAuthoritativeRevocation && !current.revoked)) || (!forceAuthoritativeRevocation && current.changedAt === changedAt && !current.revoked))) return null;
    const effectiveAt = Math.max(current?.changedAt ?? -1, changedAt);
    this.installationAccess.set(installationId, { revoked: true, changedAt: effectiveAt });
    for (const [scope] of this.snapshots) if (scope.startsWith(`${installationId}:`)) this.snapshots.delete(scope);
    for (const [scope] of this.latest) if (scope.startsWith(`${installationId}:`)) this.latest.delete(scope);
    return effectiveAt;
  }

  async restoreRepositoryAccess(request: RepositoryScope, changedAt = Date.now(), forceAuthoritativeRestoration = false) {
    if (this.installationAccess.get(request.installationId)?.revoked) return null;
    const scope = repositoryScope(request);
    const currentAt = this.repositoryAccessChangedAt.get(scope) ?? -1;
    const revoked = this.revokedRepositories.has(scope);
    if (currentAt > changedAt && !(forceAuthoritativeRestoration && revoked)) return revoked ? null : currentAt;
    const effectiveAt = Math.max(currentAt, changedAt);
    this.repositoryAccessChangedAt.set(scope, effectiveAt);
    this.revokedRepositories.delete(scope);
    return effectiveAt;
  }

  async restoreInstallationAccess(installationId: number, changedAt = Date.now(), forceAuthoritativeRestoration = false) {
    const current = this.installationAccess.get(installationId);
    if (current && current.changedAt > changedAt && !(forceAuthoritativeRestoration && current.revoked)) return current.revoked ? null : current.changedAt;
    const effectiveAt = Math.max(current?.changedAt ?? -1, changedAt);
    this.installationAccess.set(installationId, { revoked: false, changedAt: effectiveAt });
    return effectiveAt;
  }
}

export class RepositoryIndexer {
  private readonly store: RepositoryIndexStore;
  private readonly source: RepositorySource;
  private readonly budgets: RepositoryIndexBudgets;

  constructor(store: RepositoryIndexStore, source: RepositorySource, budgets: Partial<RepositoryIndexBudgets> = {}) {
    this.store = store;
    this.source = source;
    this.budgets = { ...defaultBudgets, ...budgets };
  }

  async update(request: RepositoryIndexRequest, deadlineAt = Infinity) {
    const assertWithinDeadline = () => {
      if (Date.now() > deadlineAt) throw new Error(`Repository indexing deadline exceeded for ${request.owner}/${request.repo}@${request.commitSha}`);
    };
    assertWithinDeadline();
    const [descriptors, previous] = await Promise.all([this.source.listFiles(request), this.store.getLatest(request)]);
    assertWithinDeadline();
    const reusable = new Map(previous?.files.map((file) => [`${file.path}:${file.blobSha}`, file]) ?? []);
    const candidates = descriptors
      .filter((file) => sourceExtension.test(file.path) && file.size <= this.budgets.maxFileBytes)
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, this.budgets.maxFiles);
    let selectedBytes = 0;
    const selected = candidates.filter((file) => {
      if (selectedBytes + file.size > this.budgets.maxSourceBytes) return false;
      selectedBytes += file.size;
      return true;
    });
    const files = await mapWithConcurrency(selected, this.budgets.fileReadConcurrency, async (file) => {
      assertWithinDeadline();
      const existing = reusable.get(`${file.path}:${file.blobSha}`);
      if (existing) return existing;
      const content = await this.source.readFile(request, file);
      assertWithinDeadline();
      return chunkFile(file, content, this.budgets);
    });
    let chunkCount = 0;
    const boundedFiles = files.map((file) => {
      const chunks = file.chunks.slice(0, Math.max(0, this.budgets.maxChunks - chunkCount));
      chunkCount += chunks.length;
      return { ...file, chunks };
    }).filter((file) => file.chunks.length > 0);
    const snapshot: RepositoryIndexSnapshot = { ...request, indexedAt: Date.now(), files: boundedFiles };
    assertWithinDeadline();
    const stored = await this.store.put(snapshot, deadlineAt);
    if (stored === "revoked") throw new RepositoryAccessRevokedError(request);
    if (stored === "deadlineExceeded") throw new Error(`Repository indexing deadline exceeded for ${request.owner}/${request.repo}@${request.commitSha}`);
    return snapshot;
  }

  async retrieve(request: RepositoryIndexRequest, query: string) {
    const snapshot = await this.store.get(request);
    if (!snapshot) {
      const latest = await this.store.getLatest(request);
      return latest
        ? { status: "stale" as const, chunks: [], text: "", indexedCommitSha: latest.commitSha }
        : { status: "missing" as const, chunks: [], text: "", indexedCommitSha: null };
    }
    const queryTokens = tokenize(query);
    const ranked = snapshot.files.flatMap((file) => file.chunks).map((chunk) => {
      const contentTokens = tokenize(`${chunk.path} ${chunk.symbols.join(" ")} ${chunk.content}`);
      let score = 0;
      for (const token of queryTokens) if (contentTokens.has(token)) score += chunk.symbols.some((symbol) => symbol.toLowerCase() === token) ? 4 : 1;
      return { chunk, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));

    const chunks: RepositoryIndexChunk[] = [];
    let text = "";
    for (const { chunk } of ranked) {
      if (chunks.length >= this.budgets.maxContextChunks) break;
      const header = `### ${chunk.path}:${chunk.startLine}-${chunk.endLine}${chunk.symbols.length ? ` [${chunk.symbols.join(", ")}]` : ""}\n`;
      const remaining = this.budgets.maxContextChars - text.length;
      if (remaining <= header.length) break;
      const excerpt = `${header}${chunk.content}\n`;
      text += excerpt.slice(0, remaining);
      chunks.push(chunk);
      if (text.length >= this.budgets.maxContextChars) break;
    }
    return { status: "fresh" as const, chunks, text, indexedCommitSha: snapshot.commitSha };
  }
}
