import type { AssertionRecordV1, ClaimBodyV1, SnapshotRecordV1, WorldExportV1 } from "./types.js";

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
  readonly validation: { readonly status: "not-run" | "current" | "stale"; readonly message: string };
  readonly review?: WorkspaceReviewV1;
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
  | { readonly operation: "workspace.review"; readonly payload: { readonly workspaceId: string; readonly expectedVersion: number; readonly limits?: Partial<WorkspaceReviewLimitsV1> } }
  | { readonly operation: "workspace.mutate"; readonly payload: {
      readonly workspaceId: string; readonly expectedVersion: number; readonly idempotencyKey: string; readonly action: WorkspaceActionV1;
    } }
);
export interface WorkspaceReviewLimitsV1 { readonly maxWorkUnits: number }
export interface WorkspaceReviewBindingV1 {
  readonly worldId: string;
  readonly workspaceId: string;
  readonly workspaceVersion: number;
  readonly baseSnapshotDigest: string;
  readonly semanticProfileDigest: string;
  readonly evaluator: "bundled-workspace-review-v1";
  readonly selectedGroups: readonly { readonly id: string; readonly version: number }[];
  readonly operationsDigest: string;
  readonly steeringDigest: string;
}
export interface WorkspaceReviewDiagnosticV1 {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly groupIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly message: string;
}
export interface WorkspaceReviewDiffV1 {
  readonly documents: readonly {
    readonly path: string;
    readonly kind: "added" | "modified";
    readonly beforeSha256: string | null;
    readonly afterSha256: string;
    readonly before: string | null;
    readonly after: string;
    readonly truncated: boolean;
    readonly groupIds: readonly string[];
  }[];
  readonly assertions: readonly {
    readonly id: string;
    readonly kind: "activated" | "deactivated";
    readonly body: ClaimBodyV1;
    readonly groupIds: readonly string[];
  }[];
}
export interface WorkspaceReviewBodyV1 {
  readonly format: "wmm.workspace-review/1";
  readonly binding: WorkspaceReviewBindingV1;
  readonly candidateDigest: string;
  readonly candidateSnapshotDigest: string | null;
  readonly limits: WorkspaceReviewLimitsV1;
  readonly execution: "completed";
  readonly validity: "valid" | "invalid" | "undetermined";
  readonly checks: readonly {
    readonly id: "selection" | "operations" | "references" | "pins" | "explicit-opposition";
    readonly status: "passed" | "failed" | "blocked" | "unresolved";
  }[];
  readonly diff: WorkspaceReviewDiffV1;
  readonly diagnostics: readonly WorkspaceReviewDiagnosticV1[];
  readonly limitations: readonly string[];
}
export interface WorkspaceReviewV1 extends WorkspaceReviewBodyV1 { readonly evaluationDigest: string }

export type WorkspaceErrorCodeV1 = "STALE_WORKSPACE" | "IDEMPOTENCY_CONFLICT" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_EXISTS" | "INVALID_WORKSPACE_ACTION";
