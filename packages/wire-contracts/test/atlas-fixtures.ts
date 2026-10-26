import type { Atlas, AtlasBounds, AtlasPolygon, WorkspaceMapView } from "../src/index.js";

export function rectangle(bounds: AtlasBounds): AtlasPolygon {
  const [x0, y0, x1, y1] = bounds;
  return { kind: "polygon", vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] };
}

export function referenceAtlas(): Atlas {
  return {
    format: "wmm.map-atlas/1", worldId: "world:atlas_test", id: "overview", title: "Reference coast", geometryVersion: "trace-1", temporalMeaning: "undated",
    frame: { id: "reference", extent: [0, 0, 100, 100], units: "reference-pixels", orientation: "x-right-y-down" },
    provenance: { sourceId: "source:map", locator: "Synthetic source: outline" },
    physicalCoverage: [{ surface: "land", geometry: rectangle([0, 0, 40, 100]) }, { surface: "water", geometry: rectangle([40, 0, 60, 100]) }],
    features: [{ id: "harbor", entityId: "place:harbor", label: "Harbor reference", geometry: rectangle([1, 1, 3, 3]), anchor: [70, 70], precision: "approximate", locator: "Outline A" }],
  };
}

export function mapView(atlas: Atlas | null = referenceAtlas()): WorkspaceMapView {
  return {
    format: "wmm.workspace-map-view/1", workspaceId: "workspace:reference", workspaceVersion: 1,
    base: { worldId: "world:atlas_test", snapshotDigest: "a".repeat(64) },
    worldBasis: "base", selectedProposalsIncluded: false, factProjection: "not-run", candidateView: "unavailable",
    atlas, atlasDigest: atlas === null ? null : "b".repeat(64),
    availableAtlases: atlas === null ? [] : [{ id: atlas.id, title: atlas.title, geometryVersion: atlas.geometryVersion }],
    limitations: ["Undated outlines; political facts not projected.", "Selected proposals are not shown."],
  };
}

export function mapResponse(data: WorkspaceMapView = mapView()): unknown {
  return { format: "wmm.response/1", apiVersion: "wmm/1", requestId: "map-read", operation: "workspace.map.read", outcome: "success", execution: "completed", resolved: data.base, data, diagnostics: [] };
}
