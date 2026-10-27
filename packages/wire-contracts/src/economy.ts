import type { AuthoringCitation, AuthoringContext, AuthoringSource } from "./authoring.js";
import type { AssertionId, DigestHex, ScopeV1 } from "./types.js";
import type { Quantity } from "./measurement.js";

export const MAX_ECONOMIC_RECORDS = 64;
export const MAX_ECONOMY_VIEW_BYTES = 1024 * 1024;
export interface WorkspaceEconomyReadRequest {
  readonly format: "wmm.request/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string;
  readonly operation: "workspace.economy.read";
  readonly payload: { readonly workspaceId: string; readonly atVersion?: number };
}

export type EconomicRole = { readonly kind: "declared"; readonly entityId: string } | { readonly kind: "unknown" };
export type EconomicDeclaration = { readonly kind: "declared"; readonly description: string } | { readonly kind: "unknown" };
export type EconomicBoundary = { readonly kind: "declared"; readonly description: string; readonly entityIds: readonly string[] } | { readonly kind: "unknown" };
export type UnmappedEconomicReference = { readonly kind: "unmapped"; readonly label: string } | { readonly kind: "unknown" };
export type AuthoringEconomicPoint = { readonly kind: "mapped"; readonly axisKey: string; readonly position: string } | UnmappedEconomicReference;
export type EconomicPoint = { readonly kind: "mapped"; readonly axisDefinitionDigest: DigestHex; readonly position: string } | UnmappedEconomicReference;
export type AuthoringEconomicPeriod = { readonly kind: "mapped"; readonly axisKey: string; readonly start: string; readonly endExclusive: string } | UnmappedEconomicReference;
export type EconomicPeriod = { readonly kind: "mapped"; readonly axisDefinitionDigest: DigestHex; readonly start: string; readonly endExclusive: string } | UnmappedEconomicReference;
export interface EconomicCommonValue {
  /** Report identity, not the resource identity. Equal reports remain distinct. */
  readonly id: string;
  readonly resourceId: string;
  readonly quantity: Quantity;
  readonly description: string;
  readonly method: EconomicDeclaration;
  readonly boundary: EconomicBoundary;
  readonly coverage: { readonly kind: "partial" | "complete-as-declared" | "unknown"; readonly description: string };
  readonly citations: readonly AuthoringCitation[];
}
export interface StockObservationValue extends EconomicCommonValue {
  readonly kind: "stock-observation";
  readonly status: "observed" | "reported-estimate";
  readonly owner: EconomicRole;
  readonly custodian: EconomicRole;
  readonly location: EconomicRole;
  readonly availableUse: EconomicDeclaration;
  readonly reference: EconomicPoint;
}
export interface DeliveryCommitmentValue extends EconomicCommonValue {
  readonly kind: "delivery-commitment";
  readonly promisor: EconomicRole;
  readonly recipient: EconomicRole;
  readonly destination: EconomicRole;
  readonly timing: { readonly kind: "future-as-authored"; readonly relativeTo: EconomicPoint };
  readonly reference: EconomicPeriod;
}
export interface PlannedRequirementValue extends EconomicCommonValue {
  readonly kind: "planned-requirement";
  readonly planner: EconomicRole;
  readonly beneficiary: EconomicRole;
  readonly purpose: string;
  readonly reference: EconomicPeriod;
}
export type EconomicRecordValue = StockObservationValue | DeliveryCommitmentValue | PlannedRequirementValue;
interface AuthoringEconomicClaim {
  readonly subjectId: string;
  readonly context: AuthoringContext;
  readonly applicability: { readonly kind: "invariant" };
}
export type AuthoringEconomicRecord = AuthoringEconomicClaim & (
  | (Omit<StockObservationValue, "reference"> & { readonly reference: AuthoringEconomicPoint })
  | (Omit<DeliveryCommitmentValue, "reference" | "timing"> & { readonly reference: AuthoringEconomicPeriod; readonly timing: { readonly kind: "future-as-authored"; readonly relativeTo: AuthoringEconomicPoint } })
  | (Omit<PlannedRequirementValue, "reference"> & { readonly reference: AuthoringEconomicPeriod })
);
export interface AuthoringEconomy {
  readonly format: "wmm.authoring-economy/1";
  readonly records: readonly AuthoringEconomicRecord[];
}
/** Complete DM-side authored declarations; no accounting, execution or actor knowledge. */
export interface EconomyView {
  readonly format: "wmm.economy-view/1";
  readonly worldId: string;
  readonly snapshotDigest: DigestHex;
  readonly semanticProfileDigest: DigestHex;
  readonly inputDigest: DigestHex;
  readonly perspective: "dm";
  readonly accounting: "not-run";
  readonly scenarios: "not-run";
  readonly records: readonly { readonly assertionId: AssertionId; readonly subjectId: string; readonly scope: ScopeV1; readonly value: EconomicRecordValue }[];
  readonly entities: readonly { readonly id: string; readonly name: string }[];
  readonly sources: readonly AuthoringSource[];
  readonly axes: readonly { readonly definitionDigest: DigestHex; readonly key: string }[];
  readonly limitations: readonly string[];
}

/** Separate opt-in read model: never the selected candidate or a legacy workspace view. */
export interface WorkspaceEconomyView {
  readonly format: "wmm.workspace-economy-view/1";
  readonly workspaceId: string;
  readonly workspaceVersion: number;
  readonly base: { readonly worldId: string; readonly snapshotDigest: DigestHex };
  readonly worldBasis: "base";
  readonly selectedProposalsIncluded: false;
  readonly candidateView: "unavailable";
  readonly economy: EconomyView;
  readonly limitations: readonly string[];
}
