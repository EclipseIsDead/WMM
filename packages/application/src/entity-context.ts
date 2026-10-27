import { normalizeEntityContextRequest } from "@wmm/core";
import { entityContextFromBundle, loadReleaseWorldBundle } from "@wmm/exchange";
import type { EntityContextPacket } from "@wmm/wire-contracts";

/** Opt-in read projection; no workspace storage, provider, or state-changing operation. */
export function getEntityContext(bundlePath: string, input: unknown): EntityContextPacket {
  // Reject malformed requests before opening the world, and retain a detached request across loading.
  const request = normalizeEntityContextRequest(input);
  return entityContextFromBundle(loadReleaseWorldBundle(bundlePath), {
    entityId: request.entityId, limits: request.limits,
    ...(request.campaignId === null ? {} : { campaignId: request.campaignId }),
  });
}
