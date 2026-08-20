import { workspaceAuthEnv } from "@/lib/workspace-review-auth";
import { enterWorkspaceReviewGate, workspaceGateConfigFromEnv } from "@/lib/workspace-review-gate";
import { redisWorkspaceGateStore } from "@/lib/workspace-review-gate-redis";
import { analyzeWorkspaceReviewForRoute, createWorkspaceReviewHandler } from "@/lib/workspace-review-route";

// Platform ceiling; the enforced end-to-end deadline is 120,000 ms
// (docs/workspace-review-endpoint.md §1), leaving headroom so the platform
// never kills a Workspace Review mid-flight.
export const maxDuration = 300;

export const POST = createWorkspaceReviewHandler({
  authEnv: () => workspaceAuthEnv(),
  enterGate: (principalId) =>
    enterWorkspaceReviewGate(redisWorkspaceGateStore(), principalId, workspaceGateConfigFromEnv()),
  analyze: analyzeWorkspaceReviewForRoute,
  // Metadata only — the handler builds the entry; nothing here re-reads the payload.
  log: (entry) => console.log(JSON.stringify(entry)),
});
