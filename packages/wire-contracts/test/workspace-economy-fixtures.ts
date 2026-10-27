import type { EconomyView, WorkspaceEconomyView } from "../src/index.js";

export function workspaceEconomyView(): WorkspaceEconomyView {
  const economy: EconomyView = {
    format: "wmm.economy-view/1", worldId: "world:grain", snapshotDigest: "a".repeat(64),
    semanticProfileDigest: "b".repeat(64), inputDigest: "c".repeat(64), perspective: "dm",
    accounting: "not-run", scenarios: "not-run", records: [], entities: [], sources: [], axes: [], limitations: [],
  };
  return {
    format: "wmm.workspace-economy-view/1", workspaceId: "workspace:grain", workspaceVersion: 1,
    base: { worldId: economy.worldId, snapshotDigest: economy.snapshotDigest }, worldBasis: "base",
    selectedProposalsIncluded: false, candidateView: "unavailable", economy, limitations: [],
  } as const;
}

export function workspaceEconomyResponse(data: unknown = workspaceEconomyView()) {
  return {
    format: "wmm.response/1", apiVersion: "wmm/1", requestId: "economy-read", operation: "workspace.economy.read",
    outcome: "success", execution: "completed", resolved: workspaceEconomyView().base, data, diagnostics: [],
  } as const;
}
