import { describe, expect, it } from "vitest";

import type { Atlas, AtlasBounds, AtlasPoint, AtlasPolygon } from "@wmm/wire-contracts";
import { AtlasError, atlasSurfaceAt, MAX_ATLAS_WORK_UNITS, projectAtlasGrid, selectAtlasCell } from "../src/atlas.js";
import type { AtlasGrid, AtlasSurface } from "../src/atlas.js";
import { rectangle, referenceAtlas } from "../../wire-contracts/test/atlas-fixtures.js";

function separatedRegions(): Atlas {
  const atlas = referenceAtlas();
  return {
    ...atlas,
    frame: { ...atlas.frame, extent: [0, 0, 1200, 800] },
    physicalCoverage: [{ surface: "land", geometry: rectangle([0, 0, 1200, 800]) }],
    features: Array.from({ length: 64 }, (_, index) => {
      const x = index % 8 * 150 + 10, y = Math.floor(index / 8) * 100 + 10;
      return { ...atlas.features[0]!, id: `region_${index}`, geometry: rectangle([x, y, x + 100, y + 60]), anchor: [x + 50, y + 30] };
    }),
  };
}

function closedBoundsMeet(a: AtlasBounds, b: AtlasBounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function halfOpenContains(bounds: AtlasBounds, point: readonly [number, number]): boolean {
  return bounds[0] <= point[0] && point[0] < bounds[2] && bounds[1] <= point[1] && point[1] < bounds[3];
}

// The pre-culling projector's exhaustive predicates are intentionally retained
// here as a differential oracle, independent of the production broad phase.
function referenceCross(a: AtlasPoint, b: AtlasPoint, c: AtlasPoint): number {
  const left = (b[0] - a[0]) * (c[1] - a[1]), right = (b[1] - a[1]) * (c[0] - a[0]);
  const determinant = left - right;
  if ([...a, ...b, ...c].every(Number.isInteger) ||
    Math.abs(determinant) > (Math.abs(left) + Math.abs(right)) * Number.EPSILON * 16 + Number.MIN_VALUE * 16) return determinant;
  const coordinates = [...a, ...b, ...c].map((value): readonly [bigint, number] => {
    if (Number.isInteger(value)) return [BigInt(value), 0];
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const numerator = exponent === 0 ? fraction : fraction | (1n << 52n);
    return [(bits >> 63n) === 0n ? numerator : -numerator, exponent === 0 ? -1074 : exponent - 1075];
  });
  const exponent = Math.min(...coordinates.map((coordinate) => coordinate[1]));
  const integers = coordinates.map(([numerator, power]) => numerator << BigInt(power - exponent));
  const exact = (integers[2]! - integers[0]!) * (integers[5]! - integers[1]!) -
    (integers[3]! - integers[1]!) * (integers[4]! - integers[0]!);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

function referenceOnSegment(a: AtlasPoint, b: AtlasPoint, point: AtlasPoint): boolean {
  return referenceCross(a, b, point) === 0 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1]);
}

function referenceLocation(polygon: AtlasPolygon, point: AtlasPoint): "inside" | "boundary" | "outside" {
  let winding = 0;
  for (let index = 0; index < polygon.vertices.length - 1; index += 1) {
    const a = polygon.vertices[index]!, b = polygon.vertices[index + 1]!;
    if (referenceOnSegment(a, b, point)) return "boundary";
    const side = referenceCross(a, b, point);
    if (a[1] <= point[1] && b[1] > point[1] && side > 0) winding += 1;
    else if (a[1] > point[1] && b[1] <= point[1] && side < 0) winding -= 1;
  }
  return winding === 0 ? "outside" : "inside";
}

function referenceCorners(bounds: AtlasBounds): readonly AtlasPoint[] {
  return [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
}

function referenceMeets(polygon: AtlasPolygon, bounds: AtlasBounds): boolean {
  if (polygon.vertices.some((point) => point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3])) return true;
  const box = referenceCorners(bounds);
  if (box.some((point) => referenceLocation(polygon, point) !== "outside")) return true;
  for (let index = 0; index < polygon.vertices.length - 1; index += 1) {
    const a = polygon.vertices[index]!, b = polygon.vertices[index + 1]!;
    for (let edge = 0; edge < box.length; edge += 1) {
      const c = box[edge]!, d = box[(edge + 1) % box.length]!;
      const abC = referenceCross(a, b, c), abD = referenceCross(a, b, d), cdA = referenceCross(c, d, a), cdB = referenceCross(c, d, b);
      if ((Math.sign(abC) * Math.sign(abD) < 0 && Math.sign(cdA) * Math.sign(cdB) < 0) ||
        (abC === 0 && referenceOnSegment(a, b, c)) || (abD === 0 && referenceOnSegment(a, b, d)) ||
        (cdA === 0 && referenceOnSegment(c, d, a)) || (cdB === 0 && referenceOnSegment(c, d, b))) return true;
    }
  }
  return false;
}

