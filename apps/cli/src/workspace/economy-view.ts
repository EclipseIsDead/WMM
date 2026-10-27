import { economySemantics } from "@wmm/core";
import { validateWorkspaceEconomyView } from "@wmm/wire-contracts";
import type { WorkspaceEconomyView, WorkspaceViewV1 } from "@wmm/wire-contracts";

/** Validate the read model and exact display binding. Source/input correspondence is
 * owned by the verified producer, not reconstructed from clipped World summaries. */
export function economyViewError(view: WorkspaceEconomyView, workspace?: WorkspaceViewV1["workspace"]): string | null {
  if (!validateWorkspaceEconomyView(view).valid) return "Unsupported Economy view metadata or binding; response discarded.";
  if (view.economy.worldId !== view.base.worldId || view.economy.snapshotDigest !== view.base.snapshotDigest ||
    view.economy.semanticProfileDigest !== economySemantics().profileDigest) return "Economy base/snapshot/profile binding mismatch; response discarded.";
  if (workspace && (view.workspaceId !== workspace.id || view.workspaceVersion !== workspace.version ||
    view.base.worldId !== workspace.base.worldId || view.base.snapshotDigest !== workspace.base.snapshotDigest)) return "Economy workspace/base/snapshot/version binding mismatch; response discarded.";
  return null;
}
