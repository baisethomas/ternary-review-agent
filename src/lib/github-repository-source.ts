import { getRepositoryBlob, getRepositoryTree } from "./github";
import type { RepositoryFileDescriptor, RepositoryIndexRequest, RepositorySource } from "./repository-index";
import { NonRetryableReviewError } from "./review-errors";

export class GitHubRepositorySource implements RepositorySource {
  constructor(private readonly token: string) {}

  async listFiles(request: RepositoryIndexRequest) {
    const tree = await getRepositoryTree(request.owner, request.repo, request.commitSha, this.token);
    if (tree.truncated) throw new NonRetryableReviewError(`GitHub returned a truncated tree for ${request.owner}/${request.repo}@${request.commitSha}`);
    return tree.tree
      .filter((entry): entry is typeof entry & { size: number } => entry.type === "blob" && typeof entry.size === "number")
      .map((entry) => ({ path: entry.path, blobSha: entry.sha, size: entry.size }));
  }

  readFile(request: RepositoryIndexRequest, file: RepositoryFileDescriptor) {
    return getRepositoryBlob(request.owner, request.repo, file.blobSha, this.token);
  }
}
