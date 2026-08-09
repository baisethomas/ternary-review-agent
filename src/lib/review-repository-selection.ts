export type ReviewRepositoryChoice = {
  fullName: string;
  watched: boolean;
};

export function selectReviewRepositories<T extends ReviewRepositoryChoice>(repositories: readonly T[], requestedRepository?: string) {
  const watchedRepositories = repositories.filter((repository) => repository.watched);
  const selectedRepository = watchedRepositories.find((repository) => repository.fullName === requestedRepository) ?? watchedRepositories[0] ?? null;
  return { repositories: watchedRepositories, selectedRepository };
}
