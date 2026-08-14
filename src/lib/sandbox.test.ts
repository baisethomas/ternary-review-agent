import { describe, expect, it } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import { sandboxCommandPlan, sandboxCredentials } from "./sandbox";

describe("sandbox credentials", () => {
  it("uses Vercel's built-in identity when only the automatic project ID is present", () => {
    expect(sandboxCredentials({ VERCEL_PROJECT_ID: "project" })).toEqual({});
  });

  it("uses a complete explicit Vercel credential set", () => {
    expect(sandboxCredentials({ VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" })).toEqual({
      token: "token",
      teamId: "team",
      projectId: "project",
    });
  });

  it("rejects an incomplete explicit Vercel credential set", () => {
    expect(() => sandboxCredentials({ VERCEL_TOKEN: "token", VERCEL_PROJECT_ID: "project" })).toThrow(NonRetryableReviewError);
  });
});

describe("sandbox review policy", () => {
  it("keeps dependency installation and replaces default checks with configured review commands", () => {
    expect(sandboxCommandPlan(["npm run test:unit", "npm run lint:strict"]).map((step) => ({ label: step.label, shell: step.shell }))).toEqual([
      { label: "install dependencies", shell: expect.stringContaining("npm ci") },
      { label: "npm run test:unit", shell: "npm run test:unit" },
      { label: "npm run lint:strict", shell: "npm run lint:strict" },
    ]);
  });

  it("can omit build when skipBuild is enabled", () => {
    expect(sandboxCommandPlan([], { skipBuild: true }).map((step) => step.label)).toEqual([
      "install dependencies",
      "lint",
      "typecheck",
      "test",
    ]);
  });
});
