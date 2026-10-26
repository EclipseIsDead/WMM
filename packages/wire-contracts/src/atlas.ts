/** Bounded, undated reference cartography; never a political or historical projection. */
export const MAX_ATLAS_BYTES = 1_048_576;
export const MAX_ATLASES_PER_WORLD = 8;
export const MAX_ATLAS_FEATURES = 64;
export const MAX_ATLAS_PHYSICAL_POLYGONS = 64;
export const MAX_ATLAS_RING_VERTICES = 256;
export const MAX_ATLAS_TOTAL_VERTICES = 4096;
export const MAX_ATLAS_COORDINATE = 1_000_000;

export type AtlasPoint = readonly [number, number];
export type AtlasBounds = readonly [number, number, number, number];

export interface AtlasPolygon {
  readonly kind: "polygon";
  /** Explicitly closed simple outer ring. Holes are not supported. */
  readonly vertices: readonly AtlasPoint[];
}

export type AtlasGeometry = AtlasPolygon | { readonly kind: "point"; readonly position: AtlasPoint };

export interface AtlasFeature {
  readonly id: string;
  readonly entityId: string;
  readonly label: string;
  readonly geometry: AtlasGeometry;
  /** Display/hit target only; does not enlarge geometry or physical coverage. */
  readonly anchor: AtlasPoint;
  readonly precision: "approximate" | "exact-as-authored";
  readonly locator: string;
}

export interface Atlas {
  readonly format: "wmm.map-atlas/1";
  readonly worldId: string;
  readonly id: string;
  readonly title: string;
  readonly geometryVersion: string;
  readonly temporalMeaning: "undated";
  readonly frame: {
    readonly id: string;
    readonly extent: AtlasBounds;
    readonly units: "reference-pixels";
    readonly orientation: "x-right-y-down";
  };
  readonly provenance: { readonly sourceId: string; readonly locator: string };
  readonly physicalCoverage: readonly { readonly surface: "land" | "water"; readonly geometry: AtlasPolygon }[];
  readonly features: readonly AtlasFeature[];
}

export interface WorkspaceMapReadRequest {
  readonly format: "wmm.request/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string;
  readonly operation: "workspace.map.read";
  readonly payload: {
    readonly workspaceId: string;
    readonly atlasId?: string;
    readonly geometryVersion?: string;
    readonly atVersion?: number;
  };
}

export interface WorkspaceMapView {
  readonly format: "wmm.workspace-map-view/1";
  readonly workspaceId: string;
  readonly workspaceVersion: number;
  readonly base: { readonly worldId: string; readonly snapshotDigest: string };
  readonly worldBasis: "base";
  readonly selectedProposalsIncluded: false;
  readonly factProjection: "not-run";
  readonly candidateView: "unavailable";
  readonly atlas: Atlas | null;
  /** SHA-256 of exact manifest-bound bytes, not a self hash. */
  readonly atlasDigest: string | null;
  readonly availableAtlases: readonly { readonly id: string; readonly title: string; readonly geometryVersion: string }[];
  readonly limitations: readonly string[];
}
