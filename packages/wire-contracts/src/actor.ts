import type { AuthoringContext } from "./authoring.js";
import type { EntityContextCitation } from "./entity-context.js";

export type ActorItemKind = "goal" | "value" | "resource" | "constraint" | "belief" | "information" | "unknown";

/** Host-side provenance. Never automatically disclosed in the actor packet. */
export type ActorBasis =
  | { readonly kind: "section"; readonly ownerId: string; readonly sectionId: string }
  | { readonly kind: "relationship"; readonly assertionId: string }
  | { readonly kind: "track"; readonly trackId: string };

export interface ActorBriefItem {
  readonly id: string;
  readonly kind: ActorItemKind;
  /** Explicitly curated actor-facing wording; not an assertion of world truth. */
  readonly text: string;
  readonly basis: readonly ActorBasis[];
}
export interface ActorBrief {
  readonly format: "wmm.actor-brief/1";
  readonly snapshotDigest: string;
  readonly actorId: string;
  readonly campaignId?: string;
  readonly question: string;
  readonly items: readonly ActorBriefItem[];
}
export type ActorContextItem = Omit<ActorBriefItem, "basis">;
export interface ActorContextBody {
  readonly format: "wmm.actor-context/1";
  readonly snapshotDigest: string;
  readonly semanticProfileDigest: string;
  readonly inputDigest: string;
  readonly briefDigest: string;
  readonly perspective: "actor";
  readonly selectionPolicy: "explicit-curation";
  readonly actor: { readonly id: string; readonly name: string };
  readonly campaignId: string | null;
  readonly question: string;
  readonly items: readonly ActorContextItem[];
  /** The curated set is never silently shortened; budget exhaustion fails closed. */
  readonly complete: true;
  readonly limits: { readonly maxBytes: number; readonly maxItems: number };
  readonly limitations: readonly string[];
}
export interface ActorContextPacket extends ActorContextBody {
  readonly contextDigest: string;
}

export interface ActorDecisionStatement {
  readonly text: string;
  /** IDs from the prepared brief, not claims of documentary entailment. */
  readonly basis: readonly string[];
}
export interface ActorDecisionDraft {
  readonly format: "wmm.actor-decision/1";
  readonly status: "proposed";
  readonly contextDigest: string;
  readonly action: ActorDecisionStatement;
  readonly rationale: ActorDecisionStatement;
  readonly uncertainties: readonly ActorDecisionStatement[];
  readonly communication: null | ActorDecisionStatement & { readonly status: "draft"; readonly recipient: string };
}
export interface ActorBasisRecord {
  readonly reference: ActorBasis;
  readonly context: AuthoringContext;
  readonly document: null | { readonly path: string; readonly sha256: string };
  readonly assertionIds: readonly string[];
  readonly citations: readonly EntityContextCitation[];
}
/** Host/DM artifact. Unlike the actor packet, this includes source metadata. */
export interface ActorDecisionReview {
  readonly format: "wmm.actor-decision-review/1";
  readonly status: "draft";
  readonly context: ActorContextPacket;
  readonly decision: ActorDecisionDraft;
  readonly decisionDigest: string;
  readonly provenance: readonly { readonly itemId: string; readonly basis: readonly ActorBasisRecord[] }[];
  readonly limitations: readonly string[];
}
