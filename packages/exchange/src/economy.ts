import { buildEconomyView } from "@wmm/core";
import type { EconomyView } from "@wmm/wire-contracts";
import { verifyAuthoringBundlePresentation, type AuthoringPresentationBundle } from "./dm-notes.js";

/** Values are admitted assertions; labels/citation presentation require compiler correspondence. */
export function readEconomyView(input: AuthoringPresentationBundle): EconomyView {
  const { bundle, index, project } = verifyAuthoringBundlePresentation(input);
  return buildEconomyView({ snapshotDigest: bundle.snapshot.snapshotDigest, world: bundle.world, index, assertions: bundle.assertions, project });
}
