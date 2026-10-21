import type { WorkspaceActionV1, WorkspaceViewV1 } from "@wmm/wire-contracts";

/** Application calls and an optional trusted host editor capability. */
export interface WorkspaceClient {
  read(atVersion?: number): WorkspaceViewV1;
  mutate(action: WorkspaceActionV1, expectedVersion: number, idempotencyKey: string): WorkspaceViewV1;
  /** Optional trusted host editor. Called only while Ink has released the terminal. */
  editText?(text: string): string;
}
