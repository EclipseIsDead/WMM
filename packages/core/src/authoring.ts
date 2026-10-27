import {
  assertionId, canonicalJsonBytes, sha256Hex, snapshotDigest, supportId,
} from "@wmm/canonical";
import type {
  AssertionRecordV1, AuthoringCitation, AuthoringContext, AuthoringIndex, AuthoringNoteIndex,
  AuthoringPayloadFile, AuthoringProject, AuthoringSection, CompiledAuthoringProject,
  DescriptorRecordV1, JsonValue, ScopeV1, SourceRecordV1, SupportRecordV1, TypedValueV1, WorldCatalogV1,
} from "@wmm/wire-contracts";
import { validateAuthoringProject, validateAuthoringIndex, validateWorldRecord } from "@wmm/wire-contracts";
import { authoringSemantics } from "./authoring-semantics.js";
import { economySemantics } from "./economy-semantics.js";
import { compileEconomicRecordValue } from "./economy.js";
import { MAX_WORLD_BUNDLE_DIRECTORIES } from "./world-bundle-limits.js";
import { validateWorldSemantics } from "./world-validation.js";
import { admitAtlas, AtlasError, MAX_ATLASES_PER_WORLD } from "./atlas.js";

export const MAX_AUTHORING_BYTES = 8 * 1024 * 1024;
export const AUTHORING_INDEX_PATH = "authoring/index.json";
export const AUTHORING_INPUT_PATH = "authoring/project.json";
export const AUTHORING_SOURCE_ID = "source:wmm_authoring";

export class AuthoringError extends TypeError {
  constructor(message: string) { super(message); this.name = "AuthoringError"; }
}

export function authoringScope(context: AuthoringContext): ScopeV1 {
  return {
    account: { kind: "ref", id: context.kind === "setting" ? "account:setting" : `account:campaign_${context.campaignId.slice("campaign:".length)}` },
    jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "notApplicable" },
  };
}

export function authoringSectionPath(owner: string, section: string): string {
  return `prose/${owner.replace(":", "/")}/${section}.md`;
}

