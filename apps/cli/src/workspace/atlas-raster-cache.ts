import { atlasSurfaceAt, projectAtlasGrid } from "@wmm/core";
import type { AtlasGrid, AtlasSurface } from "@wmm/core";
import { validateAtlas } from "@wmm/wire-contracts";
import type { Atlas, AtlasBounds, AtlasPoint } from "@wmm/wire-contracts";

export const MAX_CACHED_ATLAS_RASTERS = 4;
export const MAX_CACHED_ATLAS_SURFACES = 64;
interface Raster { readonly atlas: Atlas; readonly stamp: string | null; readonly key: string; readonly grid: AtlasGrid }
interface Surface { readonly atlas: Atlas; readonly stamp: string | null; readonly key: string; readonly value: AtlasSurface }
function deeplyFrozen(value: unknown): boolean {
  return value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Client-local LRU only. Nothing is persisted and no wire/semantic identity changes.
 * Admitted deeply frozen snapshots use identity; mutable embedding inputs are
 * preflighted and fingerprinted so an in-place edit cannot retrieve stale hits.
 */
export class AtlasRasterCache {
  private readonly immutable = new WeakSet<Atlas>();
  private readonly rasters: Raster[] = [];
  private readonly surfaces: Surface[] = [];
  private rasterizations = 0;
  private cacheHits = 0;
  private stamp(atlas: Atlas): string | null | undefined {
    if (this.immutable.has(atlas)) return null;
    // Never stringify an unvalidated getter/proxy supplied by an embedding client.
    if (!validateAtlas(atlas).valid) return undefined;
    if (deeplyFrozen(atlas)) { this.immutable.add(atlas); return null; }
    return JSON.stringify(atlas);
  }
  project(atlas: Atlas, options: { columns: number; rows: number; bounds: AtlasBounds }): AtlasGrid {
    const stamp = this.stamp(atlas);
    if (stamp === undefined) return projectAtlasGrid(atlas, options); // Preserve core error classification.
    const key = JSON.stringify([options.columns, options.rows, options.bounds]);
    const index = this.rasters.findIndex(item => item.atlas === atlas && item.stamp === stamp && item.key === key);
    if (index >= 0) {
      const item = this.rasters.splice(index, 1)[0]!; this.rasters.push(item); this.cacheHits += 1; return item.grid;
    }
    const grid = freeze(projectAtlasGrid(atlas, options));
    this.rasterizations += 1;
    this.rasters.push({ atlas, stamp, key, grid });
    if (this.rasters.length > MAX_CACHED_ATLAS_RASTERS) this.rasters.shift();
    return grid;
  }
  surface(atlas: Atlas, point: AtlasPoint): AtlasSurface {
    const stamp = this.stamp(atlas);
    if (stamp === undefined) return atlasSurfaceAt(atlas, point);
    const key = JSON.stringify(point);
    const index = this.surfaces.findIndex(item => item.atlas === atlas && item.stamp === stamp && item.key === key);
    if (index >= 0) { const item = this.surfaces.splice(index, 1)[0]!; this.surfaces.push(item); return item.value; }
    const value = atlasSurfaceAt(atlas, point);
    this.surfaces.push({ atlas, stamp, key, value });
    if (this.surfaces.length > MAX_CACHED_ATLAS_SURFACES) this.surfaces.shift();
    return value;
  }
  stats(): { readonly rasterizations: number; readonly cacheHits: number; readonly rasterEntries: number; readonly surfaceEntries: number } {
    return { rasterizations: this.rasterizations, cacheHits: this.cacheHits, rasterEntries: this.rasters.length, surfaceEntries: this.surfaces.length };
  }
}
