import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresReviewPolicyStore } from "./postgres-review-policy-store";
import { ReviewPolicyService, safeReviewPolicy } from "./review-policy";

let service: ReviewPolicyService | null = null;

export function getReviewPolicyService() {
  if (service) return service;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for review policies");
  service = new ReviewPolicyService(
    new PostgresReviewPolicyStore(neon(connectionString)),
    undefined,
    undefined,
    { ...safeReviewPolicy, model: process.env.OPENROUTER_MODEL ?? safeReviewPolicy.model },
  );
  return service;
}

export function resolveReviewPolicyFor(scope: { installationId: number; owner: string; repo: string }) {
  return getReviewPolicyService().resolve(scope);
}

export function deleteRepositoryReviewPolicies(scope: { installationId: number; owner: string; repo: string }) {
  return getReviewPolicyService().deleteRepository(scope);
}

export function deleteInstallationReviewPolicies(installationId: number) {
  return getReviewPolicyService().deleteInstallation(installationId);
}
