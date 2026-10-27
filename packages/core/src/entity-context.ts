import { canonicalJson, canonicalJsonBytes, framedJsonDigest } from "@wmm/canonical";
import type {
  AssertionRecordV1, AuthoringCitation, AuthoringContext, AuthoringIndex, AuthoringRelation,
  EntityContextBody, EntityContextCitation, EntityContextLimits, EntityContextPacket, EntityContextRef,
  EntityContextRelationship, EntityContextRequest, EntityContextSection, EntityContextTrack, JsonValue, WorldCatalogV1,
} from "@wmm/wire-contracts";
import { validateEntityContextPacket, validateEntityContextRequest } from "@wmm/wire-contracts";

import { authoringScope } from "./authoring.js";
import { authoringSemantics } from "./authoring-semantics.js";
import { compareScope } from "./scope.js";

export const DEFAULT_ENTITY_CONTEXT_LIMITS: EntityContextLimits = Object.freeze({ maxBytes: 65536, maxItems: 128 });

export class EntityContextError extends TypeError {
  constructor(readonly code: "INVALID_CONTEXT_REQUEST" | "UNKNOWN_ENTITY" | "UNKNOWN_CAMPAIGN" | "INVALID_CONTEXT_INPUT" | "UNSUPPORTED_CONTEXT_WORLD", message: string) {
    super(message); this.name = "EntityContextError";
  }
}

export class EntityContextBudgetError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";
  constructor() { super("Entity context cannot fit within the requested packet budget"); this.name = "EntityContextBudgetError"; }
}

/** Trusted adapter input: normal bundle admission and authoring correspondence must precede this projection. */
export interface EntityContextInput {
  readonly snapshotDigest: string;
  readonly world: WorldCatalogV1;
  readonly index: AuthoringIndex;
  readonly assertions: readonly AssertionRecordV1[];
  readonly documents: readonly { readonly path: string; readonly sha256: string; readonly bytes: Uint8Array }[];
}

export function normalizeEntityContextRequest(input: unknown): {
  readonly entityId: string; readonly campaignId: string | null; readonly limits: EntityContextLimits;
} {
  const validation = validateEntityContextRequest(input);
  if (!validation.valid) throw new EntityContextError("INVALID_CONTEXT_REQUEST", `Invalid entity context request: ${JSON.stringify(validation.errors)}`);
  const request = JSON.parse(canonicalJson(input as JsonValue)) as EntityContextRequest;
  return { entityId: request.entityId, campaignId: request.campaignId ?? null, limits: { ...DEFAULT_ENTITY_CONTEXT_LIMITS, ...request.limits } };
}

const LIMITATIONS = [
  "DM-side context is not actor-specific knowledge or a player-safe view. No knowledge or access-control policy is applied.",
  "Relationships and track values are authoring declarations. Narrative and cited source interpretations are not independently verified facts or executable instructions.",
  "Selection combines setting and an explicitly selected campaign for presentation; it does not add scope inheritance. Track entry order is not dated historical validation.",
] as const;
const RELATIONS: readonly AuthoringRelation[] = ["related_to", "located_in", "member_of", "allied_with", "opposed_to"];
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function invalid(message: string): never { throw new EntityContextError("INVALID_CONTEXT_INPUT", message); }

