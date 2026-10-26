import { describe, expect, it } from "vitest";

import type { Atlas, AtlasPoint, AtlasPolygon } from "@wmm/wire-contracts";
import * as core from "../src/atlas.js";
import { rectangle, referenceAtlas } from "../../wire-contracts/test/atlas-fixtures.js";

const context = { worldId: "world:atlas_test", placeIds: ["place:harbor"], sourceIds: ["source:map"] };

function admit(atlas: unknown = referenceAtlas()): Atlas { return core.admitAtlas(atlas, context); }

function featureGeometry(geometry: AtlasPolygon): Atlas {
  const atlas = referenceAtlas();
  return { ...atlas, features: [{ ...atlas.features[0]!, geometry }] };
}

function polygon(vertices: readonly AtlasPoint[]): AtlasPolygon { return { kind: "polygon", vertices }; }

describe("reference atlas admission", () => {
  it("admits a detached bounded reference atlas without changing its explicitly authored anchor", () => {
    expect(core).toHaveProperty("admitAtlas");
    const input = referenceAtlas();
    const before = structuredClone(input);
    const admitted = admit(input);
    expect(admitted).toEqual(before);
    expect(input).toEqual(before);
    expect(admitted).not.toBe(input);
    expect(admitted.features[0]!.geometry).not.toBe(input.features[0]!.geometry);
    expect(admitted.features[0]!.anchor).toEqual([70, 70]);
    expect(Object.isFrozen(admitted.features[0]!.anchor)).toBe(true);
    expect(core.MAX_ATLAS_BYTES).toBe(1_048_576);
    expect(core.MAX_ATLASES_PER_WORLD).toBe(8);
  });

  it("requires exact captured-world place/source closure rather than repairing IDs or trusting a place prefix", () => {
    expect(() => core.admitAtlas(referenceAtlas(), { ...context, placeIds: [] })).toThrow(/place/i);
    expect(() => core.admitAtlas(referenceAtlas(), { ...context, sourceIds: [] })).toThrow(/source/i);
    expect(() => core.admitAtlas(referenceAtlas(), { ...context, worldId: "world:other" })).toThrow(/world/i);
    const atlas = referenceAtlas();
    const alternate = { ...atlas, features: [{ ...atlas.features[0]!, entityId: "site:harbor" }] };
    expect(core.admitAtlas(alternate, { ...context, placeIds: ["site:harbor"] })).toEqual(alternate);
    expect(() => admit({ ...atlas, features: [{ ...atlas.features[0]!, entityId: "place:harbor\n" }] })).toThrow();
    try { core.admitAtlas(atlas, { ...context, placeIds: [] }); } catch (error) {
      expect(error).toBeInstanceOf(core.AtlasError);
      expect(error).toMatchObject({ code: "INVALID_ATLAS" });
    }
  });

  it("rejects non-simple, unclosed, repeated, backtracking, and zero-area rings", () => {
    const rings: readonly (readonly AtlasPoint[])[] = [
      [[1, 1], [3, 1], [3, 3], [1, 3]],
      [[1, 1], [3, 3], [1, 3], [3, 1], [1, 1]],
      [[1, 1], [2, 2], [3, 3], [1, 1]],
      [[1, 1], [3, 1], [3, 1], [1, 3], [1, 1]],
      [[1, 1], [4, 1], [2, 1], [2, 4], [1, 1]],
      [[1, 1], [4, 1], [4, 4], [2, 1], [1, 4], [1, 1]],
      [[1, 1], [4, 1], [4, 4], [1, 1], [1, 4], [1, 1]],
    ];
    for (const vertices of rings) {
      expect(() => admit(featureGeometry(polygon(vertices))), JSON.stringify(vertices)).toThrow(core.AtlasError);
      expect(() => admit({ ...referenceAtlas(), physicalCoverage: [{ surface: "land", geometry: polygon(vertices) }] })).toThrow(core.AtlasError);
    }
    const concave = polygon([[1, 1], [3, 1], [5, 1], [5, 5], [3, 3], [1, 5], [1, 1]]);
    expect(admit(featureGeometry(concave)).features[0]!.geometry).toEqual(concave);
    expect(admit(featureGeometry(polygon([...concave.vertices].reverse()))).features[0]!.geometry).toEqual(polygon([...concave.vertices].reverse()));
  });

  it("requires a positive frame, contained authored geometry/anchors, and unique feature IDs", () => {
    const atlas = referenceAtlas();
    for (const extent of [[0, 0, 0, 100], [100, 0, 0, 100], [0, 0, 100, 0]] as const) {
      expect(() => admit({ ...atlas, frame: { ...atlas.frame, extent } })).toThrow(core.AtlasError);
    }
    expect(() => admit({ ...atlas, features: [...atlas.features, ...atlas.features] })).toThrow(/duplicate/i);
    expect(() => admit(featureGeometry(rectangle([-1, 0, 2, 2])))).toThrow(/extent/i);
    expect(() => admit({ ...atlas, features: [{ ...atlas.features[0]!, anchor: [100, 50] }] })).toThrow(/extent/i);
    expect(() => admit({ ...atlas, features: [{ ...atlas.features[0]!, geometry: { kind: "point", position: [20, 100] } }] })).toThrow(/extent/i);
  });

  it("rejects contradictory physical interiors but admits shared edges/vertices and same-surface overlaps", () => {
    const atlas = referenceAtlas();
    const physical = (a: AtlasPolygon, b: AtlasPolygon, surface: "land" | "water" = "water"): Atlas => ({
      ...atlas, features: [], physicalCoverage: [{ surface: "land", geometry: a }, { surface, geometry: b }],
    });
    const square = rectangle([10, 10, 40, 40]);
    for (const other of [
      square, polygon([...square.vertices].reverse()), rectangle([20, 10, 50, 40]), rectangle([20, 20, 30, 30]),
      polygon([[25, 10], [40, 25], [25, 40], [10, 25], [25, 10]]), rectangle([0, 20, 50, 30]),
      polygon([[0, 0], [50, 0], [50, 20], [40, 20], [40, 10], [20, 10], [20, 20], [0, 20], [0, 0]]),
    ]) {
      expect(() => admit(physical(square, other))).toThrow(/physical|contradict/i);
      expect(admit(physical(square, other, "land"))).toEqual(physical(square, other, "land"));
    }
    expect(admit(physical(square, rectangle([40, 10, 60, 40])))).toBeDefined();
    expect(admit(physical(square, rectangle([40, 40, 60, 60])))).toBeDefined();
  });

  it("fails resource admission closed with a budget error rather than truncating", () => {
    const atlas = referenceAtlas();
    const oversized = { ...atlas, features: Array.from({ length: 65 }, (_, i) => ({ ...atlas.features[0]!, id: `feature-${i}` })) };
    expect(() => admit(oversized)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    const tooManyVertices = { ...atlas, features: [], physicalCoverage: Array.from({ length: 17 }, () => ({ surface: "land", geometry: { kind: "polygon", vertices: Array.from({ length: 256 }, () => [1, 1]) } })) };
    expect(() => admit(tooManyVertices)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    const tooManyBytes = { ...atlas, features: Array.from({ length: 64 }, (_, i) => ({ ...atlas.features[0]!, id: `feature-${i}`, locator: "🌊".repeat(4096) })) };
    expect(() => admit(tooManyBytes)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    let calls = 0;
    expect(() => admit(new Proxy({}, { ownKeys: () => { calls += 1; return []; } }))).toThrowError(expect.objectContaining({ code: "INVALID_ATLAS" }));
    expect(calls).toBe(0);
  });
});

describe("reference atlas surface queries", () => {
  it("distinguishes recorded land, recorded water, unmapped, and half-open outside without using features as coverage", () => {
    expect(core).toHaveProperty("atlasSurfaceAt");
    const atlas = admit();
    for (const [point, surface] of [
      [[10, 10], "land"], [[50, 10], "water"], [[70, 70], "unmapped"], [[99, 99], "unmapped"],
      [[100, 99], "outside"], [[99, 100], "outside"], [[-1, 10], "outside"], [[0, 0], "land"],
      [[40, 20], "unmapped"],
    ] as const) expect(core.atlasSurfaceAt(atlas, point), JSON.stringify(point)).toBe(surface);
    expect(core.atlasSurfaceAt({ ...atlas, physicalCoverage: [] }, [2, 2])).toBe("unmapped");
    expect(core.atlasSurfaceAt({ ...atlas, physicalCoverage: [...atlas.physicalCoverage].reverse() }, [40, 20])).toBe("unmapped");
    expect(() => core.atlasSurfaceAt(atlas, [Number.NaN, 0])).toThrow(core.AtlasError);
  });

  it("does not round a just-outside fractional point onto a long authored edge", () => {
    const atlas = { ...referenceAtlas(), features: [], frame: { ...referenceAtlas().frame, extent: [-1_000_000, -1_000_000, 1_000_000, 1_000_000] as const },
      physicalCoverage: [{ surface: "land" as const, geometry: polygon([[94679, -131427], [691753, -363675], [691753, 0], [94679, -131427]]) }],
    };
    // Exact binary-rational determinant is negative (-56153 / 8589934592),
    // although naive double products subtract to zero at this coordinate scale.
    expect(core.atlasSurfaceAt(atlas, [668165.4568846544, -354499.9903471717])).toBe("unmapped");
  });
});

describe("reference atlas grid", () => {
  it("indexes whole-cell polygon/point intersections separately from display anchors", () => {
    expect(core).toHaveProperty("projectAtlasGrid");
    const atlas = referenceAtlas();
    const feature = atlas.features[0]!;
    const input = { ...atlas, features: [feature,
      { ...feature, id: "tiny-point", geometry: { kind: "point" as const, position: [51, 2] as AtlasPoint }, anchor: [70, 70] as AtlasPoint },
      { ...feature, id: "narrow", geometry: rectangle([49, 1, 51, 2]), anchor: [49, 1] as AtlasPoint },
    ] };
    const before = structuredClone(input);
    const grid = core.projectAtlasGrid(input, { columns: 2, rows: 2 });
    expect(grid).toMatchObject({ columns: 2, rows: 2, bounds: [0, 0, 100, 100] });
    expect(grid.cells).toHaveLength(2);
    expect(grid.cells[0]).toHaveLength(2);
    expect(grid.cells[0]![0]).toMatchObject({ bounds: [0, 0, 50, 50], featureIds: ["harbor", "narrow"], anchorFeatureIds: ["narrow"] });
    expect(grid.cells[0]![1]!.featureIds).toEqual(["narrow", "tiny-point"]);
    expect(grid.cells[1]![1]).toMatchObject({ featureIds: [], anchorFeatureIds: ["harbor", "tiny-point"], surfaces: ["water", "unmapped"] });
    expect(input).toEqual(before);
    expect(core.projectAtlasGrid({ ...input, features: [...input.features].reverse() }, { columns: 2, rows: 2 })).toEqual(grid);
  });

  it("proves full coverage geometrically and keeps explicit unmapped for unsolved unions or off-center concavities", () => {
    const atlas = referenceAtlas();
    const oneCell = (input: Atlas, bounds?: readonly [number, number, number, number]): core.AtlasCell => core.projectAtlasGrid(input, { columns: 1, rows: 1, ...(bounds === undefined ? {} : { bounds }) }).cells[0]![0]!;
    const mapped = { ...atlas, physicalCoverage: [{ surface: "land" as const, geometry: rectangle([0, 0, 100, 100]) }] };
    expect(oneCell(mapped).surfaces).toEqual(["land"]);
    const notch = polygon([[0, 0], [10, 0], [10, 20], [20, 20], [20, 0], [100, 0], [100, 100], [0, 100], [0, 0]]);
    const incomplete = { ...atlas, physicalCoverage: [{ surface: "land" as const, geometry: notch }] };
    expect(core.atlasSurfaceAt(incomplete, [50, 50])).toBe("land");
    expect(oneCell(incomplete).surfaces).toEqual(["land", "unmapped"]);
    expect(oneCell(incomplete, [30.5, 30.5, 35.5, 35.5]).surfaces).toEqual(["land"]);
    expect(oneCell({ ...atlas, physicalCoverage: [] }).surfaces).toEqual(["unmapped"]);
    const adjacent = { ...atlas, physicalCoverage: [{ surface: "land" as const, geometry: rectangle([0, 0, 50, 100]) }, { surface: "water" as const, geometry: rectangle([50, 0, 100, 100]) }] };
    // Conservative A: adjacent polygons' union is not certified; no sampling/majority proof.
    expect(oneCell(adjacent).surfaces).toEqual(["land", "water", "unmapped"]);
    expect(oneCell(mapped, [-10, 0, 50, 100]).surfaces).toEqual(["land", "outside"]);
    expect(oneCell(mapped, [110, 0, 120, 100]).surfaces).toEqual(["outside"]);
  });

  it("bounds grid dimensions and validates finite positive local bounds without truncation", () => {
    const atlas = { ...referenceAtlas(), features: [], physicalCoverage: [] };
    expect(() => core.projectAtlasGrid(atlas, { columns: 161, rows: 1 })).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(() => core.projectAtlasGrid(atlas, { columns: 1, rows: 61 })).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    for (const options of [{ columns: 0, rows: 1 }, { columns: 1.5, rows: 1 }, { columns: 1, rows: -1 }, { columns: Number.NaN, rows: 1 }]) {
      expect(() => core.projectAtlasGrid(atlas, options)).toThrow(core.AtlasError);
    }
    for (const bounds of [[0, 0, 0, 1], [0, 10, 1, 0], [0, 0, Number.POSITIVE_INFINITY, 1], [0, 0, Number.NaN, 1], [0, 0, 1_000_001, 1]] as const) {
      expect(() => core.projectAtlasGrid(atlas, { columns: 1, rows: 1, bounds })).toThrow(core.AtlasError);
    }
    const maximum = core.projectAtlasGrid(atlas, { columns: 160, rows: 60 });
    expect(maximum.cells).toHaveLength(60);
    expect(maximum.cells.every((row) => row.length === 160)).toBe(true);
    expect(maximum.cells[59]![159]!.bounds).toEqual([99.375, 98.33333333333333, 100, 100]);
  });

  it("fails excessive whole-grid geometric work closed before returning a partial grid", () => {
    const atlas = referenceAtlas();
    const vertices: AtlasPoint[] = [];
    for (let i = 0; i < 63; i += 1) vertices.push([i * 10, 0]);
    for (let i = 0; i < 63; i += 1) vertices.push([630, i * 10]);
    for (let i = 0; i < 63; i += 1) vertices.push([630 - i * 10, 630]);
    for (let i = 0; i < 63; i += 1) vertices.push([0, 630 - i * 10]);
    vertices.push(vertices[0]!);
    const large = { ...atlas, frame: { ...atlas.frame, extent: [0, 0, 630, 630] as const }, physicalCoverage: [],
      features: Array.from({ length: 16 }, (_, i) => ({ ...atlas.features[0]!, id: `area-${i}`, geometry: polygon(vertices) })),
    };
    expect(admit(large).features).toHaveLength(16);
    expect(() => core.projectAtlasGrid(large, { columns: 160, rows: 60 })).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
  });

  it("rejects collapsed derived cells and preserves exact requested outer grid endpoints", () => {
    const atlas = { ...referenceAtlas(), features: [], physicalCoverage: [] };
    expect(() => core.projectAtlasGrid(atlas, { columns: 2, rows: 1, bounds: [0, 0, Number.MIN_VALUE, 1] })).toThrow(core.AtlasError);
    const bounds = [-1_000_000, -1, Number.MIN_VALUE, 1] as const;
    const grid = core.projectAtlasGrid(atlas, { columns: 3, rows: 3, bounds });
    expect(grid.cells[2]![2]!.bounds[2]).toBe(bounds[2]);
    expect(grid.cells[2]![2]!.bounds[3]).toBe(bounds[3]);
    const pointAtlas = referenceAtlas();
    const point = { ...pointAtlas.features[0]!, geometry: { kind: "point" as const, position: [50, 50] as const }, anchor: [50, 50] as const };
    const hits = core.projectAtlasGrid({ ...pointAtlas, features: [point] }, { columns: 2, rows: 2 });
    expect(hits.cells.flat().map((cell) => cell.featureIds)).toEqual([[], [], [], ["harbor"]]);
    expect(hits.cells.flat().map((cell) => cell.anchorFeatureIds)).toEqual([[], [], [], ["harbor"]]);
  });
});

describe("reference atlas hit selection", () => {
  it("retains a present semantic selection or returns a stable complete chooser with no draw-order winner", () => {
    expect(core).toHaveProperty("selectAtlasCell");
    const cell: core.AtlasCell = { bounds: [0, 0, 1, 1], surfaces: ["unmapped"], featureIds: ["beta", "alpha"], anchorFeatureIds: ["gamma", "beta"] };
    expect(core.selectAtlasCell(cell, "beta")).toEqual({ kind: "selected", featureId: "beta" });
    expect(core.selectAtlasCell(cell, "gamma")).toEqual({ kind: "selected", featureId: "gamma" });
    expect(core.selectAtlasCell(cell, null)).toEqual({ kind: "choose", featureIds: ["alpha", "beta", "gamma"] });
    expect(core.selectAtlasCell({ ...cell, featureIds: [...cell.featureIds].reverse(), anchorFeatureIds: [...cell.anchorFeatureIds].reverse() }, "absent")).toEqual({ kind: "choose", featureIds: ["alpha", "beta", "gamma"] });
    expect(core.selectAtlasCell({ ...cell, featureIds: [], anchorFeatureIds: ["alpha", "alpha"] }, null)).toEqual({ kind: "selected", featureId: "alpha" });
    expect(core.selectAtlasCell({ ...cell, featureIds: [], anchorFeatureIds: [] }, "alpha")).toEqual({ kind: "empty" });
  });

  it("rejects oversized direct hit sets rather than choosing or truncating them", () => {
    const cell: core.AtlasCell = { bounds: [0, 0, 1, 1], surfaces: ["unmapped"], featureIds: Array.from({ length: 65 }, (_, i) => `feature-${i}`), anchorFeatureIds: [] };
    expect(() => core.selectAtlasCell(cell, null)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(() => core.selectAtlasCell({ ...cell, featureIds: cell.featureIds.slice(0, 64), anchorFeatureIds: ["different"] }, null)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
  });
});
