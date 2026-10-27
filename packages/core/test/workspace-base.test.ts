import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { SemanticDefinitionV1, SnapshotRecordV1, WorkspaceBaseV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import * as workspaceReview from "../src/workspace-review.js";

const root = new URL("../../../fixtures/v3/succession-world/", import.meta.url);
function parse<T>(path: string): T { return JSON.parse(readFileSync(new URL(path, root), "utf8")) as T; }
const snapshot = parse<SnapshotRecordV1>("snapshot.json");
const catalog = parse<WorldCatalogV1>("payload/world.json");
const documents = snapshot.manifest.files.filter((entry) => entry.path !== "world.json" &&
  !["types/", "records/", "rosters/"].some((prefix) => entry.path.startsWith(prefix)));
const original: WorkspaceBaseV1 = {
  snapshot,
  documents: documents.map((entry) => ({ path: entry.path, mediaType: entry.mediaType, sha256: entry.sha256,
    base64: readFileSync(new URL(`payload/${entry.path}`, root)).toString("base64") })),
  world: {
    format: "wmm.world-export/1", snapshotDigest: snapshot.snapshotDigest, world: catalog,
    semanticProfile: parse(`payload/types/${catalog.semanticProfileDigest}.json`),
    definitions: snapshot.manifest.files.filter((entry) => entry.path.startsWith("types/") &&
      entry.path !== `types/${catalog.semanticProfileDigest}.json`).map((entry) => ({
      digest: entry.path.slice(6, -5), body: parse<SemanticDefinitionV1>(`payload/${entry.path}`),
    })),
    rosters: snapshot.manifest.files.filter((entry) => entry.path.startsWith("rosters/")).map((entry) => ({
      digest: entry.path.slice(8, -5), body: parse(`payload/${entry.path}`),
    })),
    descriptors: catalog.descriptorIds.map((id) => parse(`payload/records/descriptors/${id.replace(":", "/")}.json`)),
    sources: catalog.sourceIds.map((id) => parse(`payload/records/sources/${id.slice(7)}.json`)),
    assertions: catalog.assertionIds.map((id) => parse(`payload/records/assertions/${id.slice(5)}.json`)),
    supports: catalog.supportIds.map((id) => parse(`payload/records/supports/${id.slice(4)}.json`)),
    documents,
  },
};
const binding = { worldId: catalog.worldId, snapshotDigest: snapshot.snapshotDigest, semanticProfileDigest: catalog.semanticProfileDigest };
function verify(): typeof workspaceReview.verifyCapturedWorkspaceBase { return workspaceReview.verifyCapturedWorkspaceBase; }

describe("captured workspace base verification without candidate review", () => {
  it("reconstructs every retained payload against the pinned snapshot and returns detached base data", () => {
    const input = structuredClone(original);
    const before = structuredClone(input);
    const admitted = verify()(input, binding);
    expect(admitted).toEqual(input);
    expect(admitted).not.toBe(input);
    expect(admitted.world).not.toBe(input.world);
    expect(admitted.documents[0]).not.toBe(input.documents[0]);
    expect(input).toEqual(before);
  });

  it("rejects retained content under a different host-pinned semantic profile", () => {
    expect(() => verify()(original, { ...binding, semanticProfileDigest: "0".repeat(64) })).toThrow(/profile/i);
  });

  it("keeps the verified result deeply immutable without freezing caller data", () => {
    const input = structuredClone(original);
    const admitted = verify()(input, binding);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.world.assertions)).toBe(true);
    expect(Object.isFrozen(admitted.world.assertions[0]!.body)).toBe(true);
    expect(Object.isFrozen(admitted.documents[0])).toBe(true);
    expect(Reflect.set(admitted.world.assertions[0]!.body, "polarity", "negative")).toBe(false);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.world.assertions[0]!.body)).toBe(false);
    expect(Object.isFrozen(binding)).toBe(false);
  });

  it("fails closed on an explicitly insufficient reconstruction budget", () => {
    expect(() => verify()(original, binding, { maxWorkUnits: 1 })).toThrow(workspaceReview.WorkspaceReviewBudgetError);
  });

  it("rejects unsupported expected-binding fields instead of implying version authority", () => {
    const expected = { ...binding, workspaceVersion: 4 };
    expect(() => verify()(original, expected)).toThrow(/binding/i);
  });

  it.each([
    ["base", (base: WorkspaceBaseV1): object => base],
    ["export", (base: WorkspaceBaseV1): object => base.world],
    ["definition wrapper", (base: WorkspaceBaseV1): object => base.world.definitions[0]!],
    ["retained document", (base: WorkspaceBaseV1): object => base.documents[0]!],
  ] as const)("rejects unbound authority metadata on the %s", (_label, target) => {
    const input = structuredClone(original);
    Object.defineProperty(target(input), "trusted", { value: true, enumerable: true });
    expect(() => verify()(input, binding)).toThrow(/metadata/i);
  });

  it.each([
    { ...binding, worldId: "world:different" },
    { ...binding, snapshotDigest: "0".repeat(64) },
  ])("preserves ordinary pinned world/snapshot rejection %#", (expected) => {
    expect(() => verify()(original, expected)).toThrow(/world or snapshot/i);
  });

  it("verifies actual retained bytes rather than trusting document metadata", () => {
    const document = original.documents[0]!;
    const input = { ...original, documents: [{ ...document, base64: Buffer.from("Changed retained text\n").toString("base64") }, ...original.documents.slice(1)] };
    expect(() => verify()(input, binding)).toThrow(/digest mismatch/i);
  });

  it("rejects a partial capture even when all retained entries individually match", () => {
    expect(() => verify()({ ...original, documents: original.documents.slice(1) }, binding)).toThrow(/unretained/i);
  });

  it("admits programmatic data before consuming source or binding accessors", () => {
    let reads = 0;
    const input = Object.defineProperty(structuredClone(original), "snapshot", {
      enumerable: true, get: () => { reads += 1; return original.snapshot; },
    });
    expect(() => verify()(input, binding)).toThrow(/data properties/i);
    const expected = Object.defineProperty({ ...binding }, "worldId", {
      enumerable: true, get: () => { reads += 1; return binding.worldId; },
    });
    expect(() => verify()(original, expected)).toThrow(/data properties/i);
    expect(reads).toBe(0);
  });
});