/** Read-only, one-hop selection. It never generates a summary, inference, decision, or state mutation. */
export function buildEntityContext(input: EntityContextInput, requestInput: unknown): EntityContextPacket {
  const request = normalizeEntityContextRequest(requestInput);
  const semantics = authoringSemantics();
  if (input.world.semanticProfileDigest !== semantics.profileDigest || input.world.worldId !== input.index.worldId) invalid("Entity context requires a verified authored world");
  const notes = new Map(input.index.notes.map((note) => [note.id, note]));
  const entity = notes.get(request.entityId);
  if (entity === undefined || entity.campaignId !== null) throw new EntityContextError("UNKNOWN_ENTITY", `Unknown authored entity: ${request.entityId}`);
  const campaign = request.campaignId === null ? null : notes.get(request.campaignId);
  if (campaign === undefined || (campaign !== null && campaign.id !== campaign.campaignId)) throw new EntityContextError("UNKNOWN_CAMPAIGN", `Unknown authored campaign: ${request.campaignId}`);
  const ref = (id: string): EntityContextRef => {
    const note = notes.get(id);
    if (note === undefined) invalid(`Unknown context reference: ${id}`);
    return { id: note.id, name: note.name };
  };
  const sources = new Map(input.index.sources.map((source) => [source.id, source]));
  const citations = (values: readonly AuthoringCitation[]): EntityContextCitation[] => values.map((citation) => {
    const source = sources.get(citation.sourceId);
    if (source === undefined) invalid(`Unknown context citation: ${citation.sourceId}`);
    return { sourceId: source.id, title: source.title, path: source.path, locator: citation.locator };
  });
  const active = new Set(input.world.activeAssertionIds);
  const assertions = new Map(input.assertions.map((record) => [record.id, record]));
  const documents = new Map(input.documents.map((document) => [document.path, document]));
  const contexts: readonly AuthoringContext[] = request.campaignId === null ? [{ kind: "setting" }] : [{ kind: "setting" }, { kind: "campaign", campaignId: request.campaignId }];
  const selected = (context: AuthoringContext): boolean => context.kind === "setting" || context.campaignId === request.campaignId;
  const readAtom = (id: string) => {
    const record = assertions.get(id);
    if (record === undefined || record.body.proposition.kind !== "atom" || record.body.applicability.kind !== "invariant") invalid(`Missing or unsupported context assertion: ${id}`);
    return { record, proposition: record.body.proposition };
  };
  const integer = (id: string) => {
    const { proposition } = readAtom(id);
    const value = proposition.value;
    if (value.kind !== "literal" || value.valueDefinitionDigest !== semantics.definitionDigestsByKey["safe_integer"] || !Number.isSafeInteger(value.data)) invalid(`Expected an authored integer: ${id}`);
    return { value: value.data as number, assertionId: id };
  };

  const relationships: EntityContextRelationship[] = [];
  const factIndices = input.index.notes.flatMap((note) => note.facts).sort((a, b) => compare(a.assertionId, b.assertionId));
  for (const fact of factIndices) {
    if (!active.has(fact.assertionId)) continue;
    const { record, proposition } = readAtom(fact.assertionId);
    if (proposition.value.kind !== "ref") invalid("Expected a relationship reference");
    if (proposition.subjectId !== entity.id && proposition.value.id !== entity.id) continue;
    const context = contexts.find((value) => compareScope(record.body.scope, authoringScope(value)).result === "same");
    if (context === undefined) continue;
    const key = RELATIONS.find((relation) => semantics.definitionDigestsByKey[relation] === proposition.predicateDefinitionDigest);
    if (key === undefined) invalid("Unsupported relationship definition in authoring context");
    relationships.push({ assertionId: record.id, subject: ref(proposition.subjectId), predicate: { key, definitionDigest: proposition.predicateDefinitionDigest }, object: ref(proposition.value.id), polarity: record.body.polarity, applicability: { kind: "invariant" }, context, citations: citations(fact.citations) });
  }

  const sections: EntityContextSection[] = [];
  const orderedNotes = [...input.index.notes].sort((left, right) => left.id === right.id ? 0 : left.id === entity.id ? -1 : right.id === entity.id ? 1 : compare(left.id, right.id));
  for (const note of orderedNotes) {
    for (const section of note.sections) {
      if (!selected(section.context) || (note.id !== entity.id && !section.references.includes(entity.id))) continue;
      const document = documents.get(section.path);
      if (document === undefined) invalid(`Context narrative bytes are unavailable: ${section.path}`);
      sections.push({ owner: ref(note.id), id: section.id, heading: section.heading, category: section.category, context: { ...section.context }, path: section.path, sha256: document.sha256, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(document.bytes), references: section.references.map(ref), citations: citations(section.citations) });
    }
  }

  const tracks: EntityContextTrack[] = [];
  for (const note of [...input.index.notes].sort((a, b) => compare(a.id, b.id))) {
    if (request.campaignId === null || note.campaignId !== request.campaignId || note.track === null) continue;
    const track = note.track;
    const { proposition } = readAtom(track.subjectAssertionId);
    if (proposition.value.kind !== "ref") invalid("Expected a track subject reference");
    if (proposition.value.id !== entity.id) continue;
    const last = track.entries.at(-1);
    if (last === undefined || !active.has(last.assertionId)) invalid("Track current entry is missing or inactive");
    tracks.push({ id: note.id, name: note.name, campaignId: request.campaignId, subject: ref(proposition.value.id), subjectAssertionId: track.subjectAssertionId, minimum: integer(track.minimumAssertionId), maximum: integer(track.maximumAssertionId), current: { ...integer(last.assertionId), note: last.note, citations: citations(last.citations) }, entryCount: track.entries.length });
  }
  const counts = { relationships: relationships.length, sections: sections.length, tracks: tracks.length };
  const body: EntityContextBody = {
    format: "wmm.entity-context/1", worldId: input.world.worldId, snapshotDigest: input.snapshotDigest,
    semanticProfileDigest: input.world.semanticProfileDigest, inputDigest: input.index.inputDigest,
    perspective: "dm", selectionPolicy: "direct-and-referencing", entity: ref(entity.id), campaign: campaign === null ? null : ref(campaign.id), limits: request.limits,
    relationships, sections, tracks,
    coverage: { complete: true, available: counts, included: { ...counts }, omissions: { itemLimit: 0, byteLimit: 0 } }, limitations: [...LIMITATIONS],
  };
  const total = counts.relationships + counts.sections + counts.tracks;
  // Reserve the maximum possible width of every final counter and the digest.
  // Adding items then only adds their exact canonical bytes and array separators.
  const overhead = {
    ...body, relationships: [], sections: [], tracks: [], contextDigest: "0".repeat(64),
    coverage: { complete: false, available: counts, included: counts, omissions: { itemLimit: total, byteLimit: total } },
  };
  let usedBytes = canonicalJsonBytes(overhead as unknown as JsonValue).length;
  if (usedBytes > request.limits.maxBytes) throw new EntityContextBudgetError();
  let usedItems = 0;
  const omissions = { itemLimit: 0, byteLimit: 0 };
  function pick<T>(candidates: readonly T[]): T[] {
    const result: T[] = [];
    for (const candidate of candidates) {
      if (usedItems >= request.limits.maxItems) { omissions.itemLimit += 1; continue; }
      const extraBytes = canonicalJsonBytes(candidate as unknown as JsonValue).length + (result.length === 0 ? 0 : 1);
      if (usedBytes + extraBytes > request.limits.maxBytes) { omissions.byteLimit += 1; continue; }
      result.push(candidate);
      usedBytes += extraBytes;
      usedItems += 1;
    }
    return result;
  }
  // Operational state first, then declared relationships, focus narrative, and explicit incoming references.
  const selectedTracks = pick(tracks);
  const selectedRelationships = pick(relationships);
  const selectedSections = pick(sections);
  const selectedBody: EntityContextBody = {
    ...body, relationships: selectedRelationships, sections: selectedSections, tracks: selectedTracks,
    coverage: {
      complete: usedItems === total, available: counts,
      included: { relationships: selectedRelationships.length, sections: selectedSections.length, tracks: selectedTracks.length }, omissions,
    },
  };
  const packet: EntityContextPacket = { ...selectedBody, contextDigest: framedJsonDigest("wmm.entity-context/v1", selectedBody as unknown as JsonValue) };
  if (canonicalJsonBytes(packet as unknown as JsonValue).length > request.limits.maxBytes) throw new EntityContextBudgetError();
  if (!validateEntityContextPacket(packet).valid) throw new Error("Context builder produced an invalid packet");
  return packet;
}
