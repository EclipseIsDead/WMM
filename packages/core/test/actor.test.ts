import { readFileSync } from "node:fs";

import { canonicalJsonBytes, framedJsonDigest, sha256Hex } from "@wmm/canonical";
import type { ActorBrief, ActorContextPacket, ActorDecisionDraft, ActorDecisionReview, AssertionRecordV1, AuthoringIndex, AuthoringProject, JsonValue, WorldCatalogV1 } from "@wmm/wire-contracts";
import { validateActorBrief, validateActorContextPacket, validateActorDecisionDraft, validateActorDecisionReview } from "@wmm/wire-contracts";
import { describe, expect, it } from "vitest";

import * as core from "../src/index.js";

function project(): AuthoringProject {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
}
function input(value: AuthoringProject = project()) {
  const compiled = core.compileAuthoringProject(value);
  const parse = <T>(path: string): T => JSON.parse(new TextDecoder().decode(compiled.payload.find((file) => file.path === path)!.bytes)) as T;
  return {
    snapshotDigest: compiled.snapshot.snapshotDigest, world: parse<WorldCatalogV1>("world.json"), index: parse<AuthoringIndex>("authoring/index.json"),
    assertions: compiled.payload.filter((file) => file.path.startsWith("records/assertions/")).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as AssertionRecordV1),
    documents: compiled.payload.filter((file) => file.path.startsWith("prose/")).map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), bytes: file.bytes })),
  };
}
function brief(snapshotDigest: string): ActorBrief {
  return { format: "wmm.actor-brief/1", snapshotDigest, actorId: "faction:lantern_guild", campaignId: "campaign:harbor_watch", question: "What should we do about the beacon watch next?", items: [
    { id: "mission", kind: "goal", text: "Keep the harbor beacons operating.", basis: [{ kind: "section", ownerId: "faction:lantern_guild", sectionId: "overview" }] },
    { id: "funds", kind: "belief", text: "The council has already paid for the watch.", basis: [] },
  ] };
}
function prepare(snapshot: ReturnType<typeof input>, value: unknown): ActorContextPacket {
  const build = Reflect.get(core, "buildActorContext") as ((snapshot: ReturnType<typeof input>, value: unknown) => ActorContextPacket);
  expect(typeof build).toBe("function");
  return build(snapshot, value);
}

function decision(contextDigest: string): ActorDecisionDraft {
  return { format: "wmm.actor-decision/1", status: "proposed", contextDigest,
    action: { text: "Ask the council steward to confirm payment before changing the watch.", basis: ["mission", "funds"] },
    rationale: { text: "We must keep the beacons lit, but our belief about payment needs confirmation.", basis: ["mission", "funds"] },
    uncertainties: [{ text: "The payment report may be mistaken.", basis: ["funds"] }],
    communication: { status: "draft", recipient: "Council steward", text: "Please confirm the funds for the next watch.", basis: ["mission", "funds"] },
  };
}

