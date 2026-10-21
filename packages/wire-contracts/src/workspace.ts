import type { AssertionRecordV1, SnapshotRecordV1, WorldExportV1 } from "./types.js";

/** U1/U2 draft operations are explicit data, never interpreted narrative instructions. */
export type WorkspaceOperationV1 =
  | { readonly kind: "write-prose"; readonly path: string; readonly text: string; readonly beforeSha256: string | null }
  | { readonly kind: "activate-assertion"; readonly assertion: AssertionRecordV1 }
  | { readonly kind: "deactivate-assertion"; readonly assertionId: string };

export interface ProposalGroupV1 {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly author: string;
  readonly rationale: string;
  readonly dependencies: readonly string[];
  readonly exclusions: readonly string[];
  readonly operations: readonly WorkspaceOperationV1[];
  readonly decision: "undecided" | "selected" | "rejected";
  readonly rejectionReason: string | null;
}
export type WorkspacePinV1 =
  | { readonly id: string; readonly kind: "document"; readonly path: string; readonly sha256: string; readonly active: boolean }
  | { readonly id: string; readonly kind: "assertion"; readonly assertionId: string; readonly active: boolean };

export type WorkspaceActionV1 =
  | { readonly kind: "decide"; readonly groupId: string; readonly decision: "selected" | "undecided" | "rejected"; readonly reason?: string }
  | { readonly kind: "select"; readonly groupIds: readonly string[] }
  | { readonly kind: "put-proposal"; readonly proposal: Omit<ProposalGroupV1, "version" | "decision" | "rejectionReason"> }
  | { readonly kind: "set-direction"; readonly text: string }
  | { readonly kind: "put-pin"; readonly pin: WorkspacePinV1 }
  | { readonly kind: "add-regency"; readonly title: string; readonly rationale: string };

export interface WorkspaceDecisionV1 {
  readonly version: number;
  readonly action: WorkspaceActionV1;
}
export interface WorkspaceStateV1 {
  readonly format: "wmm.workspace/1";
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly worldTitle: string;
  readonly goal: string;
  readonly mode: "world" | "succession-demo";
  readonly base: { readonly worldId: string; readonly snapshotDigest: string };
  readonly proposals: readonly ProposalGroupV1[];
  readonly pins: readonly WorkspacePinV1[];
  readonly direction: string;
  readonly history: readonly WorkspaceDecisionV1[];
}

/** Adapter-verified content, durably captured once; never sent as a client authority. */
export interface WorkspaceBaseV1 {
  readonly snapshot: SnapshotRecordV1;
  readonly world: WorldExportV1;
  readonly documents: readonly {
    readonly path: string; readonly mediaType: string; readonly sha256: string; readonly base64: string;
  }[];
}
export interface WorkspaceSelectionV1 {
  readonly requested: readonly string[];
  readonly required: readonly string[];
  readonly missing: readonly string[];
  readonly rejectedRequired: readonly string[];
  readonly diagnostics: readonly { readonly code: string; readonly groupIds: readonly string[]; readonly message: string }[];
}
export interface WorkspaceViewV1 {
  readonly format: "wmm.workspace-view/1";
  readonly workspace: WorkspaceStateV1;
  readonly records: readonly { readonly id: string; readonly kind: string; readonly title: string; readonly summary: string }[];
  readonly documents: readonly { readonly path: string; readonly text: string; readonly truncated: boolean; readonly sha256?: string }[];
  readonly changes: readonly {
    readonly groupId: string;
    readonly representation: "explicit-prose" | "explicit-claims" | "mixed";
    readonly before: readonly string[];
    readonly proposed: readonly string[];
  }[];
  readonly prerequisites: readonly { readonly groupId: string; readonly required: readonly string[]; readonly missing: readonly string[]; readonly rejected: readonly string[] }[];
  readonly selection: WorkspaceSelectionV1;
  readonly validation: { readonly status: "not-run"; readonly message: string };
  readonly approval: "unavailable";
  readonly canon: "unchanged";
}
export type WorkspaceRequestV1 = {
  readonly format: "wmm.request/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string;
} & (
  | { readonly operation: "workspace.create"; readonly payload: {
      readonly workspaceId: string; readonly bundlePath: string; readonly title: string;
      readonly goal: string; readonly mode: "world" | "succession-demo"; readonly idempotencyKey: string;
    } }
  | { readonly operation: "workspace.read"; readonly payload: { readonly workspaceId: string; readonly atVersion?: number } }
  | { readonly operation: "workspace.mutate"; readonly payload: {
      readonly workspaceId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly action: WorkspaceActionV1;
    } }
);
export type WorkspaceErrorCodeV1 = "STALE_WORKSPACE" | "IDEMPOTENCY_CONFLICT" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_EXISTS" | "INVALID_WORKSPACE_ACTION";
