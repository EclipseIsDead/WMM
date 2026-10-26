import { readFileSync } from "node:fs";

import { canonicalJsonBytes, framedJsonDigest, sha256Hex } from "@wmm/canonical";
import type { AssertionRecordV1, AuthoringIndex, AuthoringProject, JsonValue, WorldCatalogV1 } from "@wmm/wire-contracts";
import { validateEntityContextPacket } from "@wmm/wire-contracts";
import { describe, expect, it } from "vitest";

import { buildEntityContext, compileAuthoringProject } from "../src/index.js";

function exampleProject(): AuthoringProject {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
}

function input(project: unknown = exampleProject()) {
  const compiled = compileAuthoringProject(project);
  const parse = <T>(path: string): T => JSON.parse(new TextDecoder().decode(compiled.payload.find((file) => file.path === path)!.bytes)) as T;
  return {
    snapshotDigest: compiled.snapshot.snapshotDigest,
    world: parse<WorldCatalogV1>("world.json"),
    index: parse<AuthoringIndex>("authoring/index.json"),
    assertions: compiled.payload.filter((file) => file.path.startsWith("records/assertions/"))
      .map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as AssertionRecordV1),
    documents: compiled.payload.filter((file) => file.path.startsWith("prose/"))
      .map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), bytes: file.bytes })),
  };
}

