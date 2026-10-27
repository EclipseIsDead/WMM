import { describe, expect, it } from "vitest";
import { admitAtlas } from "@wmm/core";
import { AtlasRasterCache, MAX_CACHED_ATLAS_RASTERS, MAX_CACHED_ATLAS_SURFACES } from "../src/workspace/atlas-raster-cache.js";
import { atlasFixture } from "./atlas-fixture.js";
const options = { columns: 10, rows: 6, bounds: [0, 0, 100, 60] as const };

describe("bounded transient atlas raster cache", () => {
  it("reuses immutable geometry and does not expose mutable cached cell hits", () => {
    const input = atlasFixture();
    const atlas = admitAtlas(input, { worldId: input.worldId, placeIds: input.features.map(feature => feature.entityId), sourceIds: [input.provenance.sourceId] });
    const cache = new AtlasRasterCache(), grid = cache.project(atlas, options);
    expect(cache.project(atlas, options)).toBe(grid);
    expect(Object.isFrozen(grid.cells[0]![0]!.featureIds)).toBe(true);
    expect(Object.isFrozen(grid.cells[0]![0]!.bounds)).toBe(true);
    expect(cache.stats()).toMatchObject({ rasterizations: 1, cacheHits: 1, rasterEntries: 1 });
    expect(Object.isFrozen(input)).toBe(false);
  });
  it("invalidates changed mutable geometry/version/bounds instead of returning stale cells", () => {
    const atlas = atlasFixture(), cache = new AtlasRasterCache();
    const before = cache.project(atlas, options);
    Object.assign(atlas.features[1]!.geometry, { position: [1, 1] });
    const changed = cache.project(atlas, options);
    expect(changed).not.toBe(before);
    expect(changed.cells[0]![0]!.featureIds).toContain("islet");
    expect(before.cells[0]![0]!.featureIds).not.toContain("islet");
    Object.assign(atlas, { geometryVersion: "other-reference" });
    expect(cache.project(atlas, options)).not.toBe(changed);
    expect(cache.project(atlas, { ...options, bounds: [0, 0, 50, 30] })).not.toBe(changed);
  });
  it("evicts old rasters and point probes within explicit process-local bounds", () => {
    const atlas = atlasFixture(), cache = new AtlasRasterCache(), first = cache.project(atlas, options);
    for (let i = 1; i <= MAX_CACHED_ATLAS_RASTERS; i++) cache.project(atlas, { ...options, columns: options.columns + i });
    expect(cache.stats().rasterEntries).toBe(MAX_CACHED_ATLAS_RASTERS);
    expect(cache.project(atlas, options)).not.toBe(first);
    for (let i = 0; i <= MAX_CACHED_ATLAS_SURFACES; i++) cache.surface(atlas, [i, 1]);
    expect(cache.stats().surfaceEntries).toBe(MAX_CACHED_ATLAS_SURFACES);
    expect(cache.surface(atlas, [1, 1])).toBe("land");
  });
  it("preserves core admission errors and never stringifies accessor input", () => {
    const atlas = atlasFixture(), cache = new AtlasRasterCache();
    cache.project(atlas, options);
    let calls = 0;
    Object.defineProperty(atlas.frame, "extent", { get: () => { calls++; return [0, 0, 100, 60]; } });
    expect(() => cache.project(atlas, options)).toThrow();
    expect(calls).toBe(0);
    const huge = atlasFixture();
    Object.assign(huge, { features: Array.from({ length: 65 }, (_, i) => ({ ...huge.features[0], id: `feature_${i}` })) });
    expect(() => cache.project(huge, options)).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
  });
});
