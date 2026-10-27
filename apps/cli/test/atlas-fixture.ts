import type { Atlas, WorkspaceMapView, WorkspaceViewV1 } from "@wmm/wire-contracts";

/** Synthetic only: no imported setting material. */
export function atlasFixture(): Atlas {
  return {
    format: "wmm.map-atlas/1", worldId: "world:atlas-test", id: "overview", title: "Example reference sheet", geometryVersion: "survey-one",
    temporalMeaning: "undated", frame: { id: "sheet", extent: [0, 0, 100, 60], units: "reference-pixels", orientation: "x-right-y-down" },
    provenance: { sourceId: "source:survey", locator: "Reference sheet, figure 1" },
    physicalCoverage: [{ surface: "land", geometry: { kind: "polygon", vertices: [[0, 0], [60, 0], [60, 60], [0, 60], [0, 0]] } },
      { surface: "water", geometry: { kind: "polygon", vertices: [[60, 0], [100, 0], [100, 60], [60, 60], [60, 0]] } }],
    features: [
      { id: "upland", entityId: "place:upland", label: "Example Upland", geometry: { kind: "polygon", vertices: [[5, 5], [50, 5], [50, 50], [5, 50], [5, 5]] }, anchor: [25, 25], precision: "approximate", locator: "Upland outline" },
      { id: "islet", entityId: "place:islet", label: "Tiny Islet", geometry: { kind: "point", position: [81, 30] }, anchor: [80, 25], precision: "exact-as-authored", locator: "Islet marker" },
    ],
  };
}
export function workspaceFixture(): WorkspaceViewV1 {
  return {
    format: "wmm.workspace-view/1",
    workspace: { format: "wmm.workspace/1", id: "atlas-workspace", version: 7, title: "Reference inspection", worldTitle: "Synthetic World", goal: "Inspect the captured reference", mode: "world",
      base: { worldId: "world:atlas-test", snapshotDigest: "b".repeat(64) }, direction: "No edits", history: [], pins: [],
      proposals: [{ id: "selected-proposal", version: 1, title: "Selected prose is not mapped", author: "Author", rationale: "Not map input", dependencies: [], exclusions: [],
        operations: [{ kind: "write-prose", path: "prose/example.md", beforeSha256: "a".repeat(64), text: "Not a territorial fact." }], decision: "selected", rejectionReason: null }],
    },
    documents: [{ path: "prose/example.md", text: "Base text", sha256: "a".repeat(64), truncated: false }],
    records: [{ id: "place:upland", kind: "entity", title: "Canonical place name", summary: "A place descriptor, not an owner." }],
    changes: [], prerequisites: [], selection: { requested: ["selected-proposal"], required: [], missing: [], rejectedRequired: [], diagnostics: [] },
    validation: { status: "not-run", message: "Historical validation unavailable." }, approval: "unavailable", canon: "unchanged",
  };
}
export function mapFixture(atlas: Atlas | null = atlasFixture()): WorkspaceMapView {
  const workspace = workspaceFixture().workspace;
  return {
    format: "wmm.workspace-map-view/1", workspaceId: workspace.id, workspaceVersion: workspace.version, base: workspace.base,
    worldBasis: "base", selectedProposalsIncluded: false, factProjection: "not-run", candidateView: "unavailable",
    atlas, atlasDigest: atlas ? "c".repeat(64) : null,
    availableAtlases: atlas ? [{ id: atlas.id, title: atlas.title, geometryVersion: atlas.geometryVersion }] : [],
    limitations: ["Reference geometry only; no calibrated distance or historical borders.", "SERVICE-LIMITATION-END"],
  };
}
