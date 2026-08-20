// Pure workspace-review collection: capture -> exclusion pipeline -> canonical
// payload -> finalized (capped) bytes + digest.
//
// This module (and everything it imports) is the dry-run/manifest code path:
// it never imports the transmit module or any networking transport, which the
// zero-network module-graph test in zero-network.test.ts asserts structurally
// by walking the graph rooted here. It is shared by main.ts's --dry-run and
// --manifest branches and by submit.ts's pre-transmit summary (spec fixed
// decision 7 / docs/workspace-review-endpoint.md §6).

import { captureWorkspace, loadLocalPolicy, makeContentReaders } from "./capture.js";
import { runExclusionPipeline } from "./deny.js";
import { finalizePayload } from "./payload.js";
import type { FinalizedPayload } from "./payload.js";
import { DEFAULT_CAPS, DENY_RULES_VERSION, SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from "./types.js";
import type { CanonicalPayload, CaptureMode } from "./types.js";

export interface CollectedWorkspaceReview {
  rootAbs: string;
  kind: CanonicalPayload["kind"];
  captureMode: CaptureMode;
  finalized: FinalizedPayload;
  totalSourceBytes: number;
}

export function collectWorkspaceReview(rootAbs: string, mode: CaptureMode): CollectedWorkspaceReview {
  const capture = captureWorkspace(rootAbs, mode);
  const workspaceRootAbs = capture.workspace.rootAbs;
  // Capture resolves the Local Policy while enumerating (root and nested
  // ignore files); loadLocalPolicy is the root-only fallback.
  const policy = capture.policy ?? loadLocalPolicy(workspaceRootAbs, capture.workspace.vcs);
  const readers = makeContentReaders(workspaceRootAbs, capture.workspace);
  const outcome = runExclusionPipeline(capture, policy, DEFAULT_CAPS, readers);

  const payload: CanonicalPayload = {
    schemaVersion: SCHEMA_VERSION,
    kind: capture.kind,
    captureMode: capture.captureMode,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    workspace: {
      label: capture.workspace.label,
      vcs: capture.workspace.vcs,
      ...(capture.kind === "changeset"
        ? {
            baseState: capture.workspace.unborn
              ? ("unborn" as const)
              : { headSha: capture.workspace.headSha as string },
          }
        : {}),
      ...(capture.workspace.branch !== undefined ? { branch: capture.workspace.branch } : {}),
    },
    manifest: outcome.manifest,
    ...(outcome.changeset !== undefined ? { changeset: outcome.changeset } : {}),
    ...(outcome.snapshot !== undefined ? { snapshot: outcome.snapshot } : {}),
    context: [], // bounded context selection lands with the analysis phase (TER-37)
    localPolicy: {
      captureMode: capture.captureMode,
      include: ["**"],
      exclude: policy.excludePatterns,
      denyRulesVersion: DENY_RULES_VERSION,
      caps: DEFAULT_CAPS,
    },
    redaction: outcome.redaction,
  };

  const finalized = finalizePayload(payload, DEFAULT_CAPS);
  return {
    rootAbs: workspaceRootAbs,
    kind: capture.kind,
    captureMode: capture.captureMode,
    finalized,
    totalSourceBytes: outcome.totalSourceBytes,
  };
}
