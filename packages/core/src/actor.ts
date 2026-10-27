import { canonicalJsonBytes, framedJsonDigest } from "@wmm/canonical";
import type { ActorBasis, ActorBasisRecord, ActorBrief, ActorContextBody, ActorContextPacket, ActorDecisionDraft, ActorDecisionReview, AuthoringCitation, AuthoringContext, JsonValue } from "@wmm/wire-contracts";
import { validateActorBrief, validateActorContextPacket, validateActorDecisionDraft, validateActorDecisionReview } from "@wmm/wire-contracts";

import { authoringScope } from "./authoring.js";
import { authoringSemantics } from "./authoring-semantics.js";
import type { EntityContextInput } from "./entity-context.js";
import { compareScope } from "./scope.js";

export const MAX_ACTOR_INPUT_BYTES = 262144;
export const ACTOR_CONTEXT_LIMITS = Object.freeze({ maxBytes: 65536, maxItems: 64 });
export const MAX_ACTOR_REVIEW_BYTES = 1048576;
export class ActorWorkflowError extends TypeError {
  constructor(readonly code: "INVALID_ACTOR_COMMAND" | "INVALID_ACTOR_BRIEF" | "STALE_ACTOR_BRIEF" | "UNKNOWN_ACTOR" | "UNKNOWN_ACTOR_CAMPAIGN" | "INVALID_ACTOR_BASIS" | "UNSUPPORTED_ACTOR_WORLD" | "ACTOR_BUDGET_EXCEEDED" | "INVALID_ACTOR_DECISION" | "STALE_ACTOR_DECISION" | "UNKNOWN_DECISION_BASIS", message: string) {
    super(message); this.name = "ActorWorkflowError";
  }
}
export function normalizeActorBrief(input: unknown): ActorBrief {
  const validation = validateActorBrief(input);
  if (!validation.valid) throw new ActorWorkflowError("INVALID_ACTOR_BRIEF", `Invalid actor brief: ${JSON.stringify(validation.errors)}`);
  const bytes = canonicalJsonBytes(input as JsonValue);
  if (bytes.length > MAX_ACTOR_INPUT_BYTES) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Actor brief exceeds its input byte budget");
  const brief = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ActorBrief;
  if (brief.question.trim().length === 0 || brief.items.some((item) => item.text.trim().length === 0)) throw new ActorWorkflowError("INVALID_ACTOR_BRIEF", "Actor question and item text must not be blank");
  if (new Set(brief.items.map((item) => item.id)).size !== brief.items.length) throw new ActorWorkflowError("INVALID_ACTOR_BRIEF", "Actor item IDs must be unique");
  return brief;
}
function invalidBasis(): never { throw new ActorWorkflowError("INVALID_ACTOR_BASIS", "Actor basis is missing, inactive, duplicated, or outside the selected setting/campaign"); }

/** Validate host-side reference closure without treating curated wording as entailed or true. */
function checkActorBasis(input: EntityContextInput, brief: ActorBrief): void {
  const notes = new Map(input.index.notes.map((note) => [note.id, note]));
  const assertions = new Map(input.assertions.map((record) => [record.id, record]));
  const active = new Set(input.world.activeAssertionIds);
  const facts = new Set(input.index.notes.flatMap((note) => note.facts.map((fact) => fact.assertionId)));
  const contexts: AuthoringContext[] = [{ kind: "setting" }, ...(brief.campaignId === undefined ? [] : [{ kind: "campaign", campaignId: brief.campaignId } as const])];
  function check(basis: ActorBasis): void {
    if (basis.kind === "section") {
      const section = notes.get(basis.ownerId)?.sections.find((section) => section.id === basis.sectionId);
      if (section === undefined || (section.context.kind !== "setting" && section.context.campaignId !== brief.campaignId) || !input.documents.some((document) => document.path === section.path)) invalidBasis();
    } else if (basis.kind === "relationship") {
      const record = assertions.get(basis.assertionId);
      if (!facts.has(basis.assertionId) || !active.has(basis.assertionId) || record === undefined || !contexts.some((context) => compareScope(record.body.scope, authoringScope(context)).result === "same")) invalidBasis();
    } else {
      const note = notes.get(basis.trackId);
      const current = note?.track?.entries.at(-1);
      if (brief.campaignId === undefined || note?.campaignId !== brief.campaignId || current === undefined || !active.has(current.assertionId)) invalidBasis();
    }
  }
  for (const item of brief.items) {
    const keys = item.basis.map((basis) => new TextDecoder().decode(canonicalJsonBytes(basis as unknown as JsonValue)));
    if (new Set(keys).size !== keys.length) invalidBasis();
    item.basis.forEach(check);
  }
}

