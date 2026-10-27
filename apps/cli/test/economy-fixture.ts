import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthoringBundle, readEconomyView } from "@wmm/exchange";
import type { AuthoringProject, EconomyView, WorkspaceEconomyView, WorkspaceViewV1 } from "@wmm/wire-contracts";
import { workspaceFixture } from "./atlas-fixture.js";

/** The real synthetic compiler/loader projection, not hand-invented view fields. */
export function economyFixture(transform: (project: AuthoringProject) => AuthoringProject = project => project): EconomyView {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-ui-"));
  try {
    const project = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url), "utf8")) as AuthoringProject;
    return readEconomyView(buildAuthoringBundle(transform(project), join(root, "bundle")));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function economyWorkspaceFixture(economy = economyFixture()): { initial: WorkspaceViewV1; result: WorkspaceEconomyView } {
  const old = workspaceFixture();
  const base = { worldId: economy.worldId, snapshotDigest: economy.snapshotDigest };
  const initial = { ...old, workspace: { ...old.workspace, base } };
  return { initial, result: { format: "wmm.workspace-economy-view/1", workspaceId: initial.workspace.id, workspaceVersion: initial.workspace.version, base,
    worldBasis: "base", selectedProposalsIncluded: false, candidateView: "unavailable", economy,
    limitations: ["Selected proposals are excluded; captured base only.", "SERVICE-ECONOMY-LIMITATION-END"],
  } };
}
