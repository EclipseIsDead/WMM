import { MAX_ATLAS_COORDINATE, MAX_ATLAS_FEATURES, validateAtlas } from "@wmm/wire-contracts";
import type { Atlas, AtlasBounds, AtlasPoint, AtlasPolygon } from "@wmm/wire-contracts";

export { MAX_ATLAS_BYTES, MAX_ATLASES_PER_WORLD } from "@wmm/wire-contracts";

export type AtlasSurface = "land" | "water" | "unmapped" | "outside";
export const MAX_ATLAS_GRID_COLUMNS = 160;
export const MAX_ATLAS_GRID_ROWS = 60;
export const MAX_ATLAS_GRID_CELLS = 9600;
/** Conservative geometric work, reserved before expensive predicates run. */
export const MAX_ATLAS_WORK_UNITS = 8_000_000;

export interface AtlasCell {
  readonly bounds: AtlasBounds;
  readonly surfaces: readonly AtlasSurface[];
  readonly featureIds: readonly string[];
  readonly anchorFeatureIds: readonly string[];
}

export interface AtlasGrid {
  readonly columns: number;
  readonly rows: number;
  readonly bounds: AtlasBounds;
  readonly cells: readonly (readonly AtlasCell[])[];
}

export class AtlasError extends Error {
  constructor(readonly code: "INVALID_ATLAS" | "BUDGET_EXCEEDED", message: string) {
    super(message);
    this.name = "AtlasError";
  }
}

function invalid(message: string): never { throw new AtlasError("INVALID_ATLAS", `Invalid atlas: ${message}`); }

function assertWorkBudget(work: number): void {
  if (!Number.isSafeInteger(work) || work > MAX_ATLAS_WORK_UNITS) throw new AtlasError("BUDGET_EXCEEDED", "Atlas geometric work limit exceeded");
}

function geometryWork(atlas: Atlas): number {
  const rings = [...atlas.physicalCoverage.map((coverage) => coverage.geometry), ...atlas.features.flatMap((feature) => feature.geometry.kind === "polygon" ? [feature.geometry] : [])];
  let work = 1 + atlas.features.length + atlas.physicalCoverage.length;
  for (const ring of rings) work += ring.vertices.length ** 2;
  for (let i = 0; i < atlas.physicalCoverage.length; i += 1) {
    const first = atlas.physicalCoverage[i]!;
    for (let j = i + 1; j < atlas.physicalCoverage.length; j += 1) {
      const second = atlas.physicalCoverage[j]!;
      if (first.surface === second.surface) continue;
      const a = first.geometry.vertices.length, b = second.geometry.vertices.length;
      // Edge pairs, contact-piece sorting, and all piece-vs-ring location tests.
      work += a * b * (8 + 8 * (a + b));
    }
  }
  return work;
}

function same(a: AtlasPoint, b: AtlasPoint): boolean { return a[0] === b[0] && a[1] === b[1]; }

function binaryCoordinate(value: number): readonly [bigint, number] {
  if (Number.isInteger(value)) return [BigInt(value), 0];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const numerator = exponent === 0 ? fraction : fraction | (1n << 52n);
  return [(bits >> 63n) === 0n ? numerator : -numerator, exponent === 0 ? -1074 : exponent - 1075];
}

function exactCrossSign(a: AtlasPoint, b: AtlasPoint, c: AtlasPoint): number {
  const coordinates = [...a, ...b, ...c].map(binaryCoordinate);
  const exponent = Math.min(...coordinates.map((coordinate) => coordinate[1]));
  const integers = coordinates.map(([numerator, power]) => numerator << BigInt(power - exponent));
  const determinant = (integers[2]! - integers[0]!) * (integers[5]! - integers[1]!) -
    (integers[3]! - integers[1]!) * (integers[4]! - integers[0]!);
  return determinant > 0n ? 1 : determinant < 0n ? -1 : 0;
}

