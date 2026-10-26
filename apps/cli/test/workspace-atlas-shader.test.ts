import { describe, expect, it } from "vitest";
import type { AtlasCell, AtlasGrid } from "@wmm/core";
import { renderAtlasGrid } from "../src/workspace/atlas-renderer.js";
import { shadeAtlasGrid } from "../src/workspace/atlas-shader.js";
import type { AtlasPaint } from "../src/workspace/atlas-shader.js";
import { atlasFixture } from "./atlas-fixture.js";
import { mapFixture, workspaceFixture } from "./atlas-fixture.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { renderWorkspaceScreen } from "../src/workspace/presentation.js";
import * as shader from "../src/workspace/atlas-shader.js";

function cell(featureIds: string[] = [], anchorFeatureIds: string[] = []): AtlasCell {
  return { bounds: [0, 0, 1, 1], surfaces: ["land"], featureIds, anchorFeatureIds };
}
function paint(cells: AtlasCell[][], selectedFeatureId: string | null = null): AtlasPaint {
  const atlas = atlasFixture(), options = { layer: "reference", selectedFeatureId } as const;
  const grid: AtlasGrid = { columns: cells[0]!.length, rows: cells.length, bounds: [0, 0, cells[0]!.length, cells.length], cells };
  return { atlas, grid, glyphs: renderAtlasGrid(atlas, grid, options), options, row: 0 };
}
const pixels = (input: AtlasPaint) => shadeAtlasGrid(input, "truecolor").rows.map(row => row.flatMap(run => [...run.text].map(glyph => ({ glyph, style: run.style }))));

describe("terminal cell shader", () => {
  it("detects stream colour depth while respecting explicit no-colour, dumb and non-TTY output", () => {
    expect(shader).toHaveProperty("detectAtlasColourMode");
    const detect = shader.detectAtlasColourMode;
    for (const [depth, expected] of [[1, "none"], [4, "ansi16"], [8, "ansi256"], [24, "truecolor"]] as const) {
      expect(detect({ isTTY: true, getColorDepth: () => depth }, { TERM: "xterm" })).toBe(expected);
    }
    const stream = { isTTY: true, getColorDepth: () => 24 };
    for (const env of [{ NO_COLOR: "1" }, { NO_COLOR: "" }, { TERM: "dumb" }, { FORCE_COLOR: "0" }, { NODE_DISABLE_COLORS: "1" }]) expect(detect(stream, env)).toBe("none");
    expect(detect(stream, { NO_COLOR: "1", FORCE_COLOR: "3" })).toBe("none");
    expect(detect({ isTTY: false }, { FORCE_COLOR: "3" })).toBe("none");
    expect(detect({ isTTY: true }, { FORCE_COLOR: "3" })).toBe("truecolor");
    expect(detect({ isTTY: true }, { FORCE_COLOR: "2" })).toBe("ansi256");
    expect(detect({ isTTY: true }, { TERM: "xterm-256color" })).toBe("ansi256");
  });
  it("colours the actual map pane after safe layout without colouring or changing inspector/source text", () => {
    const initial = workspaceFixture();
    const controller = new WorkspaceController({ read: () => initial, mutate: () => initial, readMap: () => mapFixture() }, initial);
    controller.input("2"); controller.input("m");
    let raster: AtlasPaint | undefined;
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 120, 36, undefined, value => { raster = value; });
    expect(raster).toBeDefined();
    expect(shader).toHaveProperty("shadeAtlasScreen");
    const colour = shader.shadeAtlasScreen;
    const runs = colour(screen, raster, "truecolor");
    expect(runs.map(run => run.text).join("")).toBe(screen);
    expect(runs.filter(run => run.style.backgroundColor).length).toBeGreaterThan(0);
    expect(runs.filter(run => run.style.backgroundColor).every(run => !run.text.includes("source:") && !run.text.includes("INSPECTOR"))).toBe(true);
    expect(colour(screen, raster, "none")).toEqual([{ text: screen, style: {} }]);
    expect(colour(screen, undefined, "truecolor")).toEqual([{ text: screen, style: {} }]);
  });
  it("uses stable place colours, highlights real geometry edges, and preserves anchor-only/mixed meaning", () => {
    const input = paint([[cell(["upland"]), cell(["islet"]), cell(["islet"], ["upland"]), cell([], ["islet"]), cell()]]);
    const before = JSON.stringify(input), image = pixels(input)[0]!;
    expect(image[0]!.style.color).not.toBe(image[1]!.style.color);
    expect(image[0]!.style.bold).toBe(true);
    expect(image[2]!.glyph).toBe("+");
    expect(image[2]!.style.color).toBe("#e7c17a");
    expect(image[3]!.style.backgroundColor).toBe(image[4]!.style.backgroundColor); // An anchor does not paint an area.
    const reordered = { ...input, atlas: { ...input.atlas, features: [...input.atlas.features].reverse() } };
    expect(pixels(reordered)).toEqual(pixels(input));
    expect(JSON.stringify(input)).toBe(before);
    const selected = paint(input.grid.cells.map(row => [...row]), "upland");
    expect(pixels(selected)[0]![0]!.style.color).toBe("#ffffff");
    expect(pixels(selected)[0]![2]!.glyph).toBe("+");
  });
  it("distinguishes a feature's interior from its boundary without inventing a coastline", () => {
    const input = paint(Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => cell(["upland"]))));
    const image = pixels(input);
    expect(image[0]![1]!.style.bold).toBe(true);
    expect(image[1]![1]!.style.bold).not.toBe(true);
    expect(image[1]![1]!.glyph).toBe(input.glyphs[1]![1]);
  });
  it.each(["none", "ansi16", "ansi256", "truecolor"] as const)("batches a full 160x60 homogeneous viewport into one run per row in %s", mode => {
    const input = paint(Array.from({ length: 60 }, () => Array.from({ length: 160 }, () => cell())));
    const image = shadeAtlasGrid(input, mode);
    expect(image.rows).toHaveLength(60);
    expect(image.rows.every(row => row.length === 1 && row[0]!.text.length === 160)).toBe(true);
    expect(image.rows.map(row => row.map(run => run.text).join(""))).toEqual(input.glyphs);
    if (mode === "none") expect(image.rows[0]![0]!.style).toEqual({});
    if (mode === "ansi16") expect(image.rows[0]![0]!.style.color).toBe("green");
  });
});
