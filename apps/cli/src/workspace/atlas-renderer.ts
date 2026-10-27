import type { Atlas, AtlasPoint, WorkspaceMapView } from "@wmm/wire-contracts";
import type { AtlasCell, AtlasGrid } from "@wmm/core";
import type { AtlasPaint } from "./atlas-shader.js";
import type { WorkspaceUiState } from "./controller.js";
import { atlasViewError } from "./atlas-view.js";
import { AtlasRasterCache } from "./atlas-raster-cache.js";
import { ellipsis, fit, viewport, wrap } from "./text.js";
export { shadeAtlasGrid } from "./atlas-shader.js";

const featureGlyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$%";
const rasterCache = new AtlasRasterCache();
export const atlasRasterStats = (): ReturnType<AtlasRasterCache["stats"]> => rasterCache.stats();
function featureCodes(atlas: Atlas): ReadonlyMap<string, string> {
  return new Map([...atlas.features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((feature, index) => [feature.id, featureGlyphs[index] ?? "+"]));
}
function surfaceGlyph(cell: AtlasCell): string {
  if (cell.surfaces.includes("unmapped") || cell.surfaces.length === 0) return "?";
  if (cell.surfaces.length > 1) return "#";
  return cell.surfaces[0] === "land" ? "." : cell.surfaces[0] === "water" ? "~" : " ";
}
export interface AtlasRenderOptions {
  readonly layer: "reference" | "physical";
  readonly selectedFeatureId: string | null;
  readonly cursorCell?: readonly [number, number];
}
/** Presentation only: hit targets and coverage remain the unchanged core grid. */
export function renderAtlasGrid(atlas: Atlas, grid: AtlasGrid, options: AtlasRenderOptions): string[] {
  const codes = featureCodes(atlas);
  return grid.cells.map((row, y) => row.map((cell, x) => {
    if (options.cursorCell && options.cursorCell[0] === x && options.cursorCell[1] === y) return "@";
    const targets = [...new Set([...cell.featureIds, ...cell.anchorFeatureIds])];
    if (options.layer === "reference" && targets.length > 1) return "+";
    if (options.selectedFeatureId && cell.anchorFeatureIds.includes(options.selectedFeatureId)) return "@";
    if (options.layer === "reference" && targets.length === 1) return codes.get(targets[0]!) ?? "+";
    return surfaceGlyph(cell);
  }).join(""));
}

/** Only call after checking the service-supplied mode metadata. */
export function atlasTruthLines(): string[] {
  return ["REFERENCE ATLAS", "Undated outlines; political facts not projected.", "BASE WORLD | Selected proposals are not shown.", "Candidate view unavailable."];
}
function bindingLines(view: WorkspaceMapView): string[] {
  return [`Workspace id: ${view.workspaceId}`, `Workspace version: ${view.workspaceVersion}`, `Base world: ${view.base.worldId}`, `Base snapshot: ${view.base.snapshotDigest}`];
}

function dimensions(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1 || columns > 160 || rows > 60) throw new RangeError("Atlas raster dimensions must be integers: columns 1..160, rows 1..60.");
}
/** A terminal cell is nominally twice as tall as wide; padding is not geography. */
export function projectAtlasViewport(atlas: Atlas, columns: number, rows: number): AtlasGrid {
  dimensions(columns, rows);
  const [x0, y0, x1, y1] = atlas.frame.extent;
  const step = Math.max((x1 - x0) / columns, (y1 - y0) / (rows * 2));
  const width = step * columns;
  const height = step * rows * 2;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;
  return rasterCache.project(atlas, { columns, rows, bounds: [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2] });
}
export function atlasLayout(width: number, height: number): { readonly mapWidth: number; readonly mapRows: number; readonly inspectorWidth: number } {
  const inspectorWidth = width >= 99 ? Math.max(30, Math.floor((width - 3) * 0.32)) : 0;
  return { mapWidth: width - (inspectorWidth ? inspectorWidth + 3 : 0), mapRows: Math.max(1, Math.min(60, height - 8)), inspectorWidth };
}
export function atlasCellPosition(grid: AtlasGrid, point: AtlasPoint): readonly [number, number] {
  return [Math.max(0, Math.min(grid.columns - 1, Math.floor((point[0] - grid.bounds[0]) * grid.columns / (grid.bounds[2] - grid.bounds[0])))),
    Math.max(0, Math.min(grid.rows - 1, Math.floor((point[1] - grid.bounds[1]) * grid.rows / (grid.bounds[3] - grid.bounds[1]))))];
}