describe("actor preparation", () => {
  it("fails closed on oversized curated context instead of dropping a constraint", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    expect(() => prepare(snapshot, { ...value, items: Array.from({ length: 9 }, (_, index) => ({ id: `item_${index}`, kind: "constraint", text: "x".repeat(8192), basis: [] })) })).toThrow(expect.objectContaining({ code: "ACTOR_BUDGET_EXCEEDED" }));
  });

  it("rejects stale snapshots and unknown actors/campaigns", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    for (const [patch, code] of [
      [{ snapshotDigest: "0".repeat(64) }, "STALE_ACTOR_BRIEF"], [{ actorId: "person:absent" }, "UNKNOWN_ACTOR"], [{ campaignId: "campaign:absent" }, "UNKNOWN_ACTOR_CAMPAIGN"],
    ] as const) expect(() => prepare(snapshot, { ...value, ...patch })).toThrow(expect.objectContaining({ code }));
  });

  it("checks source-reference closure and exact campaign selection without treating a source as disclosed knowledge", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    const facts = snapshot.index.notes.flatMap((note) => note.facts);
    const bases = [{ kind: "relationship", assertionId: facts[0]!.assertionId }, { kind: "track", trackId: "track:guild_unrest" }] as const;
    const augmented = { ...value, items: [{ ...value.items[0]!, basis: bases }] };
    expect(prepare(snapshot, augmented).items[0]!.text).toBe(value.items[0]!.text);
    const { campaignId: _campaignId, ...settingOnly } = augmented;
    expect(() => prepare(snapshot, settingOnly)).toThrow(expect.objectContaining({ code: "INVALID_ACTOR_BASIS" }));
    for (const basis of [
      [{ kind: "section", ownerId: "faction:lantern_guild", sectionId: "absent" }],
      [{ kind: "relationship", assertionId: snapshot.world.activeAssertionIds.find((id) => !facts.some((fact) => fact.assertionId === id))! }],
      [{ kind: "track", trackId: "track:absent" }], [...value.items[0]!.basis, ...value.items[0]!.basis],
    ]) expect(() => prepare(snapshot, { ...value, items: [{ ...value.items[0]!, basis }] })).toThrow(expect.objectContaining({ code: "INVALID_ACTOR_BASIS" }));
  });

  it("rejects behaviorful and malformed briefs without executing accessors or repairing tokens", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    let calls = 0;
    const getter = Object.defineProperty({}, "format", { enumerable: true, get: () => { calls += 1; return value.format; } });
    const proxy = new Proxy({}, { ownKeys: () => { calls += 1; return []; } });
    for (const candidate of [null, [], getter, proxy, { ...value, actorId: "Faction:lantern_guild" }, { ...value, items: [...value.items, value.items[0]!] }, { ...value, policy: "omniscient" }]) {
      expect(() => prepare(snapshot, candidate)).toThrow(expect.objectContaining({ code: "INVALID_ACTOR_BRIEF" }));
    }
    expect(calls).toBe(0);
    expect(validateActorBrief(value).valid).toBe(true);
    expect(validateActorContextPacket(prepare(snapshot, value)).valid).toBe(true);
  });

  it("rejects blank questions and curated statements without silently normalizing the supplied text", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    for (const invalid of [{ ...value, question: " \n" }, { ...value, items: [{ ...value.items[0]!, text: " \t" }] }]) {
      expect(() => prepare(snapshot, invalid)).toThrow(expect.objectContaining({ code: "INVALID_ACTOR_BRIEF" }));
    }
  });

  it("discloses only curated statements, preserving a mistaken belief without revealing source text or citation metadata", () => {
    const original = project();
    const snapshot = input({ ...original, sources: original.sources.map((source) => ({ ...source, title: "DM_ONLY_CANARY", path: "Private/DM_ONLY_CANARY.md" })), entities: [
      { ...original.entities[0]!, sections: original.entities[0]!.sections.map((section) => ({ ...section, heading: "DM_ONLY_CANARY", text: "DM_ONLY_CANARY: the council's hidden plan." })) }, original.entities[1]!,
    ] });
    const value = brief(snapshot.snapshotDigest);
    const before = structuredClone(value);
    const packet = prepare(snapshot, value);
    expect(packet).toMatchObject({ format: "wmm.actor-context/1", perspective: "actor", selectionPolicy: "explicit-curation", actor: { id: value.actorId }, campaignId: value.campaignId, question: value.question, complete: true });
    expect(packet.items).toEqual(value.items.map(({ basis: _basis, ...item }) => item));
    expect(JSON.stringify(packet)).not.toContain("DM_ONLY_CANARY");
    expect(value).toEqual(before);
    expect(packet).toEqual(prepare(snapshot, value));
    const { contextDigest, ...body } = packet;
    expect(contextDigest).toBe(framedJsonDigest("wmm.actor-context/v1", body as unknown as JsonValue));
    expect(canonicalJsonBytes(packet as unknown as JsonValue).length).toBeLessThanOrEqual(packet.limits.maxBytes);
  });
});

