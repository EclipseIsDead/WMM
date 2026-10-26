import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@wmm/canonical";
import type { Atlas, AuthoringProject } from "@wmm/wire-contracts";
import { compileAuthoringProject } from "../src/index.js";

function example(): { atlases: readonly unknown[] } {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/atlas-project.json", import.meta.url), "utf8")) as { atlases: readonly unknown[] };
}

describe("reference atlas authoring", () => {
  it.each([
    ["world mismatch", (atlas: Atlas) => ({ ...atlas, worldId: "world:other" })],
    ["unknown source", (atlas: Atlas) => ({ ...atlas, provenance: { ...atlas.provenance, sourceId: "source:missing" } })],
    ["actor used as place", (atlas: Atlas) => ({ ...atlas, features: [{ ...atlas.features[0], entityId: "faction:auren_crown" }] })],
    ["unsupported holes", (atlas: Atlas) => ({ ...atlas, features: [{ ...atlas.features[0], geometry: { ...atlas.features[0]!.geometry, holes: [] } }] })],
  ] as const)("rejects %s at authoring admission", (_name, change) => {
    const input = example() as AuthoringProject;
    expect(() => compileAuthoringProject({ ...input, atlases: [change(input.atlases![0]!)] })).toThrow(/atlas|authoring project/i);
  });
  it("rejects duplicate atlas IDs and more than eight atlases", () => {
    const input = example() as AuthoringProject, atlas = input.atlases![0]!;
    expect(() => compileAuthoringProject({ ...input, atlases: [atlas, atlas] })).toThrow(/Duplicate atlas/);
    expect(() => compileAuthoringProject({ ...input, atlases: Array.from({ length: 9 }, (_, i) => ({ ...atlas, id: `sheet_${i}` })) })).toThrow(/authoring project|atlas/i);
  });
  it("compiles an explicit atlas into canonical manifest-bound bytes without making political claims", () => {
    const input = example();
    const first = compileAuthoringProject(input);
    expect(compileAuthoringProject(input)).toEqual(first);
    const file = first.payload.find((entry) => entry.path === "maps/reference_demo.json");
    expect(file).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(file!.bytes))).toEqual(input.atlases[0]);
    expect(first.snapshot.manifest.files.find((entry) => entry.path === file!.path)).toMatchObject({
      mediaType: "application/json", sha256: sha256Hex(file!.bytes), byteLength: String(file!.bytes.length),
    });
    const world = JSON.parse(new TextDecoder().decode(first.payload.find((entry) => entry.path === "world.json")!.bytes)) as { assertionIds: readonly string[] };
    expect(world.assertionIds).toEqual([]);
  });
});
