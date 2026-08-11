"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { getInstalledRepository, getRepositoryDashboardData } from "@/lib/dashboard-data";
import { PolicyScopeUnavailableError, saveOrganizationPolicySettings, saveRepositoryPolicySettings } from "@/lib/policy-settings-service";
import { getReviewPolicyService } from "@/lib/review-policy-service";
import { InvalidReviewPolicyError, ReviewPolicyVersionConflictError, type ReviewPolicyOverride } from "@/lib/review-policy";

export type PolicyActionState = { error: string | null; saved: boolean };
export const initialPolicyActionState: PolicyActionState = { error: null, saved: false };

function integer(formData: FormData, name: string, allowZero = false) {
  const value = Number(formData.get(name));
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new InvalidReviewPolicyError(`Invalid ${name}.`);
  return value;
}

function policy(formData: FormData) {
  try {
    const value: unknown = JSON.parse(String(formData.get("policy") ?? ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as ReviewPolicyOverride;
  } catch {
    throw new InvalidReviewPolicyError("The policy form could not be read. Refresh and try again.");
  }
}

function errorState(error: unknown): PolicyActionState {
  if (error instanceof InvalidReviewPolicyError || error instanceof ReviewPolicyVersionConflictError || error instanceof PolicyScopeUnavailableError) return { error: error.message, saved: false };
  console.error("Unable to save review policy", error);
  return { error: "The policy could not be saved. Verify GitHub access and try again.", saved: false };
}

function dependencies() { return {
  service: getReviewPolicyService(),
  async installationAvailable(installationId: number) {
    return (await getRepositoryDashboardData()).installations.some((installation) => installation.id === installationId);
  },
  async repositoryAvailable(scope: { installationId: number; owner: string; repo: string }) {
    const installed = await getInstalledRepository(`${scope.owner}/${scope.repo}`);
    return installed?.installation.id === scope.installationId;
  },
}; }

export async function saveOrganizationPolicyAction(_state: PolicyActionState, formData: FormData): Promise<PolicyActionState> {
  if (!await isDashboardAuthenticated()) return { error: "Your session expired. Refresh and sign in again.", saved: false };
  try {
    await saveOrganizationPolicySettings({ installationId: integer(formData, "installationId"), expectedVersion: integer(formData, "expectedVersion", true), policy: policy(formData), actor: process.env.POLICY_ACTOR ?? "dashboard-admin" }, dependencies());
    after(() => announceDashboardChange());
    revalidatePath("/policies");
    return { error: null, saved: true };
  } catch (error) {
    return errorState(error);
  }
}

export async function saveRepositoryPolicyAction(_state: PolicyActionState, formData: FormData): Promise<PolicyActionState> {
  if (!await isDashboardAuthenticated()) return { error: "Your session expired. Refresh and sign in again.", saved: false };
  try {
    await saveRepositoryPolicySettings({
      installationId: integer(formData, "installationId"), expectedVersion: integer(formData, "expectedVersion", true),
      owner: String(formData.get("owner") ?? ""), repo: String(formData.get("repo") ?? ""), policy: policy(formData), actor: process.env.POLICY_ACTOR ?? "dashboard-admin",
    }, dependencies());
    after(() => announceDashboardChange());
    revalidatePath("/policies");
    return { error: null, saved: true };
  } catch (error) {
    return errorState(error);
  }
}
