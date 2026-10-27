import { canonicalJsonBytes, sha256Hex } from "@wmm/canonical";
import { ActorWorkflowError, authoringSemantics, buildActorContext, MAX_ACTOR_REVIEW_BYTES, normalizeActorBrief, normalizeActorDecision, reviewActorDecision, type EntityContextInput } from "@wmm/core";
import type { ActorContextPacket, ActorDecisionReview, ActorDecisionStatement, JsonValue } from "@wmm/wire-contracts";
import { validateActorDecisionReview } from "@wmm/wire-contracts";

import { writeNewAuthoringDirectory } from "./authoring.js";
import { readAuthoringIndex } from "./dm-notes.js";
import type { LoadedWorldBundle } from "./world-bundle.js";

function actorInput(bundle: LoadedWorldBundle): EntityContextInput {
  if (bundle.world.semanticProfileDigest !== authoringSemantics().profileDigest) throw new ActorWorkflowError("UNSUPPORTED_ACTOR_WORLD", "Actor preparation requires an authored WMM bundle");
  return { snapshotDigest: bundle.snapshot.snapshotDigest, world: bundle.world, index: readAuthoringIndex(bundle), assertions: bundle.assertions, documents: bundle.documents };
}
export function actorContextFromBundle(bundle: LoadedWorldBundle, value: unknown): ActorContextPacket {
  const brief = normalizeActorBrief(value);
  return buildActorContext(actorInput(bundle), brief);
}

export interface RenderedActorReview { readonly review: ActorDecisionReview; readonly markdown: string }
export function actorReviewFromBundle(bundle: LoadedWorldBundle, briefInput: unknown, decisionInput: unknown, destination?: string): RenderedActorReview {
  const brief = normalizeActorBrief(briefInput);
  const decision = normalizeActorDecision(decisionInput);
  const review = reviewActorDecision(actorInput(bundle), brief, decision);
  const result = { review, markdown: renderActorDecisionReview(review) };
  if (destination !== undefined) writeActorReviewArtifacts(brief, result, destination);
  return result;
}
function literal(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/[\\`*_{}\[\]<>()!|#~]/g, "\\$&");
}
function quote(value: string): string { return value.split(/\r\n?|\n/).map((line) => `> ${literal(line)}`).join("\n"); }
function statement(value: ActorDecisionStatement): string[] { return [quote(value.text), "", `Brief references: ${value.basis.length === 0 ? "none claimed" : value.basis.map((id) => `\`${id}\``).join(", ")}`, ""]; }

/** Formatting only. Untrusted imported reviews require source replay, not just shape validation. */
export function renderActorDecisionReview(input: ActorDecisionReview): string {
  if (!validateActorDecisionReview(input).valid) throw new ActorWorkflowError("INVALID_ACTOR_DECISION", "Cannot render a malformed decision review");
  if (canonicalJsonBytes(input as unknown as JsonValue).length > MAX_ACTOR_REVIEW_BYTES) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Decision review exceeds its byte budget");
  // Strip inherited array behavior without mutating the caller or reordering reference keys.
  const review = structuredClone(input);
  const { context, decision } = review;
  const lines = [
    `# Decision draft — ${literal(context.actor.name)}`, "", "> Private DM review. Proposed action only; not executed. Communications are drafts, not delivered. No approval or world changes.", "",
    "## Question", "", quote(context.question), "", "## Proposed action", "", ...statement(decision.action),
    "## In-character rationale", "", ...statement(decision.rationale), "## Uncertainties", "",
  ];
  if (decision.uncertainties.length === 0) lines.push("None stated; this does not establish certainty.", "");
  for (const uncertainty of decision.uncertainties) lines.push(...statement(uncertainty));
  lines.push("## Draft communication", "");
  if (decision.communication === null) lines.push("No communication drafted.", "");
  else lines.push(`To: ${literal(decision.communication.recipient)} — **draft, not delivered**`, "", ...statement(decision.communication));
  lines.push("## Curated actor context", "", "Beliefs and reports remain actor-side statements, not independently verified world facts.", "");
  for (const item of context.items) lines.push(`### ${item.id} — ${item.kind}`, "", quote(item.text), "");
  lines.push("## Host-side provenance — not actor input", "");
  for (const item of review.provenance) {
    lines.push(`### ${item.itemId}`, "");
    if (item.basis.length === 0) lines.push("No source reference supplied; this curated statement remains unsourced.", "");
    for (const basis of item.basis) {
      lines.push(`- Reference: ${literal(JSON.stringify(basis.reference))}`, `- Context: ${basis.context.kind === "setting" ? "Setting" : literal(basis.context.campaignId)}`);
      if (basis.document !== null) lines.push(`- Captured document: ${literal(basis.document.path)} · SHA-256 \`${basis.document.sha256}\``);
      if (basis.assertionIds.length > 0) lines.push(`- Assertion IDs: ${basis.assertionIds.map((id) => `\`${id}\``).join(", ")}`);
      for (const citation of basis.citations) lines.push(`- Source citation: ${literal(citation.title)} — ${literal(citation.path)} · ${literal(citation.locator)}`);
      lines.push("");
    }
  }
  lines.push("## Binding and limitations", "", `Snapshot: \`${context.snapshotDigest}\``, `Actor context: \`${context.contextDigest}\``, `Actor brief: \`${context.briefDigest}\``, `Decision: \`${review.decisionDigest}\``, "", ...review.limitations.map((value) => `- ${literal(value)}`), "");
  const markdown = `${lines.join("\n").trimEnd()}\n`;
  if (new TextEncoder().encode(markdown).length > 2 * MAX_ACTOR_REVIEW_BYTES) throw new ActorWorkflowError("ACTOR_BUDGET_EXCEEDED", "Rendered decision review exceeds its byte budget");
  return markdown;
}

/** Only the verified adapter above can publish these generated, mutually bound files. */
function writeActorReviewArtifacts(briefInput: unknown, result: RenderedActorReview, destination: string): void {
  const brief = normalizeActorBrief(briefInput);
  const { review } = result;
  const files = [
    { path: "actor-brief.json", bytes: canonicalJsonBytes(brief as unknown as JsonValue) },
    { path: "actor-context.json", bytes: canonicalJsonBytes(review.context as unknown as JsonValue) },
    { path: "decision.json", bytes: canonicalJsonBytes(review.decision as unknown as JsonValue) },
    { path: "review.json", bytes: canonicalJsonBytes(review as unknown as JsonValue) },
    { path: "review.md", bytes: new TextEncoder().encode(result.markdown) },
  ];
  const manifest = { format: "wmm.actor-review-files/1", snapshotDigest: review.context.snapshotDigest, contextDigest: review.context.contextDigest, decisionDigest: review.decisionDigest,
    files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), byteLength: String(file.bytes.length) })) };
  writeNewAuthoringDirectory(destination, [...files, { path: "wmm-actor-review.json", bytes: canonicalJsonBytes(manifest as unknown as JsonValue) }]);
}
