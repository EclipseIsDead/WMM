import type { AuthoringContext, AuthoringRelation, AuthoringSection } from "./authoring.js";

export interface EntityContextLimits {
  /** Canonical UTF-8 packet bytes, not model tokens or transport-envelope bytes. */
  readonly maxBytes: number;
  /** Relationships, sections and tracks each count as one atomic item. */
  readonly maxItems: number;
}

export interface EntityContextRequest {
  readonly entityId: string;
  readonly campaignId?: string;
  readonly limits?: Partial<EntityContextLimits>;
}

export interface EntityContextRef {
  readonly id: string;
  readonly name: string;
}

export interface EntityContextCitation {
  readonly sourceId: string;
  readonly title: string;
  readonly path: string;
  readonly locator: string;
}

export interface EntityContextRelationship {
  readonly assertionId: string;
  readonly subject: EntityContextRef;
  readonly predicate: { readonly key: AuthoringRelation; readonly definitionDigest: string };
  readonly object: EntityContextRef;
  readonly polarity: "positive" | "negative";
  readonly applicability: { readonly kind: "invariant" };
  readonly context: AuthoringContext;
  readonly citations: readonly EntityContextCitation[];
}

export interface EntityContextSection {
  readonly owner: EntityContextRef;
  readonly id: string;
  readonly heading: string;
  readonly category: AuthoringSection["category"];
  readonly context: AuthoringContext;
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
  readonly references: readonly EntityContextRef[];
  readonly citations: readonly EntityContextCitation[];
}

export interface EntityContextInteger {
  readonly value: number;
  readonly assertionId: string;
}

export interface EntityContextTrack {
  readonly id: string;
  readonly name: string;
  readonly campaignId: string;
  readonly subject: EntityContextRef;
  readonly subjectAssertionId: string;
  readonly minimum: EntityContextInteger;
  readonly maximum: EntityContextInteger;
  readonly current: EntityContextInteger & {
    readonly note: string;
    readonly citations: readonly EntityContextCitation[];
  };
  readonly entryCount: number;
}

export interface EntityContextCounts {
  readonly relationships: number;
  readonly sections: number;
  readonly tracks: number;
}

export interface EntityContextBody {
  readonly format: "wmm.entity-context/1";
  readonly worldId: string;
  readonly snapshotDigest: string;
  readonly semanticProfileDigest: string;
  readonly inputDigest: string;
  readonly perspective: "dm";
  readonly selectionPolicy: "direct-and-referencing";
  readonly entity: EntityContextRef;
  readonly campaign: EntityContextRef | null;
  readonly limits: EntityContextLimits;
  readonly relationships: readonly EntityContextRelationship[];
  readonly sections: readonly EntityContextSection[];
  readonly tracks: readonly EntityContextTrack[];
  readonly coverage: {
    /** Completeness only within the explicit selection policy, not the whole world. */
    readonly complete: boolean;
    readonly available: EntityContextCounts;
    readonly included: EntityContextCounts;
    readonly omissions: { readonly itemLimit: number; readonly byteLimit: number };
  };
  readonly limitations: readonly string[];
}

export interface EntityContextPacket extends EntityContextBody {
  readonly contextDigest: string;
}