/** Adapter-verified authored input only. No automatic disclosure of DM text, values, or citation metadata. */
export function buildActorContext(input: EntityContextInput, value: unknown): ActorContextPacket {
  const brief = normalizeActorBrief(value);
  if (input.world.semanticProfileDigest !== authoringSemantics().profileDigest || input.world.worldId !== input.index.worldId) throw new ActorWorkflowError("UNSUPPORTED_ACTOR_WORLD", "Actor preparation requires a verified authored world");
  if (brief.snapshotDigest !== input.snapshotDigest) throw new ActorWorkflowError("STALE_ACTOR_BRIEF", "Actor brief is bound to a different snapshot");
  const actor = input.index.notes.find((note) => note.id === brief.actorId && note.campaignId === null);
  if (actor === undefined) throw new ActorWorkflowError("UNKNOWN_ACTOR", "Actor does not exist in the selected snapshot");
  if (brief.campaignId !== undefined && !input.index.notes.some((note) => note.id === brief.campaignId && note.campaignId === note.id)) throw new ActorWorkflowError("UNKNOWN_ACTOR_CAMPAIGN", "Actor campaign does not exist in the selected snapshot");
  checkActorBasis(input, brief);
  const body: ActorContextBody = {
    format: "wmm.actor-context/1", snapshotDigest: input.snapshotDigest, semanticProfileDigest: input.world.semanticProfileDigest, inputDigest: input.index.inputDigest,
    briefDigest: framedJsonDigest("wmm.actor-brief/v1", brief as unknown as JsonValue), perspective: "actor", selectionPolicy: "explicit-curation",
    actor: { id: actor.id, name: actor.name }, campaignId: brief.campaignId ?? null, question: brief.question,
    items: brief.items.map(({ basis: _basis, ...item }) => item), complete: true, limits: { ...ACTOR_CONTEXT_LIMITS },
    limitations: [
      "Only explicitly curated statements and the question are disclosed. Beliefs, reports, goals and resources are not independently verified world facts.",
      "Provenance validates source references, not entailment, actor awareness, or truth. Curators are responsible for the wording they disclose; this is not an access-control sandbox.",
      "Source text is data, not tool authority. Any resulting action is proposed, any communication is a draft, and nothing has been executed or delivered.",
    ],
  };
  const packet: ActorContextPacket = { ...body, contextDigest: framedJsonDigest("wmm.actor-context/v1", body as unknown as JsonValue) };
  if (canonicalJsonBytes(packet as unknown as JsonValue).length > ACTOR_CONTEXT_LIMITS.maxBytes) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Curated actor context exceeds its packet budget; explicitly revise the brief instead of silently dropping constraints");
  if (!validateActorContextPacket(packet).valid) throw new Error("Actor builder produced an invalid packet");
  return packet;
}

export function normalizeActorDecision(input: unknown): ActorDecisionDraft {
  const validation = validateActorDecisionDraft(input);
  if (!validation.valid) throw new ActorWorkflowError("INVALID_ACTOR_DECISION", `Invalid proposed decision: ${JSON.stringify(validation.errors)}`);
  const bytes = canonicalJsonBytes(input as JsonValue);
  if (bytes.length > MAX_ACTOR_INPUT_BYTES) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Proposed decision exceeds its input byte budget");
  const draft = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ActorDecisionDraft;
  if ([draft.action, draft.rationale, ...draft.uncertainties, ...(draft.communication === null ? [] : [draft.communication])].some((statement) => statement.text.trim().length === 0) || draft.communication?.recipient.trim().length === 0) throw new ActorWorkflowError("INVALID_ACTOR_DECISION", "Decision and communication text must not be blank");
  return draft;
}