describe("actor decision review", () => {
  it("rejects substituted contexts, undisclosed citations, and claims of execution or delivery", () => {
    const snapshot = input();
    const value = brief(snapshot.snapshotDigest);
    const draft = decision(prepare(snapshot, value).contextDigest);
    for (const [candidate, code] of [
      [{ ...draft, contextDigest: "0".repeat(64) }, "STALE_ACTOR_DECISION"],
      [{ ...draft, action: { ...draft.action, basis: ["undisclosed"] } }, "UNKNOWN_DECISION_BASIS"],
      [{ ...draft, action: { ...draft.action, basis: [] } }, "INVALID_ACTOR_DECISION"],
      [{ ...draft, status: "executed" }, "INVALID_ACTOR_DECISION"],
      [{ ...draft, executed: true }, "INVALID_ACTOR_DECISION"],
      [{ ...draft, communication: { ...draft.communication!, status: "delivered" } }, "INVALID_ACTOR_DECISION"],
    ] as const) expect(() => core.reviewActorDecision(snapshot, value, candidate)).toThrow(expect.objectContaining({ code }));
    expect(() => core.reviewActorDecision(snapshot, { ...value, question: "A changed question?" }, draft)).toThrow(expect.objectContaining({ code: "STALE_ACTOR_DECISION" }));
  });

  it("bounds a DM review before amplifying all repeated source metadata", () => {
    const original = project();
    const first = original.entities[0]!;
    const sections = Array.from({ length: 8 }, (_, index) => ({ ...first.sections[0]!, id: `basis_${index}`, citations: Array.from({ length: 100 }, (_, number) => ({ sourceId: original.sources[0]!.id, locator: `Locator ${number}` })) }));
    const snapshot = input({ ...original, sources: [{ ...original.sources[0]!, path: "🦉".repeat(500) }], entities: [{ ...first, sections }, original.entities[1]!] });
    const value = { ...brief(snapshot.snapshotDigest), items: [{ ...brief(snapshot.snapshotDigest).items[0]!, basis: sections.map((section) => ({ kind: "section" as const, ownerId: first.id, sectionId: section.id })) }] };
    const draft = { ...decision(prepare(snapshot, value).contextDigest), action: { text: "Keep the watch.", basis: ["mission"] }, rationale: { text: "Preserve the beacons.", basis: ["mission"] }, uncertainties: [], communication: null };
    expect(() => core.reviewActorDecision(snapshot, value, draft)).toThrow(expect.objectContaining({ code: "ACTOR_BUDGET_EXCEEDED" }));
  });

  it("binds a proposed action and undelivered message to a rebuilt context with host-only provenance, without changing the snapshot", () => {
    const snapshot = input();
    const before = structuredClone(snapshot);
    const value = brief(snapshot.snapshotDigest);
    const packet = prepare(snapshot, value);
    const draft = decision(packet.contextDigest);
    const reviewDecision = Reflect.get(core, "reviewActorDecision") as ((snapshot: ReturnType<typeof input>, brief: unknown, draft: unknown) => ActorDecisionReview);
    expect(typeof reviewDecision).toBe("function");
    const review = reviewDecision(snapshot, value, draft);
    expect(review).toMatchObject({ format: "wmm.actor-decision-review/1", status: "draft", context: packet, decision: draft });
    expect(review.decisionDigest).toBe(framedJsonDigest("wmm.actor-decision/v1", draft as unknown as JsonValue));
    expect(review.provenance[0]).toMatchObject({ itemId: "mission", basis: [{ reference: value.items[0]!.basis[0], document: { path: "prose/faction/lantern_guild/overview.md" }, citations: [{ sourceId: "source:setting_notes", path: "Setting/Factions.md" }] }] });
    expect(review.provenance[1]).toEqual({ itemId: "funds", basis: [] });
    expect(review.limitations.join(" ")).toMatch(/not.*executed|not.*delivered/i);
    expect(snapshot).toEqual(before);
    expect(validateActorDecisionDraft(draft).valid).toBe(true);
    expect(validateActorDecisionReview(review).valid).toBe(true);
    expect(review).toEqual(core.reviewActorDecision(snapshot, value, draft));
  });
});
