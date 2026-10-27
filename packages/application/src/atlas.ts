import { canonicalJson, CanonicalizationError, sha256Hex } from "@wmm/canonical";
import { admitAtlas, AtlasError, MAX_ATLAS_BYTES, MAX_ATLASES_PER_WORLD } from "@wmm/core";
import { validateWorkspaceMapView } from "@wmm/wire-contracts";
import type { Atlas, JsonValue, WorkspaceBaseV1, WorkspaceMapReadRequest, WorkspaceMapView, WorkspaceStateV1 } from "@wmm/wire-contracts";

export class WorkspaceMapError extends Error {
  constructor(readonly code: "INVALID_WORLD" | "UNKNOWN_RECORD" | "BUDGET_EXCEEDED", message: string) {
    super(message); this.name = "WorkspaceMapError";
  }
}
function invalid(message: string): never { throw new WorkspaceMapError("INVALID_WORLD", message); }

/** Exact captured assets only: no source directory, candidate compiler, or durable mutation. */
export function readWorkspaceAtlas(state: WorkspaceStateV1, base: WorkspaceBaseV1, request: WorkspaceMapReadRequest["payload"]): WorkspaceMapView {
  if (state.base.worldId !== base.world.world.worldId || state.base.worldId !== base.snapshot.manifest.worldId ||
    state.base.snapshotDigest !== base.snapshot.snapshotDigest) invalid("Captured atlas base identity does not match the workspace");
  const documents = base.documents.filter((document) => document.path.startsWith("maps/"));
  if (documents.length > MAX_ATLASES_PER_WORLD) throw new WorkspaceMapError("BUDGET_EXCEEDED", "Too many captured reference atlases");
  const definitions = new Map(base.world.definitions.map((entry) => [entry.digest, entry.body]));
  const context = {
    worldId: state.base.worldId,
    placeIds: base.world.descriptors.filter((record) => definitions.get(record.birthTypeDefinitionDigest)?.key === "place").map((record) => record.id),
    sourceIds: base.world.sources.map((record) => record.id),
  };
  const atlases: { atlas: Atlas; digest: string }[] = [];
  const ids = new Set<string>();
  for (const document of documents) {
    if (!/^maps\/[a-z][a-z0-9_-]{0,79}\.json$/.test(document.path) || document.mediaType !== "application/json") invalid("Unsupported reference atlas asset path or media type");
    if (document.base64.length > Math.ceil(MAX_ATLAS_BYTES / 3) * 4) throw new WorkspaceMapError("BUDGET_EXCEEDED", "Captured reference atlas exceeds the byte limit");
    const bytes = Buffer.from(document.base64, "base64");
    const entry = base.snapshot.manifest.files.find((file) => file.path === document.path);
    if (bytes.toString("base64") !== document.base64 || bytes.length > MAX_ATLAS_BYTES || entry === undefined ||
      entry.mediaType !== "application/json" || entry.byteLength !== String(bytes.length) || entry.sha256 !== document.sha256 || sha256Hex(bytes) !== document.sha256) invalid("Captured reference atlas bytes differ from the pinned manifest");
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(text) as unknown;
      if (canonicalJson(value as JsonValue) !== text) invalid("Captured reference atlas JSON is not canonical");
    } catch (error) {
      if (error instanceof WorkspaceMapError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof CanonicalizationError) invalid("Captured reference atlas JSON is invalid");
      throw error;
    }
    const atlas = admitAtlas(value, context);
    if (document.path !== `maps/${atlas.id}.json` || ids.has(atlas.id)) invalid("Reference atlas ID/path is inconsistent or duplicated");
    ids.add(atlas.id); atlases.push({ atlas, digest: document.sha256 });
  }
  atlases.sort((a, b) => a.atlas.id < b.atlas.id ? -1 : a.atlas.id > b.atlas.id ? 1 : 0);
  const selected = request.atlasId === undefined ? atlases[0] : atlases.find((item) => item.atlas.id === request.atlasId);
  if ((request.atlasId !== undefined && selected === undefined) ||
    (request.geometryVersion !== undefined && selected?.atlas.geometryVersion !== request.geometryVersion)) {
    throw new WorkspaceMapError("UNKNOWN_RECORD", "Requested reference atlas or fixed geometry version is not present in this captured base");
  }
  const view: WorkspaceMapView = {
    format: "wmm.workspace-map-view/1", workspaceId: state.id, workspaceVersion: state.version, base: state.base,
    worldBasis: "base", selectedProposalsIncluded: false, factProjection: "not-run", candidateView: "unavailable",
    atlas: selected?.atlas ?? null, atlasDigest: selected?.digest ?? null,
    availableAtlases: atlases.map(({ atlas }) => ({ id: atlas.id, title: atlas.title, geometryVersion: atlas.geometryVersion })),
    limitations: [
      "REFERENCE ATLAS: undated fixed reference geometry; political facts not projected.",
      "BASE WORLD: selected proposals are not shown; candidate view unavailable.",
      "Reference-pixel coordinates are not calibrated travel distances or reconstructed historical borders.",
      ...(selected === undefined ? ["No admitted reference atlas is present in the captured base."] : []),
    ],
  };
  if (!validateWorkspaceMapView(view).valid || Buffer.byteLength(canonicalJson(view as unknown as JsonValue)) > 2 * MAX_ATLAS_BYTES) {
    throw new AtlasError("BUDGET_EXCEEDED", "Reference atlas view exceeds the bounded response contract");
  }
  return view;
}