export function compileAuthoringProject(input: unknown): CompiledAuthoringProject {
  const validation = validateAuthoringProject(input);
  if (!validation.valid) throw new AuthoringError(`Invalid authoring project: ${JSON.stringify(validation.errors)}`);
  const inputBytes = canonicalJsonBytes(input as JsonValue);
  if (inputBytes.length > MAX_AUTHORING_BYTES) throw new AuthoringError("Authoring project exceeds 8 MiB");
  // Work from a detached ordinary-data value, not caller-owned mutable structures.
  const project = JSON.parse(new TextDecoder().decode(inputBytes)) as AuthoringProject;
  const inputDigest = sha256Hex(inputBytes);
  const semantics = project.economy === undefined ? authoringSemantics() : economySemantics();
  const digest = (key: string): string => {
    const value = semantics.definitionDigestsByKey[key];
    if (value === undefined) throw new AuthoringError(`Unknown authoring definition: ${key}`);
    return value;
  };
  const nodes = [...project.entities, ...project.campaigns, ...project.campaigns.flatMap((campaign) => campaign.tracks)];
  const noteIds = new Set(nodes.map((node) => node.id));
  const sourceIds = new Set(project.sources.map((source) => source.id));
  if (noteIds.size !== nodes.length || nodes.length > 1000) throw new AuthoringError("Duplicate note ID or more than 1000 notes");
  if (sourceIds.size !== project.sources.length || sourceIds.has(AUTHORING_SOURCE_ID)) throw new AuthoringError("Duplicate or reserved source ID");
  for (const source of project.sources) {
    if (source.path.startsWith("/") || source.path.includes("\\") || source.path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new AuthoringError(`Source path must be vault-relative: ${source.id}`);
    }
  }
  const entityIds = new Set(project.entities.map((entity) => entity.id));
  const campaignIds = new Set(project.campaigns.map((campaign) => campaign.id));
  const requireEntity = (id: string): void => {
    if (!entityIds.has(id)) throw new AuthoringError(`Unknown entity reference: ${id}`);
  };
  const checkCitations = (citations: readonly AuthoringCitation[]): void => {
    for (const citation of citations) if (!sourceIds.has(citation.sourceId)) throw new AuthoringError(`Unknown citation source: ${citation.sourceId}`);
  };
  const checkContext = (context: AuthoringContext): void => {
    if (context.kind === "campaign" && !campaignIds.has(context.campaignId)) throw new AuthoringError(`Unknown campaign: ${context.campaignId}`);
  };

  const files = new Map<string, AuthoringPayloadFile>();
  // The loader counts the bundle root and payload/ as well as every payload ancestor.
  const directories = new Set(["", "payload"]);
  let totalBytes = 0;
  function bytes(path: string, content: Uint8Array, mediaType: AuthoringPayloadFile["mediaType"]): void {
    totalBytes += content.length;
    if (files.has(path)) throw new AuthoringError(`Duplicate payload path: ${path}`);
    if (content.length > 10 * 1024 * 1024 || totalBytes > 95 * 1024 * 1024 || files.size >= 10_000) {
      throw new AuthoringError("Compiled project exceeds bundle limits; split it into smaller projects");
    }
    for (let separator = path.indexOf("/"); separator !== -1; separator = path.indexOf("/", separator + 1)) {
      directories.add(`payload/${path.slice(0, separator)}`);
    }
    if (directories.size > MAX_WORLD_BUNDLE_DIRECTORIES) {
      throw new AuthoringError("Compiled project exceeds the bundle directory-count limit; split it into smaller projects");
    }
    files.set(path, { path, mediaType, bytes: content });
  }
  const json = (path: string, value: unknown): void => bytes(path, canonicalJsonBytes(value as JsonValue), "application/json");
  const descriptors: DescriptorRecordV1[] = [];
  function descriptor(id: string, type: string): void {
    descriptors.push({ format: "wmm.descriptor/1", worldId: project.worldId, id, birthTypeDefinitionDigest: digest(type) });
  }
  descriptor("account:setting", "account");
  for (const node of nodes) descriptor(node.id, node.id.split(":")[0]!);
  for (const campaign of project.campaigns) descriptor(`account:campaign_${campaign.id.slice("campaign:".length)}`, "account");

  const assertions = new Map<string, AssertionRecordV1>();
  const active = new Set<string>();
  function claim(subjectId: string, predicate: string, value: TypedValueV1, context: AuthoringContext, polarity: "positive" | "negative" = "positive", isActive = true): AssertionRecordV1 {
    const body = {
      format: "wmm.claim/1" as const, worldId: project.worldId, semanticProfileDigest: semantics.profileDigest,
      proposition: { kind: "atom" as const, subjectId, predicateDefinitionDigest: digest(predicate), value },
      polarity, scope: authoringScope(context), applicability: { kind: "invariant" as const },
    };
    const record: AssertionRecordV1 = { format: "wmm.assertion-record/1", id: assertionId(body), body };
    assertions.set(record.id, record);
    if (isActive) active.add(record.id);
    return record;
  }
  function sections(owner: string, values: readonly AuthoringSection[], campaignId: string | null) {
    if (new Set(values.map((section) => section.id)).size !== values.length) throw new AuthoringError(`Duplicate section ID: ${owner}`);
    return values.map(({ text, ...section }) => {
      checkContext(section.context);
      checkCitations(section.citations);
      if (campaignId !== null && (section.context.kind !== "campaign" || section.context.campaignId !== campaignId)) throw new AuthoringError(`Campaign section has a different context: ${owner}`);
      if (section.category === "session" && section.context.kind !== "campaign") throw new AuthoringError("Session notes require a campaign context");
      for (const id of section.references) if (!noteIds.has(id)) throw new AuthoringError(`Unknown narrative reference: ${id}`);
      const path = authoringSectionPath(owner, section.id);
      bytes(path, new TextEncoder().encode(text), "text/markdown");
      return { ...section, path };
    });
  }
  const notes = new Map<string, AuthoringNoteIndex>();
  for (const entity of project.entities) notes.set(entity.id, { id: entity.id, name: entity.name, campaignId: null, sections: sections(entity.id, entity.sections, null), facts: [], track: null });
  const factIds = new Set<string>();
  for (const fact of project.facts) {
    requireEntity(fact.subjectId); requireEntity(fact.objectId); checkContext(fact.context); checkCitations(fact.citations);
    if (fact.predicate === "located_in" && !fact.objectId.startsWith("place:")) throw new AuthoringError("located_in requires a place target");
    if (fact.predicate === "member_of" && !fact.objectId.startsWith("faction:")) throw new AuthoringError("member_of requires a faction target");
    const record = claim(fact.subjectId, fact.predicate, { kind: "ref", id: fact.objectId }, fact.context, fact.polarity);
    if (factIds.has(record.id)) throw new AuthoringError("Duplicate fact declaration");
    factIds.add(record.id);
    const note = notes.get(fact.subjectId)!;
    notes.set(note.id, { ...note, facts: [...note.facts, { assertionId: record.id, citations: fact.citations }] });
  }
  for (const campaign of project.campaigns) {
    notes.set(campaign.id, { id: campaign.id, name: campaign.name, campaignId: campaign.id, sections: sections(campaign.id, campaign.sections, campaign.id), facts: [], track: null });
    const context: AuthoringContext = { kind: "campaign", campaignId: campaign.id };
    for (const track of campaign.tracks) {
      requireEntity(track.subjectId);
      if (track.minimum > track.maximum || track.entries.some((entry) => entry.value < track.minimum || entry.value > track.maximum)) throw new AuthoringError(`Track value outside its bounds: ${track.id}`);
      const integer = (value: number): TypedValueV1 => ({ kind: "literal", valueDefinitionDigest: digest("safe_integer"), data: value });
      notes.set(track.id, {
        id: track.id, name: track.name, campaignId: campaign.id, sections: [], facts: [],
        track: {
          subjectAssertionId: claim(track.id, "track_subject", { kind: "ref", id: track.subjectId }, context).id,
          minimumAssertionId: claim(track.id, "track_minimum", integer(track.minimum), context).id,
          maximumAssertionId: claim(track.id, "track_maximum", integer(track.maximum), context).id,
          entries: track.entries.map((entry, index) => {
            checkCitations(entry.citations);
            return { assertionId: claim(track.id, "track_value", integer(entry.value), context, "positive", index === track.entries.length - 1).id, note: entry.note, citations: entry.citations };
          }),
        },
      });
    }
  }
  const economicIds = new Set<string>();
  for (const entry of project.economy?.records ?? []) {
    if (economicIds.has(entry.id)) throw new AuthoringError(`Duplicate economic entry ID: ${entry.id}`);
    economicIds.add(entry.id);
    requireEntity(entry.subjectId); checkContext(entry.context); checkCitations(entry.citations);
    const value = compileEconomicRecordValue(entry, semantics.definitionsByDigest);
    claim(entry.subjectId, "economic_record", { kind: "literal", valueDefinitionDigest: digest("economic_record_value"), data: value as unknown as JsonValue }, entry.context);
  }
  const source: SourceRecordV1 = {
    format: "wmm.source/1", worldId: project.worldId, id: AUTHORING_SOURCE_ID, sourceType: "authorStipulation",
    content: { availability: "bundled", path: AUTHORING_INPUT_PATH, sha256: inputDigest },
  };
  // Citations are references only. No path reads, invented hashes or documentary support.
  const sources: SourceRecordV1[] = [source, ...(project.economy === undefined ? [] : project.sources.map((entry): SourceRecordV1 => ({
    format: "wmm.source/1", worldId: project.worldId, id: entry.id, sourceType: "document", content: { availability: "none" },
  })))];
  const records = [...assertions.values()].sort((a, b) => a.id < b.id ? -1 : 1);
  const supports: SupportRecordV1[] = records.map((record) => {
    const body = {
      format: "wmm.support/1" as const, worldId: project.worldId, claimId: record.id, sourceId: source.id, stance: "supports" as const,
      locator: { definitionDigest: digest("author_stipulation_locator"), data: { kind: "authorStipulation" } },
      interpretationMethodDefinitionDigest: digest("author_stipulation_interpretation"), sourceContentDigest: inputDigest,
    };
    return { format: "wmm.support-record/1" as const, id: supportId(body), body };
  }).sort((a, b) => a.id < b.id ? -1 : 1);
  const world: WorldCatalogV1 = {
    format: "wmm.world/1", worldId: project.worldId, semanticProfileDigest: semantics.profileDigest,
    descriptorIds: descriptors.map((record) => record.id).sort(), sourceIds: sources.map((record) => record.id).sort(),
    assertionIds: records.map((record) => record.id), activeAssertionIds: [...active].sort(),
    supportIds: supports.map((record) => record.id), activeSupportIds: supports.filter((record) => active.has(record.body.claimId)).map((record) => record.id),
  };
  for (const record of [world, ...sources, ...descriptors, ...records, ...supports]) {
    if (!validateWorldRecord(record).valid) throw new AuthoringError("Compiler generated an invalid world record");
  }
  validateWorldSemantics({ world, descriptors, sources, assertions: records, supports, definitionsByDigest: semantics.definitionsByDigest });
  const atlasIds = new Set<string>();
  if ((project.atlases?.length ?? 0) > MAX_ATLASES_PER_WORLD) throw new AuthoringError("Too many reference atlases");
  for (const input of project.atlases ?? []) {
    try {
      const atlas = admitAtlas(input, {
        worldId: project.worldId,
        placeIds: descriptors.filter((record) => record.birthTypeDefinitionDigest === digest("place")).map((record) => record.id),
        sourceIds: [source.id],
      });
      if (atlasIds.has(atlas.id)) throw new AuthoringError(`Duplicate atlas ID: ${atlas.id}`);
      atlasIds.add(atlas.id);
      json(`maps/${atlas.id}.json`, atlas);
    } catch (error) {
      if (error instanceof AtlasError) throw new AuthoringError(error.message);
      throw error;
    }
  }
  const index: AuthoringIndex = {
    format: "wmm.authoring-index/1", worldId: project.worldId, title: project.title, inputDigest,
    sources: project.sources, notes: [...notes.values()].sort((a, b) => a.id < b.id ? -1 : 1),
  };
  if (!validateAuthoringIndex(index).valid) throw new AuthoringError("Compiler generated an invalid presentation index");
  json(AUTHORING_INDEX_PATH, index);
  bytes(AUTHORING_INPUT_PATH, inputBytes, "application/json");
  json("world.json", world);
  for (const [digest, definition] of Object.entries(semantics.definitionsByDigest)) json(`types/${digest}.json`, definition);
  json(`types/${semantics.profileDigest}.json`, semantics.profile);
  for (const record of descriptors) json(`records/descriptors/${record.id.replace(":", "/")}.json`, record);
  json("records/sources/wmm_authoring.json", source);
  for (const record of sources) if (record.id !== source.id) json(`records/sources/${record.id.slice("source:".length)}.json`, record);
  for (const record of records) json(`records/assertions/${record.id.slice(5)}.json`, record);
  for (const record of supports) json(`records/supports/${record.id.slice(4)}.json`, record);
  const payload = [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = {
    format: "wmm.snapshot-manifest/1" as const, worldId: project.worldId,
    files: payload.map((file) => ({ path: file.path, mediaType: file.mediaType, byteLength: String(file.bytes.length), sha256: sha256Hex(file.bytes) })),
  };
  return { payload, snapshot: { format: "wmm.snapshot-record/1", snapshotDigest: snapshotDigest(manifest), manifest } };
}