function cross(a: AtlasPoint, b: AtlasPoint, c: AtlasPoint): number {
  const left = (b[0] - a[0]) * (c[1] - a[1]), right = (b[1] - a[1]) * (c[0] - a[0]);
  const determinant = left - right;
  // Authored bounded integer products are exact. Local raster/query points can
  // be fractional: ambiguous floating signs fall back to exact binary rationals,
  // not an epsilon that could promote outside/unknown to mapped coverage.
  if ([...a, ...b, ...c].every(Number.isInteger) ||
    Math.abs(determinant) > (Math.abs(left) + Math.abs(right)) * Number.EPSILON * 16 + Number.MIN_VALUE * 16) return determinant;
  return exactCrossSign(a, b, c);
}
function onSegment(a: AtlasPoint, b: AtlasPoint, p: AtlasPoint): boolean {
  return cross(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function segmentsMeet(a: AtlasPoint, b: AtlasPoint, c: AtlasPoint, d: AtlasPoint): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (Math.sign(abC) * Math.sign(abD) < 0 && Math.sign(cdA) * Math.sign(cdB) < 0) ||
    (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}
function inBounds(point: AtlasPoint, bounds: AtlasBounds, closed = false): boolean {
  return point[0] >= bounds[0] && point[1] >= bounds[1] &&
    (closed ? point[0] <= bounds[2] && point[1] <= bounds[3] : point[0] < bounds[2] && point[1] < bounds[3]);
}
function assertRing(polygon: AtlasPolygon, extent: AtlasBounds): void {
  const vertices = polygon.vertices;
  if (!same(vertices[0]!, vertices[vertices.length - 1]!)) invalid("polygon ring must be closed");
  const count = vertices.length - 1;
  const seen = new Set<string>();
  let area2 = 0;
  for (let index = 0; index < count; index += 1) {
    const a = vertices[index]!, b = vertices[index + 1]!, c = vertices[(index + 2) % count]!;
    if (!inBounds(a, extent, true)) invalid("polygon vertex outside frame extent");
    const key = `${a[0]},${a[1]}`;
    if (seen.has(key)) invalid("duplicate polygon vertex");
    seen.add(key);
    area2 += a[0] * b[1] - b[0] * a[1];
    if (cross(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) invalid("backtracking polygon edge");
    for (let other = index + 2; other < count; other += 1) {
      if (index === 0 && other === count - 1) continue;
      if (segmentsMeet(a, b, vertices[other]!, vertices[other + 1]!)) invalid("self-intersecting polygon");
    }
  }
  if (seen.size < 3 || area2 === 0 || !Number.isSafeInteger(area2)) invalid("degenerate polygon");
}

function area2(polygon: AtlasPolygon): number {
  let result = 0;
  for (let i = 0; i < polygon.vertices.length - 1; i += 1) {
    const a = polygon.vertices[i]!, b = polygon.vertices[i + 1]!;
    result += a[0] * b[1] - b[0] * a[1];
  }
  return result;
}

function locate(polygon: AtlasPolygon, point: AtlasPoint): "inside" | "boundary" | "outside" {
  let winding = 0;
  for (let i = 0; i < polygon.vertices.length - 1; i += 1) {
    const a = polygon.vertices[i]!, b = polygon.vertices[i + 1]!;
    if (onSegment(a, b, point)) return "boundary";
    const side = cross(a, b, point);
    if (a[1] <= point[1] && b[1] > point[1] && side > 0) winding += 1;
    else if (a[1] > point[1] && b[1] <= point[1] && side < 0) winding -= 1;
  }
  return winding === 0 ? "outside" : "inside";
}

/** Exact interior-overlap test for bounded integer simple polygons.
 * Proper crossings, same-sided coincident edge intervals, then boundary pieces
 * split at every vertex contact. Half-integer midpoints are exact here; testing
 * only the original unsplit edges would miss vertex-on-edge crossings.
 */
function interiorsOverlap(first: AtlasPolygon, second: AtlasPolygon): boolean {
  const av = first.vertices, bv = second.vertices;
  const aPieces = av.slice(0, -1).map((p, i) => [p, av[i + 1]!]);
  const bPieces = bv.slice(0, -1).map((p, i) => [p, bv[i + 1]!]);
  const windingProduct = Math.sign(area2(first)) * Math.sign(area2(second));
  for (let i = 0; i < av.length - 1; i += 1) {
    const a = av[i]!, b = av[i + 1]!;
    for (let j = 0; j < bv.length - 1; j += 1) {
      const c = bv[j]!, d = bv[j + 1]!;
      const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
      if (Math.sign(abC) * Math.sign(abD) < 0 && Math.sign(cdA) * Math.sign(cdB) < 0) return true;
      if (abC === 0 && abD === 0) {
        const axis = a[0] !== b[0] ? 0 : 1;
        const overlap = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
          Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
        const direction = Math.sign((b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]));
        if (overlap > 0 && direction * windingProduct > 0) return true;
      }
      if (onSegment(a, b, c)) aPieces[i]!.push(c);
      if (onSegment(a, b, d)) aPieces[i]!.push(d);
      if (onSegment(c, d, a)) bPieces[j]!.push(a);
      if (onSegment(c, d, b)) bPieces[j]!.push(b);
    }
  }
  const insidePiece = (pieces: AtlasPoint[][], other: AtlasPolygon): boolean => pieces.some((points) => {
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!, b = points[i + 1]!;
      if (!same(a, b) && locate(other, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) === "inside") return true;
    }
    return false;
  });
  return insidePiece(aPieces, second) || insidePiece(bPieces, first);
}

function assertGeometry(atlas: Atlas): void {
  assertWorkBudget(geometryWork(atlas));
  const extent = atlas.frame.extent;
  if (!(extent[0] < extent[2] && extent[1] < extent[3])) invalid("frame extent must have positive area");
  for (const coverage of atlas.physicalCoverage) assertRing(coverage.geometry, extent);
  for (let i = 0; i < atlas.physicalCoverage.length; i += 1) {
    const first = atlas.physicalCoverage[i]!;
    for (let j = i + 1; j < atlas.physicalCoverage.length; j += 1) {
      const second = atlas.physicalCoverage[j]!;
      if (first.surface !== second.surface && interiorsOverlap(first.geometry, second.geometry)) invalid("contradictory physical coverage interiors");
    }
  }
  const ids = new Set<string>();
  for (const feature of atlas.features) {
    if (ids.has(feature.id)) invalid(`duplicate feature ID: ${feature.id}`);
    ids.add(feature.id);
    if (!inBounds(feature.anchor, extent)) invalid("anchor outside frame extent");
    if (feature.geometry.kind === "polygon") assertRing(feature.geometry, extent);
    else if (!inBounds(feature.geometry.position, extent)) invalid("point outside frame extent");
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function admitAtlas(input: unknown, context: { worldId: string; placeIds: readonly string[]; sourceIds: readonly string[] }): Atlas {
  const atlas = captureAtlas(input);
  assertGeometry(atlas);
  if (atlas.worldId !== context.worldId) invalid("captured world does not match");
  if (!context.sourceIds.includes(atlas.provenance.sourceId)) invalid("unknown provenance source");
  const places = new Set(context.placeIds);
  for (const feature of atlas.features) if (!places.has(feature.entityId)) invalid(`unknown place descriptor: ${feature.entityId}`);
  return freeze(atlas);
}

function captureAtlas(input: unknown): Atlas {
  const validation = validateAtlas(input);
  if (!validation.valid) {
    if (validation.errors.some((error) => ["maxItems", "maxJsonBytes", "maxAtlasVertices"].includes(error.keyword) ||
      (error.keyword === "jsonData" && error.message?.includes("exceeds")))) {
      throw new AtlasError("BUDGET_EXCEEDED", "Atlas resource admission limit exceeded");
    }
    invalid("shape or plain-data constraint");
  }
  return structuredClone(input) as Atlas;
}

/** A shared land/water boundary is unresolved, never a draw-order winner. */
export function atlasSurfaceAt(input: Atlas, point: AtlasPoint): AtlasSurface {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) invalid("query point must be a finite pair");
  const atlas = captureAtlas(input);
  assertWorkBudget(geometryWork(atlas) + atlas.physicalCoverage.reduce((count, coverage) => count + coverage.geometry.vertices.length, 0));
  assertGeometry(atlas);
  if (!inBounds(point, atlas.frame.extent)) return "outside";
  const interiors = new Set<"land" | "water">(), boundaries = new Set<"land" | "water">();
  for (const coverage of atlas.physicalCoverage) {
    const location = locate(coverage.geometry, point);
    if (location === "inside") interiors.add(coverage.surface);
    else if (location === "boundary") boundaries.add(coverage.surface);
  }
  const surfaces = interiors.size > 0 ? interiors : boundaries;
  return surfaces.size === 1 ? [...surfaces][0]! : "unmapped";
}

function corners(bounds: AtlasBounds): readonly AtlasPoint[] {
  return [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
}

function polygonBounds(polygon: AtlasPolygon): AtlasBounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const point of polygon.vertices) {
    x0 = Math.min(x0, point[0]); y0 = Math.min(y0, point[1]);
    x1 = Math.max(x1, point[0]); y1 = Math.max(y1, point[1]);
  }
  return [x0, y0, x1, y1];
}

/** Keep closed edge/corner contacts; this is only a rejection, not a hit proof. */
function boundsMeet(a: AtlasBounds, b: AtlasBounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Closed boundary contact is conservatively selectable, never a coverage proof. */
function polygonMeetsBounds(polygon: AtlasPolygon, bounds: AtlasBounds): boolean {
  if (polygon.vertices.some((point) => inBounds(point, bounds, true))) return true;
  const box = corners(bounds);
  if (box.some((point) => locate(polygon, point) !== "outside")) return true;
  for (let i = 0; i < polygon.vertices.length - 1; i += 1) {
    for (let j = 0; j < box.length; j += 1) {
      if (segmentsMeet(polygon.vertices[i]!, polygon.vertices[i + 1]!, box[j]!, box[(j + 1) % box.length]!)) return true;
    }
  }
  return false;
}

/** Sufficient, deliberately conservative coverage certificate for one simple ring.
 * Every corner is inside/on it and no boundary edge can enter the open cell.
 * Edge AABBs may produce false uncertainty, never a false completeness claim.
 * Unions of separate polygons are not certified in this increment.
 */
function polygonCoversBounds(polygon: AtlasPolygon, bounds: AtlasBounds): boolean {
  if (corners(bounds).some((point) => locate(polygon, point) === "outside")) return false;
  for (let i = 0; i < polygon.vertices.length - 1; i += 1) {
    const a = polygon.vertices[i]!, b = polygon.vertices[i + 1]!;
    if (Math.max(a[0], b[0]) > bounds[0] && Math.min(a[0], b[0]) < bounds[2] &&
      Math.max(a[1], b[1]) > bounds[1] && Math.min(a[1], b[1]) < bounds[3]) return false;
  }
  return true;
}

function gridAxis(start: number, end: number, count: number): readonly number[] {
  const axis = Array.from({ length: count + 1 }, (_, index) => index === 0 ? start : index === count ? end : start + (end - start) * index / count);
  for (let i = 1; i < axis.length; i += 1) if (!(axis[i]! > axis[i - 1]!)) invalid("grid cells collapse at this numeric resolution");
  return axis;
}

export function projectAtlasGrid(input: Atlas, options: { columns: number; rows: number; bounds?: AtlasBounds }): AtlasGrid {
  const { columns, rows } = options;
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns <= 0 || rows <= 0) invalid("grid dimensions must be positive integers");
  if (columns > MAX_ATLAS_GRID_COLUMNS || rows > MAX_ATLAS_GRID_ROWS || columns * rows > MAX_ATLAS_GRID_CELLS) {
    throw new AtlasError("BUDGET_EXCEEDED", "Atlas grid size limit exceeded");
  }
  const atlas = captureAtlas(input);
  const physicalVertices = atlas.physicalCoverage.reduce((sum, coverage) => sum + coverage.geometry.vertices.length, 0);
  const featureVertices = atlas.features.reduce((sum, feature) => sum + (feature.geometry.kind === "polygon" ? feature.geometry.vertices.length : 0), 0);
  // Reserve validation, bounds construction, and every broad-phase/point/anchor
  // visit first. Charge the unchanged worst-case narrow work only for candidates,
  // before their predicates run. No partial grid escapes if a reservation fails.
  // Per feature: four bounds/point checks, four anchor checks, two hit-list visits.
  let work = geometryWork(atlas) + 4 * (physicalVertices + featureVertices) +
    columns * rows * (4 * atlas.physicalCoverage.length + 10 * atlas.features.length + 1);
  assertWorkBudget(work);
  assertGeometry(atlas);
  const bounds: AtlasBounds = [...(options.bounds ?? atlas.frame.extent)];
  if (bounds.length !== 4 || !bounds.every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_ATLAS_COORDINATE) ||
    !(bounds[0] < bounds[2] && bounds[1] < bounds[3])) invalid("grid bounds must be finite, bounded, and have positive area");
  const xs = gridAxis(bounds[0], bounds[2], columns), ys = gridAxis(bounds[1], bounds[3], rows);
  const extent = atlas.frame.extent;
  const physical = atlas.physicalCoverage.map((coverage) => ({ ...coverage, bounds: polygonBounds(coverage.geometry) }));
  const features = atlas.features.map((feature) => ({ ...feature, bounds: feature.geometry.kind === "polygon" ? polygonBounds(feature.geometry) : null }));
  const cells: AtlasCell[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: AtlasCell[] = [];
    for (let column = 0; column < columns; column += 1) {
      const cellBounds: AtlasBounds = [xs[column]!, ys[row]!, xs[column + 1]!, ys[row + 1]!];
      const clipped: AtlasBounds = [Math.max(cellBounds[0], extent[0]), Math.max(cellBounds[1], extent[1]), Math.min(cellBounds[2], extent[2]), Math.min(cellBounds[3], extent[3])];
      const surfaces = new Set<AtlasSurface>();
      if (cellBounds[0] < extent[0] || cellBounds[1] < extent[1] || cellBounds[2] > extent[2] || cellBounds[3] > extent[3]) surfaces.add("outside");
      if (clipped[0] < clipped[2] && clipped[1] < clipped[3]) {
        let covered = false;
        for (const coverage of physical) {
          if (!boundsMeet(coverage.bounds, clipped)) continue;
          work += 14 * coverage.geometry.vertices.length;
          assertWorkBudget(work);
          if (polygonMeetsBounds(coverage.geometry, clipped)) surfaces.add(coverage.surface);
          if (!covered && polygonCoversBounds(coverage.geometry, clipped)) covered = true;
        }
        if (!covered) surfaces.add("unmapped");
      }
      const featureIds: string[] = [], anchorFeatureIds: string[] = [];
      for (const feature of features) {
        if (feature.geometry.kind === "polygon") {
          if (boundsMeet(feature.bounds!, cellBounds)) {
            work += 9 * feature.geometry.vertices.length;
            assertWorkBudget(work);
            if (polygonMeetsBounds(feature.geometry, cellBounds)) featureIds.push(feature.id);
          }
        } else if (inBounds(feature.geometry.position, cellBounds)) featureIds.push(feature.id);
        if (inBounds(feature.anchor, cellBounds)) anchorFeatureIds.push(feature.id);
      }
      line.push({ bounds: cellBounds, surfaces: (["land", "water", "unmapped", "outside"] as const).filter((surface) => surfaces.has(surface)), featureIds: featureIds.sort(), anchorFeatureIds: anchorFeatureIds.sort() });
    }
    cells.push(line);
  }
  return { columns, rows, bounds, cells };
}

export function selectAtlasCell(cell: AtlasCell, selectedFeatureId: string | null):
  { kind: "selected"; featureId: string } | { kind: "choose"; featureIds: readonly string[] } | { kind: "empty" } {
  if (cell.featureIds.length > MAX_ATLAS_FEATURES || cell.anchorFeatureIds.length > MAX_ATLAS_FEATURES) throw new AtlasError("BUDGET_EXCEEDED", "Atlas cell hit limit exceeded");
  const featureIds = [...new Set([...cell.featureIds, ...cell.anchorFeatureIds])].sort();
  if (featureIds.length > MAX_ATLAS_FEATURES) throw new AtlasError("BUDGET_EXCEEDED", "Atlas cell hit limit exceeded");
  if (selectedFeatureId !== null && featureIds.includes(selectedFeatureId)) return { kind: "selected", featureId: selectedFeatureId };
  if (featureIds.length === 1) return { kind: "selected", featureId: featureIds[0]! };
  return featureIds.length === 0 ? { kind: "empty" } : { kind: "choose", featureIds };
}