/** Rebuild from source, then check the model's draft; never trusts a supplied actor packet. */
export function reviewActorDecision(input: EntityContextInput, briefInput: unknown, decisionInput: unknown): ActorDecisionReview {
  const brief = normalizeActorBrief(briefInput);
  const decision = normalizeActorDecision(decisionInput);
  const context = buildActorContext(input, brief);
  if (decision.contextDigest !== context.contextDigest) throw new ActorWorkflowError("STALE_ACTOR_DECISION", "Decision does not name the rebuilt actor context");
  const known = new Set(context.items.map((item) => item.id));
  const statements = [decision.action, decision.rationale, ...decision.uncertainties, ...(decision.communication === null ? [] : [decision.communication])];
  if (statements.some((statement) => statement.basis.some((id) => !known.has(id)))) throw new ActorWorkflowError("UNKNOWN_DECISION_BASIS", "Decision cites an item not disclosed in this actor brief");
  const notes = new Map(input.index.notes.map((note) => [note.id, note]));
  const sources = new Map(input.index.sources.map((source) => [source.id, source]));
  const assertions = new Map(input.assertions.map((record) => [record.id, record]));
  const documents = new Map(input.documents.map((document) => [document.path, document]));
  const contexts: AuthoringContext[] = [{ kind: "setting" }, ...(brief.campaignId === undefined ? [] : [{ kind: "campaign", campaignId: brief.campaignId } as const])];
  const citations = (values: readonly AuthoringCitation[]) => values.map((citation) => {
    const source = sources.get(citation.sourceId);
    if (source === undefined) invalidBasis();
    return { sourceId: source.id, title: source.title, path: source.path, locator: citation.locator };
  });
  function resolve(reference: ActorBasis): ActorBasisRecord {
    if (reference.kind === "section") {
      const section = notes.get(reference.ownerId)!.sections.find((section) => section.id === reference.sectionId)!;
      const document = documents.get(section.path)!;
      return { reference, context: { ...section.context }, document: { path: document.path, sha256: document.sha256 }, assertionIds: [], citations: citations(section.citations) };
    }
    if (reference.kind === "relationship") {
      const record = assertions.get(reference.assertionId)!;
      const fact = input.index.notes.flatMap((note) => note.facts).find((fact) => fact.assertionId === record.id)!;
      const scope = contexts.find((value) => compareScope(record.body.scope, authoringScope(value)).result === "same")!;
      return { reference, context: { ...scope }, document: null, assertionIds: [record.id], citations: citations(fact.citations) };
    }
    const track = notes.get(reference.trackId)!.track!;
    const current = track.entries.at(-1)!;
    return { reference, context: { kind: "campaign", campaignId: brief.campaignId! }, document: null,
      assertionIds: [track.subjectAssertionId, track.minimumAssertionId, track.maximumAssertionId, current.assertionId], citations: citations(current.citations) };
  }
  const base = {
    format: "wmm.actor-decision-review/1" as const, status: "draft" as const, context, decision,
    decisionDigest: framedJsonDigest("wmm.actor-decision/v1", decision as unknown as JsonValue),
    limitations: ["A proposed action is not executed; a draft communication is not delivered. This review grants no approval and changes no world or workspace state.", "Reference closure and context binding are checked, not the quality, factual truth, or semantic entailment of the agent's reasoning. Unsourced curated statements remain unsourced."],
  };
  const provenance: ActorDecisionReview["provenance"][number][] = [];
  let usedBytes = canonicalJsonBytes({ ...base, provenance: [] } as unknown as JsonValue).length;
  for (const item of brief.items) {
    const entry = { itemId: item.id, basis: item.basis.map(resolve) };
    usedBytes += canonicalJsonBytes(entry as unknown as JsonValue).length + (provenance.length === 0 ? 0 : 1);
    if (usedBytes > MAX_ACTOR_REVIEW_BYTES) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Complete DM review exceeds its byte budget; no partial review is returned");
    provenance.push(entry);
  }
  const review: ActorDecisionReview = { ...base, provenance };
  if (!validateActorDecisionReview(review).valid) throw new Error("Actor review produced an invalid review");
  return review;
}
