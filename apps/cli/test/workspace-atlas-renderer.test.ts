import { describe, expect, it } from "vitest";
import type { AtlasCell, AtlasGrid } from "@wmm/core";
import * as atlasRender from "../src/workspace/atlas-renderer.js";
import * as workspace from "../src/workspace/index.js";
import { atlasFixture, mapFixture } from "./atlas-fixture.js";

describe("linear reference atlas output", () => {
  it("reuses unchanged viewport geometry across colour, selection and cursor-only redraws", () => {
    const atlas = atlasFixture();
    const first = atlasRender.projectAtlasViewport(atlas, 44, 12);
    expect(atlasRender.projectAtlasViewport(atlas, 44, 12)).toBe(first);
    const alternate = atlasRender.projectAtlasViewport(atlas, 40, 10);
    expect(alternate).not.toBe(first);
    expect(atlasRender.projectAtlasViewport(atlas, 44, 12)).toBe(first);
  });
  it("exports deterministic no-atlas output, with service truth and complete bindings", () => {
    const view = mapFixture(null);
    const before = JSON.stringify(view);
    const text = workspace.renderAtlasPlain(view);
    for (const label of ["REFERENCE ATLAS", "BASE WORLD", "Undated outlines; political facts not projected.", "Selected proposals are not shown.",
      "Candidate view unavailable", "No reference atlas", view.workspaceId, view.base.worldId, view.base.snapshotDigest, "SERVICE-LIMITATION-END"]) expect(text).toContain(label);
    expect(text).not.toMatch(/\x1b|\x9b/);
    expect(workspace.renderAtlasPlain(view)).toBe(text);
    expect(JSON.stringify(view)).toBe(before);
  });
  it("renders a complete linear atlas with a fixed-size unwrapped ASCII block and full provenance", () => {
    const view = mapFixture();
    const before = JSON.stringify(view);
    const text = workspace.renderAtlasPlain(view, 40, 12);
    const block = text.split("ASCII GRID (40x12)\n")[1]?.split("\nEND ASCII GRID")[0]?.split("\n");
    expect(block).toHaveLength(12);
    expect(block?.every(line => line.length === 40)).toBe(true);
    for (const value of [view.atlas!.title, view.atlas!.id, view.atlas!.geometryVersion, view.atlasDigest!, view.base.snapshotDigest,
      "source:survey", "Reference sheet, figure 1", "Upland outline", "Islet marker", "place:upland", "place:islet", "exact-as-authored", "approximate", "SERVICE-LIMITATION-END", "Anchor markers are not area"]) expect(text).toContain(value);
    expect(workspace.renderAtlasPlain(view)).toContain("ASCII GRID (72x18)");
    expect(text).not.toMatch(/\x1b|\x9b/);
    expect(JSON.stringify(view)).toBe(before);
  });
  it.each([[0, 12], [40, 0], [161, 12], [40, 61], [2.5, 2], [Number.NaN, 12]])("rejects unsupported raster dimensions %s x %s", (columns, rows) => {
    expect(() => workspace.renderAtlasPlain(mapFixture(), columns, rows)).toThrow(/dimension/i);
  });
  it("letterboxes with terminal cell aspect correction instead of stretching the authored frame", () => {
    const atlas = atlasFixture();
    const grid = atlasRender.projectAtlasViewport(atlas, 44, 12);
    const [x0, y0, x1, y1] = grid.bounds;
    expect((y1 - y0) / grid.rows).toBeCloseTo(2 * (x1 - x0) / grid.columns);
    expect(x0).toBeLessThanOrEqual(atlas.frame.extent[0]); expect(y0).toBeLessThanOrEqual(atlas.frame.extent[1]);
    expect(x1).toBeGreaterThanOrEqual(atlas.frame.extent[2]); expect(y1).toBeGreaterThanOrEqual(atlas.frame.extent[3]);
    expect(grid.cells.flat().some(cell => cell.surfaces.includes("outside"))).toBe(true);
  });
});

describe("ASCII glyph presentation of core cells", () => {
  it("shades known physical states without changing glyphs, geometry or hit targets", () => {
    expect(atlasRender).toHaveProperty("shadeAtlasGrid");
    const shader = atlasRender.shadeAtlasGrid;
    const cells = (["land", "water", "unmapped", "outside"] as const).map((surface): AtlasCell => ({ bounds: [0, 0, 1, 1], surfaces: [surface], featureIds: [], anchorFeatureIds: [] }));
    const grid: AtlasGrid = { columns: 4, rows: 1, bounds: [0, 0, 4, 1], cells: [cells] };
    const atlas = atlasFixture(), options = { layer: "physical", selectedFeatureId: null } as const;
    const glyphs = atlasRender.renderAtlasGrid(atlas, grid, options);
    const before = JSON.stringify(grid);
    const frame = shader({ atlas, grid, glyphs, options, row: 0 }, "truecolor");
    expect(frame.rows[0]!.map(run => run.text).join("")).toBe(".~? ");
    expect(frame.rows[0]![0]!.style.backgroundColor).toBeDefined();
    expect(frame.rows[0]![1]!.style.backgroundColor).not.toBe(frame.rows[0]![0]!.style.backgroundColor);
    expect(frame.rows[0]![2]!.style.backgroundColor).not.toBe(frame.rows[0]![1]!.style.backgroundColor);
    expect(frame.rows[0]![3]!.style).toEqual({});
    expect(JSON.stringify(grid)).toBe(before);
  });
  it("keeps land, water, unknown, outside, and mixed coverage distinct without interpreting features as terrain", () => {
    const cells = (["land", "water", "unmapped", "outside"] as const).map((surface): AtlasCell => ({ bounds: [0, 0, 1, 1], surfaces: [surface], featureIds: [], anchorFeatureIds: [] }));
    cells.push({ bounds: [0, 0, 1, 1], surfaces: ["land", "water"], featureIds: [], anchorFeatureIds: [] });
    const grid: AtlasGrid = { columns: 5, rows: 1, bounds: [0, 0, 5, 1], cells: [cells] };
    expect(atlasRender.renderAtlasGrid(atlasFixture(), grid, { layer: "physical", selectedFeatureId: null })).toEqual([".~? #"]);
  });
  it("preserves anchor-only and mixed targets and uses stable id codes rather than draw-order winners", () => {
    const atlas = atlasFixture();
    const grid: AtlasGrid = { columns: 3, rows: 1, bounds: [0, 0, 3, 1], cells: [[
      { bounds: [0, 0, 1, 1], surfaces: ["water"], featureIds: [], anchorFeatureIds: ["islet"] },
      { bounds: [1, 0, 2, 1], surfaces: ["water"], featureIds: ["islet"], anchorFeatureIds: ["upland"] },
      { bounds: [2, 0, 3, 1], surfaces: ["unmapped"], featureIds: ["upland"], anchorFeatureIds: [] },
    ]] };
    const before = JSON.stringify(grid);
    const rows = atlasRender.renderAtlasGrid(atlas, grid, { layer: "reference", selectedFeatureId: "islet" });
    expect(rows[0]?.[0]).toBe("@");
    expect(rows[0]?.[1]).toBe("+");
    expect(rows[0]?.[2]).not.toMatch(/[.~? @+#]/);
    expect(atlasRender.renderAtlasGrid({ ...atlas, features: [...atlas.features].reverse() }, grid, { layer: "reference", selectedFeatureId: "islet" })).toEqual(rows);
    expect(atlasRender.renderAtlasGrid(atlas, grid, { layer: "physical", selectedFeatureId: null })).toEqual(["~~?"]);
    expect(JSON.stringify(grid)).toBe(before);
  });
});
