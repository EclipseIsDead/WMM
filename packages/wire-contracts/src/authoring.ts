import type { AssertionId, DigestHex, SnapshotRecordV1 } from "./types.js";
import type { Atlas } from "./atlas.js";
import type { AuthoringEconomy } from "./economy.js";

export type AuthoringContext =
  | { readonly kind: "setting" }
  | { readonly kind: "campaign"; readonly campaignId: string };

/** A traceable citation, not an assertion that documentary evidence was verified. */
export interface AuthoringCitation {
  readonly sourceId: string;
  readonly locator: string;
}

export interface AuthoringSource {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

export interface AuthoringSection {
  readonly id: string;
  readonly heading: string;
  readonly category: "lore" | "dm-note" | "possibility" | "session";
  readonly context: AuthoringContext;
  readonly text: string;
  readonly references: readonly string[];
  readonly citations: readonly AuthoringCitation[];
}

export interface AuthoringEntity {
  /** Namespace specifies the type; names are presentation, never identity. */
  readonly id: string;
  readonly name: string;
  readonly sections: readonly AuthoringSection[];
}

export type AuthoringRelation = "related_to" | "located_in" | "member_of" | "allied_with" | "opposed_to";

export interface AuthoringFact {
  readonly subjectId: string;
  readonly predicate: AuthoringRelation;
  readonly objectId: string;
  readonly polarity: "positive" | "negative";
  readonly context: AuthoringContext;
  readonly citations: readonly AuthoringCitation[];
}

export interface AuthoringTrackEntry {
  readonly value: number;
  readonly note: string;
  readonly citations: readonly AuthoringCitation[];
}

export interface AuthoringTrack {
  readonly id: string;
  readonly name: string;
  readonly subjectId: string;
  readonly minimum: number;
  readonly maximum: number;
  /** Authored order. Last entry is current; this is not a dated historical proof. */
  readonly entries: readonly AuthoringTrackEntry[];
}

export interface AuthoringCampaign extends AuthoringEntity {
  readonly tracks: readonly AuthoringTrack[];
}

export interface AuthoringProject {
  readonly format: "wmm.authoring-project/1";
  readonly worldId: string;
  readonly title: string;
  readonly sources: readonly AuthoringSource[];
  readonly entities: readonly AuthoringEntity[];
  readonly facts: readonly AuthoringFact[];
  readonly campaigns: readonly AuthoringCampaign[];
  /** Optional, explicitly authored reference geometry; never political state. */
  readonly atlases?: readonly Atlas[];
  /** Presence explicitly opts into the release-owned economic profile. */
  readonly economy?: AuthoringEconomy;
}

export interface AuthoringSectionIndex extends Omit<AuthoringSection, "text"> {
  readonly path: string;
}

export interface AuthoringFactIndex {
  readonly assertionId: AssertionId;
  readonly citations: readonly AuthoringCitation[];
}

export interface AuthoringTrackIndex {
  readonly subjectAssertionId: AssertionId;
  readonly minimumAssertionId: AssertionId;
  readonly maximumAssertionId: AssertionId;
  readonly entries: readonly (AuthoringFactIndex & { readonly note: string })[];
}

export interface AuthoringNoteIndex {
  readonly id: string;
  readonly name: string;
  readonly campaignId: string | null;
  readonly sections: readonly AuthoringSectionIndex[];
  readonly facts: readonly AuthoringFactIndex[];
  readonly track: AuthoringTrackIndex | null;
}

/** Presentation and provenance only: structured values live in assertion records. */
export interface AuthoringIndex {
  readonly format: "wmm.authoring-index/1";
  readonly worldId: string;
  readonly title: string;
  readonly inputDigest: DigestHex;
  readonly sources: readonly AuthoringSource[];
  readonly notes: readonly AuthoringNoteIndex[];
}

export interface AuthoringPayloadFile {
  readonly path: string;
  readonly mediaType: "application/json" | "text/markdown";
  readonly bytes: Uint8Array;
}

export interface CompiledAuthoringProject {
  readonly snapshot: SnapshotRecordV1;
  readonly payload: readonly AuthoringPayloadFile[];
}