function referenceCovers(polygon: AtlasPolygon, bounds: AtlasBounds): boolean {
  if (referenceCorners(bounds).some((point) => referenceLocation(polygon, point) === "outside")) return false;
  for (let index = 0; index < polygon.vertices.length - 1; index += 1) {
    const a = polygon.vertices[index]!, b = polygon.vertices[index + 1]!;
    if (Math.max(a[0], b[0]) > bounds[0] && Math.min(a[0], b[0]) < bounds[2] &&
      Math.max(a[1], b[1]) > bounds[1] && Math.min(a[1], b[1]) < bounds[3]) return false;
  }
  return true;
}

function referenceGrid(atlas: Atlas, options: { columns: number; rows: number; bounds?: AtlasBounds }): AtlasGrid {
  const { columns, rows } = options, bounds = options.bounds ?? atlas.frame.extent, extent = atlas.frame.extent;
  const axis = (start: number, end: number, count: number): number[] =>
    Array.from({ length: count + 1 }, (_, index) => index === 0 ? start : index === count ? end : start + (end - start) * index / count);
  const xs = axis(bounds[0], bounds[2], columns), ys = axis(bounds[1], bounds[3], rows);
  return { columns, rows, bounds, cells: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const cellBounds: AtlasBounds = [xs[column]!, ys[row]!, xs[column + 1]!, ys[row + 1]!];
    const clipped: AtlasBounds = [Math.max(cellBounds[0], extent[0]), Math.max(cellBounds[1], extent[1]), Math.min(cellBounds[2], extent[2]), Math.min(cellBounds[3], extent[3])];
    const surfaces = new Set<AtlasSurface>();
    if (cellBounds[0] < extent[0] || cellBounds[1] < extent[1] || cellBounds[2] > extent[2] || cellBounds[3] > extent[3]) surfaces.add("outside");
    if (clipped[0] < clipped[2] && clipped[1] < clipped[3]) {
      for (const coverage of atlas.physicalCoverage) if (referenceMeets(coverage.geometry, clipped)) surfaces.add(coverage.surface);
      if (!atlas.physicalCoverage.some((coverage) => referenceCovers(coverage.geometry, clipped))) surfaces.add("unmapped");
    }
    return {
      bounds: cellBounds,
      surfaces: (["land", "water", "unmapped", "outside"] as const).filter((surface) => surfaces.has(surface)),
      featureIds: atlas.features.filter((feature) => feature.geometry.kind === "polygon" ? referenceMeets(feature.geometry, cellBounds) : halfOpenContains(cellBounds, feature.geometry.position)).map((feature) => feature.id).sort(),
      anchorFeatureIds: atlas.features.filter((feature) => halfOpenContains(cellBounds, feature.anchor)).map((feature) => feature.id).sort(),
    };
  })) };
}

function differentialScene(seed: number): Atlas {
  const atlas = referenceAtlas();
  return {
    ...atlas,
    physicalCoverage: seed % 4 === 0 ? [] : [
      { surface: "land", geometry: { kind: "polygon", vertices: [[0, 0], [40, 0], [40, 20], [20, 20], [20, 60], [0, 60], [0, 0]] } },
      { surface: "water", geometry: rectangle([60, 0, 90, 80]) },
      { surface: "land", geometry: rectangle([0, 0, 10, 40]) },
    ],
    features: Array.from({ length: 9 }, (_, index) => {
      const x = (index * 29 + seed * 7) % 70 + 2, y = (index * 17 + seed * 11) % 70 + 2;
      const shapes: AtlasPolygon[] = [
        rectangle([x, y, x + 15, y + 8]),
        { kind: "polygon", vertices: [[x, y], [x + 17, y + 1], [x + 2, y + 20], [x, y]] },
        { kind: "polygon", vertices: [[x, y], [x + 16, y], [x + 16, y + 16], [x + 10, y + 16], [x + 10, y + 5], [x + 5, y + 5], [x + 5, y + 16], [x, y + 16], [x, y]] },
      ];
      const shape = shapes[(seed + index) % shapes.length]!;
      return {
        ...atlas.features[0]!, id: `feature_${8 - index}`,
        geometry: index % 4 === 0 ? { kind: "point", position: [x, y] } : { ...shape, vertices: seed % 2 === 0 ? shape.vertices : [...shape.vertices].reverse() },
        anchor: index % 3 === 0 ? [50, 50] : [(index * 19 + seed * 3) % 100, (index * 31 + seed * 13) % 100],
      };
    }),
  };
}