describe("entity context", () => {
  it("builds a reproducible cited DM dossier from records and narrative without implying actor knowledge", () => {
    const snapshot = input();
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild", campaignId: "campaign:harbor_watch" });
    expect(packet).toEqual(buildEntityContext(snapshot, { campaignId: "campaign:harbor_watch", entityId: "faction:lantern_guild" }));
    expect(packet).toMatchObject({
      format: "wmm.entity-context/1", perspective: "dm", worldId: "world:harbor",
      snapshotDigest: snapshot.snapshotDigest,
      entity: { id: "faction:lantern_guild", name: "Lantern Guild" },
      campaign: { id: "campaign:harbor_watch", name: "Harbor Watch" },
      coverage: { complete: true, available: { relationships: 1, sections: 2, tracks: 1 }, included: { relationships: 1, sections: 2, tracks: 1 } },
    });
    expect(packet.relationships[0]).toMatchObject({ predicate: { key: "located_in" }, object: { id: "place:north_quay", name: "North Quay" }, polarity: "positive", context: { kind: "setting" } });
    expect(packet.sections.find((section) => section.id === "overview")).toMatchObject({
      text: "A guild of lamplighters who maintain the harbor beacons.",
      citations: [{ sourceId: "source:setting_notes", path: "Setting/Factions.md", locator: "Lantern Guild" }],
    });
    expect(packet.sections.find((section) => section.id === "possible_strike")!.category).toBe("possibility");
    expect(packet.tracks[0]).toMatchObject({ id: "track:guild_unrest", minimum: { value: 0 }, maximum: { value: 6 }, current: { value: 2, note: "The council missed another payment." }, entryCount: 2 });
    expect(packet.limitations.join(" ")).toMatch(/not.*actor.*knowledge/i);
    const { contextDigest, ...body } = packet;
    expect(contextDigest).toBe(framedJsonDigest("wmm.entity-context/v1", body as unknown as JsonValue));
    expect(canonicalJsonBytes(packet as unknown as JsonValue).length).toBeLessThanOrEqual(packet.limits.maxBytes);
  });

  it("prioritizes current track state and reports exact omissions under an item budget", () => {
    const packet = buildEntityContext(input(), { entityId: "faction:lantern_guild", campaignId: "campaign:harbor_watch", limits: { maxItems: 1 } });
    expect(packet.tracks).toHaveLength(1);
    expect(packet.tracks[0]!.current.value).toBe(2);
    expect(packet.relationships).toEqual([]);
    expect(packet.sections).toEqual([]);
    expect(packet.coverage).toEqual({
      complete: false, available: { relationships: 1, sections: 2, tracks: 1 },
      included: { relationships: 0, sections: 0, tracks: 1 }, omissions: { itemLimit: 3, byteLimit: 0 },
    });
  });

  it("omits oversized narrative atomically but continues to include smaller cited sections", () => {
    const project = exampleProject();
    const first = project.entities[0]!;
    const snapshot = input({ ...project, entities: [{ ...first, sections: [{ ...first.sections[0]!, id: "large", text: "🧙".repeat(12000) }, ...first.sections] }, project.entities[1]!] });
    const packet = buildEntityContext(snapshot, { entityId: first.id, campaignId: "campaign:harbor_watch", limits: { maxBytes: 8192 } });
    expect(packet.coverage).toMatchObject({ complete: false, available: { relationships: 1, sections: 3, tracks: 1 }, included: { relationships: 1, sections: 2, tracks: 1 }, omissions: { byteLimit: 1, itemLimit: 0 } });
    expect(packet.sections.map((section) => section.id)).toEqual(["overview", "possible_strike"]);
    expect(packet.sections[0]!.text).toBe(first.sections[0]!.text);
    expect(canonicalJsonBytes(packet as unknown as JsonValue).length).toBeLessThanOrEqual(8192);
  });

  it("does not share mutable narrative context metadata with the input snapshot", () => {
    const snapshot = input();
    const before = structuredClone(snapshot);
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild" });
    expect(snapshot).toEqual(before);
    Object.assign(packet.sections[0]!.context, { kind: "campaign", campaignId: "campaign:harbor_watch" });
    expect(snapshot).toEqual(before);
  });

  it("selects only setting data unless a campaign is explicitly requested", () => {
    const packet = buildEntityContext(input(), { entityId: "faction:lantern_guild" });
    expect(packet.campaign).toBeNull();
    expect(packet.sections.map((section) => section.id)).toEqual(["overview"]);
    expect(packet.tracks).toEqual([]);
    expect(packet.coverage).toMatchObject({ complete: true, available: { relationships: 1, sections: 1, tracks: 0 } });
  });

  it("preserves inbound relationship direction and explicit referencing sections without recursively expanding neighbors", () => {
    const project = exampleProject();
    const context = { kind: "campaign", campaignId: "campaign:harbor_watch" } as const;
    const snapshot = input({ ...project,
      entities: [project.entities[0]!, { ...project.entities[1]!, sections: [{ ...project.entities[0]!.sections[0]!, id: "unrelated", references: [], text: "Unrelated location-only secret." }] }, {
        id: "person:auditor", name: "Harbor Auditor", sections: [{ id: "report", heading: "A guild report", category: "dm-note", context, text: "An explicit report concerning the guild.", references: ["faction:lantern_guild"], citations: [] }],
      }],
      facts: [...project.facts, { subjectId: "person:auditor", predicate: "opposed_to", objectId: "faction:lantern_guild", polarity: "negative", context, citations: [] }],
    });
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild", campaignId: "campaign:harbor_watch" });
    expect(packet.relationships.find((relationship) => relationship.subject.id === "person:auditor")).toMatchObject({ object: { id: "faction:lantern_guild" }, polarity: "negative", context });
    expect(packet.sections.at(-1)).toMatchObject({ owner: { id: "person:auditor" }, id: "report", text: "An explicit report concerning the guild." });
    expect(JSON.stringify(packet)).not.toContain("Unrelated location-only secret.");
  });

  it("does not include a different campaign's notes or track values for the same entity", () => {
    const project = exampleProject();
    const snapshot = input({ ...project,
      entities: [{ ...project.entities[0]!, sections: [...project.entities[0]!.sections, { ...project.entities[0]!.sections[0]!, id: "other_campaign", context: { kind: "campaign", campaignId: "campaign:other" }, text: "Other campaign-only narrative." }] }, project.entities[1]!],
      campaigns: [...project.campaigns, { ...project.campaigns[0]!, id: "campaign:other", name: "Other playthrough", tracks: [{ ...project.campaigns[0]!.tracks[0]!, id: "track:other_unrest", entries: [{ value: 5, note: "Other campaign-only state.", citations: [] }] }] }],
    });
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild", campaignId: "campaign:harbor_watch" });
    expect(packet.tracks.map((track) => track.id)).toEqual(["track:guild_unrest"]);
    expect(JSON.stringify(packet)).not.toContain("Other campaign-only");
    expect(packet.coverage.available).toEqual({ relationships: 1, sections: 2, tracks: 1 });
  });

  it.each([
    null, [], { entityId: "Faction:lantern_guild" }, { entityId: "faction:lantern guild" },
    { entityId: "faction:lantern_guild", perspective: "actor" },
    { entityId: "faction:lantern_guild", campaignId: null },
    ...[0, 4095, 262145, 8192.5, Number.NaN].map((maxBytes) => ({ entityId: "faction:lantern_guild", limits: { maxBytes } })),
    ...[0, 513, -1].map((maxItems) => ({ entityId: "faction:lantern_guild", limits: { maxItems } })),
    { entityId: "faction:lantern_guild", limits: { tokens: 2000 } },
  ])("rejects malformed context requests without normalizing source tokens: %j", (request) => {
    expect(() => buildEntityContext(input(), request)).toThrow(expect.objectContaining({ code: "INVALID_CONTEXT_REQUEST" }));
  });

  it("rejects unknown identities instead of guessing or falling back to setting context", () => {
    expect(() => buildEntityContext(input(), { entityId: "faction:absent" })).toThrow(expect.objectContaining({ code: "UNKNOWN_ENTITY" }));
    expect(() => buildEntityContext(input(), { entityId: "faction:lantern_guild", campaignId: "campaign:absent" })).toThrow(expect.objectContaining({ code: "UNKNOWN_CAMPAIGN" }));
  });

  it("does not execute getters or proxy traps in requests", () => {
    let reads = 0;
    const request = Object.defineProperty({}, "entityId", { enumerable: true, get: () => { reads += 1; return "faction:lantern_guild"; } });
    const proxy = new Proxy({}, { ownKeys: () => { reads += 1; return []; } });
    for (const value of [request, proxy]) expect(() => buildEntityContext(input(), value)).toThrow(expect.objectContaining({ code: "INVALID_CONTEXT_REQUEST" }));
    expect(reads).toBe(0);
  });

  it.each([1, 2])("preserves leading U+FEFF narrative text and its captured-byte hash (%i characters)", (count) => {
    const project = exampleProject();
    const text = `${"\uFEFF".repeat(count)}Original narrative`;
    const snapshot = input({ ...project, entities: [{ ...project.entities[0]!, sections: [{ ...project.entities[0]!.sections[0]!, text }] }, project.entities[1]!] });
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild" });
    const section = packet.sections[0]!;
    const document = snapshot.documents.find((document) => document.path === section.path)!;
    expect(document.bytes).toEqual(new TextEncoder().encode(text));
    expect(section.sha256).toBe(sha256Hex(document.bytes));
    expect(section.sha256).toBe(sha256Hex(new TextEncoder().encode(section.text)));
    expect(section.text).toBe(text);
  });

  it("preserves Unicode narrative bytes and validates the closed packet shape", () => {
    const project = exampleProject();
    const text = "A 🧙 wrote café, café, and a literal INPUT[do-not-execute].\nNothing is interpreted.";
    const snapshot = input({ ...project, entities: [{ ...project.entities[0]!, sections: [{ ...project.entities[0]!.sections[0]!, text }] }, project.entities[1]!] });
    const packet = buildEntityContext(snapshot, { entityId: "faction:lantern_guild" });
    expect(packet.sections[0]!.text).toBe(text);
    expect(packet.sections[0]!.sha256).toBe(sha256Hex(new TextEncoder().encode(text)));
    expect(validateEntityContextPacket(packet)).toEqual({ valid: true, errors: [] });
    expect(validateEntityContextPacket({ ...packet, perspective: "actor" }).valid).toBe(false);
    expect(validateEntityContextPacket({ ...packet, approved: true }).valid).toBe(false);
  });
});
