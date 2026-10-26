import { authoringSemantics, buildEntityContext, EntityContextError, normalizeEntityContextRequest } from "@wmm/core";
import type { EntityContextPacket } from "@wmm/wire-contracts";

import { readAuthoringIndex } from "./dm-notes.js";
import type { LoadedWorldBundle } from "./world-bundle.js";

/** Authoring correspondence prevents stale presentation metadata from becoming harness context. */
export function entityContextFromBundle(bundle: LoadedWorldBundle, request: unknown): EntityContextPacket {
  const normalized = normalizeEntityContextRequest(request);
  if (bundle.world.semanticProfileDigest !== authoringSemantics().profileDigest) {
    throw new EntityContextError("UNSUPPORTED_CONTEXT_WORLD", "Entity context currently requires an authored WMM bundle");
  }
  const index = readAuthoringIndex(bundle);
  return buildEntityContext({
    snapshotDigest: bundle.snapshot.snapshotDigest, world: bundle.world, index,
    assertions: bundle.assertions, documents: bundle.documents,
  }, { entityId: normalized.entityId, limits: normalized.limits, ...(normalized.campaignId === null ? {} : { campaignId: normalized.campaignId }) });
}