const legend = ["LEGEND / REFERENCE GEOMETRY", ". recorded land | ~ recorded water | ? unmapped or uncertain coverage", "# mixed physical coverage (not an inferred coastline) | blank: outside frame",
  "+ multiple geometry/anchor references, not a political conflict | @ selected anchor/cursor", "Letter/digit codes: authored reference features, not governing actors.", "Anchor markers are not area; they never enlarge geometry or physical coverage."];
function atlasMetadata(view: WorkspaceMapView): string[] {
  const atlas = view.atlas;
  if (!atlas) return ["No reference atlas in the captured base world.", ...bindingLines(view)];
  return [`Atlas: ${atlas.title}`, `Atlas id: ${atlas.id}`, `Geometry version: ${atlas.geometryVersion}`, `Atlas digest (service-bound bytes): ${view.atlasDigest}`,
    `Frame: ${atlas.frame.id}`, `Extent: [${atlas.frame.extent.join(", ")}]`, `Units: ${atlas.frame.units}; orientation: ${atlas.frame.orientation}`,
    `Atlas source: ${atlas.provenance.sourceId}`, `Atlas source locator: ${atlas.provenance.locator}`, ...bindingLines(view),
    "Rule / effective control / influence: not projected.", "Query date/scope: unavailable; outlines are undated.", "Reference pixels are not calibrated travel distances.", "", "SERVICE LIMITATIONS", ...view.limitations];
}
function featureLines(view: WorkspaceMapView, featureId: string | null): string[] {
  const atlas = view.atlas;
  const feature = atlas?.features.find(item => item.id === featureId);
  if (!atlas || !feature) return ["No semantic feature selected."];
  return [`Feature: ${feature.label}`, "Authored atlas label; not a canonical-name or ownership claim.", `Entity reference: ${feature.entityId}`, `Feature id: ${feature.id}`,
    `Geometry reference: ${atlas.id}/${atlas.geometryVersion}/${feature.id}`, `Geometry kind: ${feature.geometry.kind}`, `Precision: ${feature.precision}`,
    `Anchor: [${feature.anchor.join(", ")}] (display target, not area)`, `Physical coverage at anchor: ${rasterCache.surface(atlas, feature.anchor)}`,
    `Feature source locator: ${feature.locator}`, `Source reference: ${atlas.provenance.sourceId}`, "Related places/relationships: not supplied by this map read."];
}
const prose = (lines: readonly string[], width: number): string[] => lines.flatMap(line => wrap(line, width));

export function atlasInspectorLines(view: WorkspaceMapView, featureId: string | null, width: number): string[] {
  return prose([...atlasTruthLines(), "", ...featureLines(view, featureId), "", ...atlasMetadata(view), "", ...legend, "", "FEATURE DIRECTORY (stable ids; every feature is discoverable)",
    ...[...view.atlas?.features ?? []].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(feature => `${featureCodes(view.atlas!).get(feature.id)} ${feature.label} | ${feature.id} | ${feature.entityId}`)], width);
}

/** Linear, non-color, fixed-default output. Never reads or changes a workspace. */
export function renderAtlasPlain(view: WorkspaceMapView, columns = 72, rows = 18): string {
  dimensions(columns, rows);
  const error = atlasViewError(view);
  if (error) return `REFERENCE ATLAS UNAVAILABLE\n${error}`;
  const heading = prose([...atlasTruthLines(), "", ...atlasMetadata(view)], 100);
  if (!view.atlas) return [...heading, "", ...prose(["SERVICE LIMITATIONS", ...view.limitations], 100)].join("\n");
  const grid = projectAtlasViewport(view.atlas, columns, rows);
  const directory = [...view.atlas.features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).flatMap(feature => ["", `${featureCodes(view.atlas!).get(feature.id)} / REFERENCE FEATURE`, ...featureLines(view, feature.id)]);
  // Structured grid rows intentionally bypass every prose wrapping helper.
  return [...heading, "", `ASCII GRID (${columns}x${rows})`, ...renderAtlasGrid(view.atlas, grid, { layer: "reference", selectedFeatureId: null }), "END ASCII GRID", "", ...prose([...legend, ...directory], 100)].join("\n");
}

