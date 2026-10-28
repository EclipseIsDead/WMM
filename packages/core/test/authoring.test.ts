import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "@wmm/canonical";
import type { AssertionRecordV1, AuthoringProject, AuthoringTrack, CompiledAuthoringProject, DescriptorRecordV1, SourceRecordV1, SupportRecordV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import { AuthoringError, authoringSemantics, compileAuthoringProject, validateWorldSemantics } from "../src/index.js";

export function exampleProject(): unknown {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as unknown;
}

function example(): AuthoringProject { return exampleProject() as AuthoringProject; }
function withTrack(project: AuthoringProject, change: (track: AuthoringTrack) => AuthoringTrack): AuthoringProject {
  return { ...project, campaigns: [{ ...project.campaigns[0]!, tracks: [change(project.campaigns[0]!.tracks[0]!)] }] };
}
function parse<T>(compiled: CompiledAuthoringProject, path: string): T {
  return JSON.parse(new TextDecoder().decode(compiled.payload.find((file) => file.path === path)!.bytes)) as T;
}

function directoryBoundProject(entityCount: number): AuthoringProject {
  return {
    format: "wmm.authoring-project/1", worldId: "world:directory_limit", title: "Directory bound", sources: [], facts: [], campaigns: [],
    entities: Array.from({ length: entityCount }, (_, position) => ({
      id: `person:p${position}`, name: `Person ${position}`, sections: [{
        id: "overview", heading: "Overview", category: "lore", context: { kind: "setting" }, text: "Short narrative", references: [], citations: [],
      }],
    })),
  };
}

const invalidProjects: readonly (readonly [string, (project: AuthoringProject) => unknown, RegExp])[] = [
  ["unknown field", (p) => ({ ...p, approval: true }), /Invalid authoring project/],
  ["malformed ID", (p) => ({ ...p, entities: [{ ...p.entities[0], id: "faction:Bad Name" }] }), /Invalid authoring project/],
  ["unknown source", (p) => ({ ...p, sources: [] }), /Unknown citation source/],
  ["duplicate source", (p) => ({ ...p, sources: [...p.sources, ...p.sources] }), /Duplicate or reserved source/],
  ["source traversal", (p) => ({ ...p, sources: [{ ...p.sources[0], path: "../outside.md" }] }), /vault-relative/],
  ["absolute source", (p) => ({ ...p, sources: [{ ...p.sources[0], path: "/outside.md" }] }), /vault-relative/],
  ["duplicate entity", (p) => ({ ...p, entities: [...p.entities, p.entities[0]] }), /Duplicate note ID/],
  ["missing entity", (p) => ({ ...p, entities: p.entities.slice(0, 1) }), /Unknown narrative reference/],
  ["missing campaign", (p) => ({ ...p, campaigns: [] }), /Unknown campaign/],
  ["dangling fact", (p) => ({ ...p, facts: [{ ...p.facts[0], objectId: "place:absent" }] }), /Unknown entity reference/],
  ["wrong relation range", (p) => ({ ...p, facts: [{ ...p.facts[0], objectId: "faction:lantern_guild" }] }), /place target/],
  ["duplicate fact", (p) => ({ ...p, facts: [...p.facts, ...p.facts] }), /Duplicate fact/],
  ["inverted track bounds", (p) => withTrack(p, (t) => ({ ...t, minimum: 7 })), /outside its bounds/],
  ["track overflow", (p) => withTrack(p, (t) => ({ ...t, entries: [{ value: 7, note: "outside", citations: [] }] })), /outside its bounds/],
  ["empty track", (p) => withTrack(p, (t) => ({ ...t, entries: [] })), /Invalid authoring project/],
  ["fractional track", (p) => withTrack(p, (t) => ({ ...t, entries: [{ value: 1.5, note: "fraction", citations: [] }] })), /Invalid authoring project/],
  ["unsafe integer", (p) => withTrack(p, (t) => ({ ...t, maximum: Number.MAX_SAFE_INTEGER + 1 })), /Invalid authoring project/],
  ["missing track subject", (p) => withTrack(p, (t) => ({ ...t, subjectId: "faction:absent" })), /Unknown entity reference/],
  ["duplicate section", (p) => ({ ...p, entities: [{ ...p.entities[0], sections: [p.entities[0]!.sections[0], p.entities[0]!.sections[0]] }, p.entities[1]] }), /Duplicate section/],
];

describe("structured authoring", () => {
  it("compiles explicit relationships and campaign-scoped track state into a reproducible WMM snapshot", () => {
    const first = compileAuthoringProject(exampleProject());
    const second = compileAuthoringProject(exampleProject());
    expect(first).toEqual(second);
    expect(first.snapshot.snapshotDigest).toBe(snapshotDigest(first.snapshot.manifest));
    for (const file of first.payload) {
      const entry = first.snapshot.manifest.files.find((item) => item.path === file.path)!;
      expect(entry.sha256).toBe(sha256Hex(file.bytes));
      expect(entry.byteLength).toBe(String(file.bytes.length));
    }
    const assertions = first.payload.filter((file) => file.path.startsWith("records/assertions/"))
      .map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as AssertionRecordV1);
    expect(assertions.some((record) => record.body.proposition.kind === "atom" &&
      record.body.proposition.subjectId === "faction:lantern_guild" &&
      record.body.proposition.value.kind === "ref" && record.body.proposition.value.id === "place:north_quay")).toBe(true);
    const current = assertions.filter((record) => record.body.proposition.kind === "atom" &&
      record.body.proposition.subjectId === "track:guild_unrest" &&
      record.body.proposition.value.kind === "literal" && record.body.proposition.value.data === 2);
    expect(current).toHaveLength(1);
    expect(current[0]!.body.scope.account).toEqual({ kind: "ref", id: "account:campaign_harbor_watch" });
    expect(assertions.every((record) => !new TextDecoder().decode(canonicalJsonBytes(record as never)).includes("might extinguish"))).toBe(true);
  });

  it.each(invalidProjects)("rejects %s before producing a snapshot", (_label, change, message) => {
    expect(() => compileAuthoringProject(change(example()))).toThrow(message);
  });

  it.each(["located_in", "member_of"] as const)("retains compiler admission and AuthoringError for a wrong %s target", (predicate) => {
    const project = example();
    const validTarget = predicate === "located_in" ? "place:north_quay" : "faction:lantern_guild";
    const invalidTarget = predicate === "located_in" ? "faction:lantern_guild" : "place:north_quay";
    const fact = { ...project.facts[0]!, predicate, objectId: validTarget };
    expect(() => compileAuthoringProject({ ...project, facts: [fact] })).not.toThrow();
    expect(() => compileAuthoringProject({ ...project, facts: [{ ...fact, objectId: invalidTarget }] })).toThrow(AuthoringError);
    expect(() => compileAuthoringProject({ ...project, facts: [{ ...fact, objectId: "place:missing" }] })).toThrow(/Unknown entity reference/);
  });

  it("does not execute getters or proxy traps from an agent's in-process input", () => {
    let reads = 0;
    const input = Object.defineProperty(example(), "title", { enumerable: true, get: () => { reads += 1; return "malicious"; } });
    expect(() => compileAuthoringProject(input)).toThrow(/Invalid authoring project/);
    const proxy = new Proxy({}, { ownKeys: () => { reads += 1; return []; } });
    expect(() => compileAuthoringProject(proxy)).toThrow(/Invalid authoring project/);
    expect(reads).toBe(0);
  });

  it.each([[988, 999], [989, 1000]] as const)("admits %s narrative owners producing %s generated directories including bundle root and payload", (entityCount, expectedDirectories) => {
    const input = directoryBoundProject(entityCount);
    // Multiple sections share their owner's directory; count unique ancestors, not files.
    const compiled = compileAuthoringProject({ ...input, entities: input.entities.map((entity) => ({
      ...entity, sections: [...entity.sections, { ...entity.sections[0]!, id: "details" }],
    })) });
    const directories = new Set(["", "payload"]);
    for (const file of compiled.payload) {
      const parts = ["payload", ...file.path.split("/")];
      parts.pop();
      while (parts.length > 0) { directories.add(parts.join("/")); parts.pop(); }
    }
    expect(directories.size).toBe(expectedDirectories);
  });

  it.each([990, 1000])("rejects a project whose generated directories exceed the ordinary bundle loader limit (%s owners)", (entityCount) => {
    expect(() => compileAuthoringProject(directoryBoundProject(entityCount))).toThrow(/directory/i);
  });

  it("keeps identities and explicit claims stable when names or narrative change", () => {
    const before = example();
    const after = { ...before, entities: [{ ...before.entities[0]!, name: "Renamed Guild", sections: before.entities[0]!.sections.map((section) => ({ ...section, text: `${section.text}\nMore DM context.` })) }, before.entities[1]!] };
    const first = compileAuthoringProject(before);
    const second = compileAuthoringProject(after);
    expect(first.snapshot.snapshotDigest).not.toBe(second.snapshot.snapshotDigest);
    expect(parse<WorldCatalogV1>(first, "world.json").assertionIds).toEqual(parse<WorldCatalogV1>(second, "world.json").assertionIds);
    expect(parse(first, "records/descriptors/faction/lantern_guild.json")).toEqual(parse(second, "records/descriptors/faction/lantern_guild.json"));
  });

  it("retains ordered track entries but activates only the final value, including repeated values", () => {
    const compiled = compileAuthoringProject(withTrack(example(), (track) => ({ ...track, entries: [1, 2, 1].map((value) => ({ value, note: "Explicit entry", citations: [] })) })));
    const world = parse<WorldCatalogV1>(compiled, "world.json");
    const records = compiled.payload.filter((file) => file.path.startsWith("records/assertions/")).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as AssertionRecordV1);
    const values = records.filter((record) => record.body.proposition.kind === "atom" && record.body.proposition.predicateDefinitionDigest === authoringSemantics().definitionDigestsByKey["track_value"]);
    expect(values).toHaveLength(2);
    const active = values.filter((record) => world.activeAssertionIds.includes(record.id));
    expect(active).toHaveLength(1);
    expect(active[0]!.body.proposition).toMatchObject({ value: { data: 1 } });
  });

  it.each(["2", 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects malformed integer-literal record data %s through the engine", (value) => {
    const compiled = compileAuthoringProject(example());
    const records = <T>(prefix: string): T[] => compiled.payload.filter((file) => file.path.startsWith(prefix)).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as T);
    const assertions = records<AssertionRecordV1>("records/assertions/").map((record) => record.body.proposition.kind === "atom" && record.body.proposition.value.kind === "literal"
      ? { ...record, body: { ...record.body, proposition: { ...record.body.proposition, value: { ...record.body.proposition.value, data: value } } } } : record);
    expect(() => validateWorldSemantics({
      world: parse<WorldCatalogV1>(compiled, "world.json"), definitionsByDigest: authoringSemantics().definitionsByDigest,
      descriptors: records<DescriptorRecordV1>("records/descriptors/"), sources: records<SourceRecordV1>("records/sources/"), assertions, supports: records<SupportRecordV1>("records/supports/"),
    })).toThrow(/safe integer/);
  });
});
