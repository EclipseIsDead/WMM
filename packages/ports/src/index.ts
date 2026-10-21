import type { WorkspaceBaseV1, WorkspaceStateV1, WorkspaceErrorCodeV1 } from "@wmm/wire-contracts";

export interface WorkspaceIntent {
  readonly idempotencyKey: string;
  /** Canonical intent computed by the application; excludes correlation requestId. */
  readonly intent: string;
}
export interface WorkspaceStore {
  create(id: string, intent: WorkspaceIntent, build: () => { readonly state: WorkspaceStateV1; readonly base: WorkspaceBaseV1 }): WorkspaceStateV1;
  read(id: string, atVersion?: number): WorkspaceStateV1;
  readBase(id: string): WorkspaceBaseV1;
  mutate(id: string, expectedVersion: number, intent: WorkspaceIntent, apply: (state: WorkspaceStateV1) => WorkspaceStateV1): WorkspaceStateV1;
  close(): void;
}
export class WorkspaceStoreError extends Error {
  constructor(readonly code: WorkspaceErrorCodeV1 | "STORAGE_FAILURE", message: string) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}