export function renderAtlasBody(state: WorkspaceUiState, height: number, width: number, reportLimit?: (limit: number) => void, reportPaint?: (paint: AtlasPaint) => void): string[] {
  const { view, error } = state.atlas;
  const bindingError = view ? atlasViewError(view, state.view.workspace) : null;
  if (error || bindingError || !view) return viewport(prose(["MAP UNAVAILABLE / READ-ONLY", error ?? bindingError ?? "No map read has completed.", "m: return to World; re-open to read again. No workspace changes."], width), state.scroll, height, width, reportLimit);
  if (state.detail && state.raw) return viewport(prose(["RAW MAP PAYLOAD / SECONDARY INSPECTION", JSON.stringify(view, null, 2)], width), state.scroll, height, width, reportLimit);
  if (!view.atlas) return viewport(prose([...atlasTruthLines(), "", ...atlasMetadata(view), "", ...view.limitations], width), state.scroll, height, width, reportLimit);
  if (state.atlas.chooser) {
    const chooser = state.atlas.chooser;
    const options = chooser.featureIds.map((id, i) => `${i === chooser.focused ? ">" : " "} ${view.atlas!.features.find(feature => feature.id === id)?.label ?? id} | ${id}`);
    return viewport(prose(["CHOOSE REFERENCE FEATURE", "Geometry and display-anchor references; no draw-order winner.", ...options, "", "Up/Down: choose | Enter: inspect | Esc: cancel"], width), Math.max(state.scroll, chooser.focused - height + 5), height, width, reportLimit);
  }
  if (state.detail) return viewport(atlasInspectorLines(view, state.atlas.selectedFeatureId, width), state.scroll, height, width, reportLimit);
  const layout = atlasLayout(width, height);
  try {
    const grid = projectAtlasViewport(view.atlas, Math.min(160, layout.mapWidth), layout.mapRows);
    const selected = view.atlas.features.find(item => item.id === state.atlas.selectedFeatureId);
    const cursorCell = state.atlas.canvasFocus && state.atlas.cursor ? atlasCellPosition(grid, state.atlas.cursor) : undefined;
    const cell = cursorCell ? grid.cells[cursorCell[1]]![cursorCell[0]]! : null;
    const targets = cell ? [...new Set([...cell.featureIds, ...cell.anchorFeatureIds])] : [];
    const cellLines = cell ? ["CELL CONTENTS / NOT SEMANTIC SELECTION", `Bounds: [${cell.bounds.join(", ")}]`, `Physical coverage: ${cell.surfaces.join(" / ")}`, targets.length ? `Selectable references: ${targets.join(", ")}` : "Empty cell: no feature or display anchor here.",
      `Geometry references: ${cell.featureIds.join(", ") || "none"}`, `Anchor-only display references: ${cell.anchorFeatureIds.filter(id => !cell.featureIds.includes(id)).join(", ") || "none"}`,
      `Persistent semantic selection (separate from this cell): ${selected?.label ?? "none"}`] : null;
    const options: AtlasRenderOptions = { layer: state.atlas.layer, selectedFeatureId: state.atlas.selectedFeatureId, ...(cursorCell ? { cursorCell } : {}) };
    const glyphs = renderAtlasGrid(view.atlas, grid, options);
    reportPaint?.({ atlas: view.atlas, grid, glyphs, options, row: 4 });
    const left = [ellipsis(`REFERENCE ATLAS | ${view.atlas.title}`, layout.mapWidth), ...atlasTruthLines().slice(1),
      ...glyphs,
      ". land ~ water ? unknown # mixed; blank outside frame",
      "+ multiple refs (not conflict); @ anchor (not area)",
      ellipsis(cell ? `Cell: ${targets.length ? targets.join(", ") : "empty"}; selection separate: ${selected?.label ?? "none"}` : `Selected: ${selected?.label ?? "none"} | ${state.atlas.layer} layer`, layout.mapWidth),
      state.atlas.canvasFocus ? "CANVAS: arrows/hjkl move | Enter: cell | f/Esc: features" : "j/k: feature | f: canvas | Enter: inspect"];
    if (!layout.inspectorWidth) { reportLimit?.(0); return left.map(line => ellipsis(line, width)); }
    const right = viewport(prose([state.inspectorFocus ? "INSPECTOR (focused; Left: map)" : "INSPECTOR (Right: scroll)", ...(cellLines ?? featureLines(view, state.atlas.selectedFeatureId)), "", ...atlasMetadata(view)], layout.inspectorWidth), state.scroll, height, layout.inspectorWidth, reportLimit);
    return Array.from({ length: height }, (_, i) => `${fit(left[i] ?? "", layout.mapWidth)} | ${fit(right[i] ?? "", layout.inspectorWidth)}`);
  } catch (failure) {
    return viewport(prose(["REFERENCE ATLAS UNAVAILABLE", failure instanceof Error ? failure.message : String(failure), "No geography inferred; no workspace changes."], width), state.scroll, height, width, reportLimit);
  }
}
