import { normalizeActorBrief, normalizeActorDecision } from "@wmm/core";
import { actorContextFromBundle, actorReviewFromBundle, loadReleaseWorldBundle, type RenderedActorReview } from "@wmm/exchange";
import type { ActorContextPacket } from "@wmm/wire-contracts";

/** Pure read preparation; provider calls and actor execution remain outside WMM. */
export function prepareActorContext(bundlePath: string, input: unknown): ActorContextPacket {
  const brief = normalizeActorBrief(input);
  return actorContextFromBundle(loadReleaseWorldBundle(bundlePath), brief);
}

export function reviewActorDraft(bundlePath: string, briefInput: unknown, decisionInput: unknown, destination?: string): RenderedActorReview & { readonly outputDirectory: string | null } {
  const brief = normalizeActorBrief(briefInput);
  const decision = normalizeActorDecision(decisionInput);
  const result = actorReviewFromBundle(loadReleaseWorldBundle(bundlePath), brief, decision, destination);
  return { ...result, outputDirectory: destination ?? null };
}