describe("bounded atlas projection", () => {
  it("projects all 64 separated regions at 160 by 60 within the existing work budget without dropping hits", () => {
    const atlas = separatedRegions();
    const before = structuredClone(atlas);
    expect(MAX_ATLAS_WORK_UNITS).toBe(8_000_000);
    const grid = projectAtlasGrid(atlas, { columns: 160, rows: 60 });
    const rectangles = atlas.features.map((feature) => {
      if (feature.geometry.kind !== "polygon") throw new Error("Expected a rectangle fixture");
      const [x0, y0] = feature.geometry.vertices[0]!, [x1, y1] = feature.geometry.vertices[2]!;
      return { id: feature.id, bounds: [x0, y0, x1, y1] as AtlasBounds, anchor: feature.anchor };
    });
    expect(grid.cells).toHaveLength(60);
    for (const row of grid.cells) {
      expect(row).toHaveLength(160);
      for (const cell of row) {
        expect(cell.surfaces).toEqual(["land"]);
        expect(cell.featureIds).toEqual(rectangles.filter((feature) => closedBoundsMeet(feature.bounds, cell.bounds)).map((feature) => feature.id).sort());
        expect(cell.anchorFeatureIds).toEqual(rectangles.filter((feature) => halfOpenContains(cell.bounds, feature.anchor)).map((feature) => feature.id).sort());
      }
    }
    expect(atlas).toEqual(before);
  });

  it.each(Array.from({ length: 12 }, (_, seed) => seed))("matches the exhaustive pre-culling projector for deterministic scene %i", (seed) => {
    const atlas = differentialScene(seed);
    const viewports = [
      { columns: 7, rows: 5 },
      { columns: 13, rows: 9, bounds: [-10.25, -7.5, 73.75, 108.25] as const },
      { columns: 4, rows: 4, bounds: [20, 20, 60, 60] as const },
      { columns: 3, rows: 7, bounds: [49.99999999999999, 0, 70.5, 100] as const },
    ];
    for (const options of viewports) {
      const grid = projectAtlasGrid(atlas, options);
      expect(grid).toEqual(referenceGrid(atlas, options));
      expect(projectAtlasGrid({ ...atlas, physicalCoverage: [...atlas.physicalCoverage].reverse(), features: [...atlas.features].reverse() }, options)).toEqual(grid);
    }
  });

  it("retains closed viewport edge/corner contacts but keeps points and anchors half-open", () => {
    const atlas = referenceAtlas(), feature = atlas.features[0]!;
    const input: Atlas = { ...atlas, physicalCoverage: [], features: [
      { ...feature, id: "lower-contact", geometry: rectangle([10, 10, 20, 20]), anchor: [20, 20] },
      { ...feature, id: "upper-contact", geometry: rectangle([60, 60, 70, 70]), anchor: [60, 60] },
      { ...feature, id: "upper-point", geometry: { kind: "point", position: [60, 60] }, anchor: [60, 60] },
      { ...feature, id: "middle-point", geometry: { kind: "point", position: [40, 40] }, anchor: [40, 40] },
    ] };
    const grid = projectAtlasGrid(input, { columns: 2, rows: 2, bounds: [20, 20, 60, 60] });
    expect(grid.cells.flat().map((cell) => cell.featureIds)).toEqual([["lower-contact"], [], [], ["middle-point", "upper-contact"]]);
    expect(grid.cells.flat().map((cell) => cell.anchorFeatureIds)).toEqual([["lower-contact"], [], [], ["middle-point"]]);
    expect(grid).toEqual(referenceGrid(input, { columns: 2, rows: 2, bounds: [20, 20, 60, 60] }));
  });

  it("keeps all distant anchor-only collisions selectable in stable ID order", () => {
    const atlas = referenceAtlas();
    const input: Atlas = { ...atlas, physicalCoverage: [], features: ["zeta", "alpha", "middle"].map((id) => ({ ...atlas.features[0]!, id, anchor: [75, 75] })) };
    const grid = projectAtlasGrid(input, { columns: 2, rows: 2 });
    expect(grid.cells[0]![0]!.featureIds).toEqual(["alpha", "middle", "zeta"]);
    const anchors = grid.cells[1]![1]!;
    expect(anchors.featureIds).toEqual([]);
    expect(anchors.anchorFeatureIds).toEqual(["alpha", "middle", "zeta"]);
    expect(selectAtlasCell(anchors, null)).toEqual({ kind: "choose", featureIds: ["alpha", "middle", "zeta"] });
    expect(selectAtlasCell(anchors, "zeta")).toEqual({ kind: "selected", featureId: "zeta" });
    expect(anchors.surfaces).toEqual(["unmapped"]);
  });

  it("does not turn overlapping AABBs into geometry hits or full physical coverage", () => {
    const atlas = referenceAtlas();
    const triangle: AtlasPolygon = { kind: "polygon", vertices: [[0, 0], [100, 0], [0, 100], [0, 0]] };
    const input: Atlas = { ...atlas, physicalCoverage: [{ surface: "land", geometry: triangle }], features: [{ ...atlas.features[0]!, geometry: triangle }] };
    expect(projectAtlasGrid(input, { columns: 1, rows: 1, bounds: [80, 80, 90, 90] }).cells[0]![0]).toMatchObject({ surfaces: ["unmapped"], featureIds: [] });
    expect(projectAtlasGrid(input, { columns: 1, rows: 1 }).cells[0]![0]).toMatchObject({ surfaces: ["land", "unmapped"], featureIds: ["harbor"] });
  });

  it("keeps both physical surfaces at shared grid boundaries without a draw-order winner", () => {
    const atlas = referenceAtlas();
    const input: Atlas = { ...atlas, features: [], physicalCoverage: [
      { surface: "land", geometry: rectangle([0, 0, 50, 100]) },
      { surface: "water", geometry: rectangle([50, 0, 100, 100]) },
    ] };
    expect(projectAtlasGrid(input, { columns: 2, rows: 1 }).cells[0]!.map((cell) => cell.surfaces)).toEqual([["land", "water"], ["land", "water"]]);
    expect(atlasSurfaceAt(input, [50, 50])).toBe("unmapped");
  });

  it("uses exact binary-rational fallback for a wholly just-outside fractional cell", () => {
    const atlas = referenceAtlas();
    const triangle: AtlasPolygon = { kind: "polygon", vertices: [[94679, -131427], [691753, -363675], [691753, 0], [94679, -131427]] };
    const input: Atlas = { ...atlas, frame: { ...atlas.frame, extent: [-1_000_000, -1_000_000, 1_000_000, 1_000_000] },
      physicalCoverage: [{ surface: "land", geometry: triangle }], features: [{ ...atlas.features[0]!, geometry: triangle }],
    };
    const x = 668165.4568846544, y = -354499.9903471717;
    const options = { columns: 1, rows: 1, bounds: [x - 0.000001, y - 0.000001, x, y] as const };
    const grid = projectAtlasGrid(input, options);
    expect(grid.cells[0]![0]).toMatchObject({ surfaces: ["unmapped"], featureIds: [], anchorFeatureIds: [] });
    expect(grid).toEqual(referenceGrid(input, options));
  });

  it("still rejects invalid geometry and contradictory physical interiors wholly outside the viewport", () => {
    const atlas = referenceAtlas(), options = { columns: 1, rows: 1, bounds: [70, 70, 80, 80] as const };
    const crossed: AtlasPolygon = { kind: "polygon", vertices: [[0, 0], [30, 30], [0, 30], [30, 0], [0, 0]] };
    expect(() => projectAtlasGrid({ ...atlas, features: [{ ...atlas.features[0]!, geometry: crossed }] }, options)).toThrow(AtlasError);
    const contradictory: Atlas = { ...atlas, features: [], physicalCoverage: [
      { surface: "land", geometry: rectangle([0, 0, 40, 40]) },
      { surface: "water", geometry: rectangle([10, 10, 30, 30]) },
    ] };
    expect(() => projectAtlasGrid(contradictory, options)).toThrow(/contradictory physical coverage/);
  });
});
