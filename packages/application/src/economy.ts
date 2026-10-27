import { CanonicalizationError } from "@wmm/canonical";
import { AdmissionError, economySemantics, verifyCapturedWorkspaceBase, WorldValidationError } from "@wmm/core";
import { loadReleaseWorldBundle, readEconomyView, WorldBundleError, type AuthoringPresentationBundle } from "@wmm/exchange";
import type { EconomyView, WorkspaceBaseV1, WorkspaceEconomyView, WorkspaceStateV1 } from "@wmm/wire-contracts";

/** Verified direct-snapshot DM read; no workspace, candidate, review or source citation I/O. */
export function readSnapshotEconomy(bundlePath: string): EconomyView {
  return economyReadBoundary(() => readEconomyView(loadReleaseWorldBundle(bundlePath)));
}

function economyReadBoundary<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof CanonicalizationError ||
      error instanceof WorldValidationError || error instanceof AdmissionError) {
      throw new WorldBundleError("INVALID_WORLD", error.message, { cause: error });
    }
    throw error;
  }
}

/** Reconstruct only verified retained data. No directory, citation path, candidate or review. */
export function readWorkspaceEconomy(state: WorkspaceStateV1, input: WorkspaceBaseV1): WorkspaceEconomyView {
  return economyReadBoundary(() => {
    // Release-owned host policy, not authority inferred from the captured profile.
    // Keep the verifier's existing default work budget; never retry with a larger ceiling.
    const base = verifyCapturedWorkspaceBase(input, {
      worldId: state.base.worldId, snapshotDigest: state.base.snapshotDigest,
      semanticProfileDigest: economySemantics().profileDigest,
    });
    const world = base.world;
    const presentation: AuthoringPresentationBundle = {
      snapshot: base.snapshot, world: world.world, semanticProfile: world.semanticProfile,
      definitionsByDigest: Object.fromEntries(world.definitions.map(({ digest, body }) => [digest, body])),
      rosters: world.rosters, descriptors: world.descriptors, sources: world.sources,
      assertions: world.assertions, supports: world.supports,
      documents: base.documents.map(({ path, mediaType, sha256, base64 }) => ({
        path, mediaType, sha256, bytes: new Uint8Array(Buffer.from(base64, "base64")),
      })),
    };
    return {
      format: "wmm.workspace-economy-view/1", workspaceId: state.id, workspaceVersion: state.version,
      base: { worldId: base.snapshot.manifest.worldId, snapshotDigest: base.snapshot.snapshotDigest },
      worldBasis: "base", selectedProposalsIncluded: false, candidateView: "unavailable",
      // The exchange adapter owns complete retained-payload/captured-project correspondence.
      economy: readEconomyView(presentation),
      limitations: [
        "BASE WORLD: selected proposals are excluded; candidate view unavailable.",
        "DM-side authored declarations only. Accounting and scenarios have not run; no approval or canon change.",
      ],
    };
  });
}
