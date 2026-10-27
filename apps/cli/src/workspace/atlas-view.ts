import type { WorkspaceMapView, WorkspaceViewV1 } from "@wmm/wire-contracts";

const digest = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Bind service metadata, not a second geometry/world validator. */
export function atlasViewError(view: WorkspaceMapView, workspace?: WorkspaceViewV1["workspace"], request?: { readonly atlasId?: string; readonly geometryVersion?: string }): string | null {
  if (view.format !== "wmm.workspace-map-view/1" || view.worldBasis !== "base" || view.selectedProposalsIncluded !== false ||
    view.factProjection !== "not-run" || view.candidateView !== "unavailable") return "Unsupported map view metadata; reference atlas unavailable.";
  if (!Number.isSafeInteger(view.workspaceVersion) || view.workspaceVersion < 0 || !digest(view.base?.snapshotDigest)) return "Invalid map view binding.";
  if (workspace && (view.workspaceId !== workspace.id || view.workspaceVersion !== workspace.version ||
    view.base.worldId !== workspace.base.worldId || view.base.snapshotDigest !== workspace.base.snapshotDigest)) return "Map workspace/base/snapshot/version binding mismatch; response discarded.";
  if (view.atlas === null) return view.atlasDigest === null && view.availableAtlases.length === 0 && !request?.atlasId && !request?.geometryVersion
    ? null : "Map atlas/catalog binding mismatch.";
  const atlas = view.atlas;
  if (atlas.format !== "wmm.map-atlas/1" || atlas.temporalMeaning !== "undated" || atlas.worldId !== view.base.worldId || !digest(view.atlasDigest) ||
    !view.availableAtlases.some(item => item.id === atlas.id && item.geometryVersion === atlas.geometryVersion && item.title === atlas.title) ||
    (request?.atlasId !== undefined && atlas.id !== request.atlasId) ||
    (request?.geometryVersion !== undefined && atlas.geometryVersion !== request.geometryVersion)) return "Map atlas/geometry binding mismatch; response discarded.";
  return null;
}
