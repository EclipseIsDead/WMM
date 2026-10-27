import type { WorkspaceActionV1, WorkspaceEconomyView, WorkspaceMapView, WorkspaceViewV1 } from "@wmm/wire-contracts";

/** Application calls and an optional trusted host editor capability. */
export interface WorkspaceClient {
  read(atVersion?: number): WorkspaceViewV1;
  /** Bounded captured-base reference atlas read; absent on older gateways. */
  readMap?(options?: { readonly atlasId?: string; readonly geometryVersion?: string; readonly atVersion?: number }): WorkspaceMapView;
  /** Complete captured-base DM declarations; absent on older gateways. */
  readEconomy?(options?: { readonly atVersion?: number }): WorkspaceEconomyView;
  mutate(action: WorkspaceActionV1, expectedVersion: number, idempotencyKey: string): WorkspaceViewV1;
  /** Explicit combined-candidate build/check; absent on older gateways. */
  review?(expectedVersion: number): WorkspaceViewV1;
  /** Optional trusted host editor. Called only while Ink has released the terminal. */
  editText?(text: string): string;
}
