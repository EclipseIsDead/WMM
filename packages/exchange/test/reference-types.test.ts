import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { assertionId, canonicalJsonBytes, sha256Hex, snapshotDigest, supportId } from "@wmm/canonical";
import { reviewWorkspace, verifyWorkspaceReviewReceipt } from "@wmm/core";
import { validateWorkspaceReviewReceipt, validateWorldRecord } from "@wmm/wire-contracts";
import type { AuthoringProject, ClaimBodyV1, DescriptorRecordV1, JsonValue, SnapshotFileEntryV1, WorkspaceBaseV1, WorkspaceStateV1 } from "@wmm/wire-contracts";
import { buildAuthoringBundle, exportWorldBundle, loadBundledV1WorldBundle, loadReleaseWorldBundle, validateWorldBundle, type LoadedWorldBundle } from "../src/index.js";

const fixture = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const project: AuthoringProject = {
  format: "wmm.authoring-project/1", worldId: "world:reference_types", title: "Reference types", sources: [], campaigns: [],
  entities: ["person:member", "place:hall", "faction:guild"].map((id) => ({ id, name: id, sections: [] })),
  facts: [
    { subjectId: "person:member", predicate: "located_in", objectId: "place:hall", polarity: "positive", context: { kind: "setting" }, citations: [] },
    { subjectId: "person:member", predicate: "member_of", objectId: "faction:guild", polarity: "positive", context: { kind: "setting" }, citations: [] },
  ],
};

/** Rehash claims, dependent supports, catalogs and every payload byte before normal admission. */
function rewriteBundle(
  root: string,
  bundle: LoadedWorldBundle,
  change: (body: ClaimBodyV1) => ClaimBodyV1,
  descriptors: readonly DescriptorRecordV1[] = bundle.descriptors,
): void {
  const claimIds = new Map<string, string>();
  const assertions = bundle.assertions.map((record) => {
    const body = change(record.body);
    const id = assertionId(body);
    claimIds.set(record.id, id);
    return { ...record, id, body };
  });
  const supportIds = new Map<string, string>();
  const supports = bundle.supports.map((record) => {
    const body = { ...record.body, claimId: claimIds.get(record.body.claimId)! };
    const id = supportId(body);
    supportIds.set(record.id, id);
    return { ...record, id, body };
  });
  const world = {
    ...bundle.world,
    descriptorIds: descriptors.map((record) => record.id).sort(),
    assertionIds: assertions.map((record) => record.id).sort(),
    activeAssertionIds: bundle.world.activeAssertionIds.map((id) => claimIds.get(id)!).sort(),
    supportIds: supports.map((record) => record.id).sort(),
    activeSupportIds: bundle.world.activeSupportIds.map((id) => supportIds.get(id)!).sort(),
  };
  const files: SnapshotFileEntryV1[] = [];
  const bytes = (path: string, payload: Uint8Array, mediaType: SnapshotFileEntryV1["mediaType"]): void => {
    mkdirSync(dirname(join(root, "payload", path)), { recursive: true });
    writeFileSync(join(root, "payload", path), payload);
    files.push({ path, mediaType, byteLength: String(payload.length), sha256: sha256Hex(payload) });
  };
  const json = (path: string, value: unknown): void => bytes(path, canonicalJsonBytes(value as JsonValue), "application/json");
  json("world.json", world);
  json(`types/${world.semanticProfileDigest}.json`, bundle.semanticProfile);
  for (const [digest, definition] of Object.entries(bundle.definitionsByDigest)) json(`types/${digest}.json`, definition);
  for (const { digest, body } of bundle.rosters) json(`rosters/${digest}.json`, body);
  for (const record of descriptors) json(`records/descriptors/${record.id.replace(":", "/")}.json`, record);
  for (const record of bundle.sources) json(`records/sources/${record.id.slice(7)}.json`, record);
  for (const record of assertions) json(`records/assertions/${record.id.slice(5)}.json`, record);
  for (const record of supports) json(`records/supports/${record.id.slice(4)}.json`, record);
  for (const document of bundle.documents) {
    const mediaType = bundle.snapshot.manifest.files.find((entry) => entry.path === document.path)!.mediaType;
    bytes(document.path, document.bytes, mediaType);
  }
  const manifest = { ...bundle.snapshot.manifest, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  writeFileSync(join(root, "snapshot.json"), canonicalJsonBytes({ ...bundle.snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } as unknown as JsonValue));
}

function definitionDigest(bundle: LoadedWorldBundle, key: string): string {
  return Object.entries(bundle.definitionsByDigest).find(([, definition]) => definition.key === key)![0];
}

function referenceClaim(bundle: LoadedWorldBundle, relation: "eligible" | "located_in" | "member_of", target: string): ClaimBodyV1 {
  const proposition: ClaimBodyV1["proposition"] = relation === "eligible"
    ? { kind: "exists", population: { descriptorId: "population:succession-candidates", definitionDigest: definitionDigest(bundle, "candidates") }, criterion: { definitionDigest: definitionDigest(bundle, "eligible"), arguments: { office: { kind: "ref", id: target } } } }
    : { kind: "atom", subjectId: "person:member", predicateDefinitionDigest: definitionDigest(bundle, relation), value: { kind: "ref", id: target } };
  return {
    format: "wmm.claim/1", worldId: bundle.world.worldId, semanticProfileDigest: bundle.world.semanticProfileDigest,
    proposition, polarity: "negative", applicability: { kind: "point", axisDefinitionDigest: definitionDigest(bundle, "days"), position: { kind: "exact", position: "2000" } },
    scope: relation === "eligible" ? bundle.assertions[0]!.body.scope : { account: { kind: "ref", id: "account:setting" }, jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "notApplicable" } },
  };
}

function reviewProposal(bundle: LoadedWorldBundle, body: ClaimBodyV1, selected = true) {
  const assertion = { format: "wmm.assertion-record/1" as const, id: assertionId(body), body };
  expect(validateWorldRecord(assertion)).toEqual({ valid: true, errors: [] });
  const base: WorkspaceBaseV1 = {
    snapshot: bundle.snapshot, world: exportWorldBundle(bundle),
    documents: bundle.documents.map(({ path, mediaType, sha256, bytes }) => ({ path, mediaType, sha256, base64: Buffer.from(bytes).toString("base64") })),
  };
  const state: WorkspaceStateV1 = {
    format: "wmm.workspace/1", id: "references", version: 1, title: "Reference review", worldTitle: "Reference world", goal: "Review only explicit selections", direction: "No canon writes", mode: "world",
    base: { worldId: bundle.world.worldId, snapshotDigest: bundle.snapshot.snapshotDigest }, pins: [], history: [],
    proposals: [{ id: "machine", version: 1, title: "Machine assertion", author: "Test", rationale: "Explicit structured proposal", dependencies: [], exclusions: [], operations: [{ kind: "activate-assertion", assertion }], decision: selected ? "selected" : "undecided", rejectionReason: null },
      { id: "prose", version: 1, title: "Prose", author: "Test", rationale: "Explicit prose", dependencies: [], exclusions: [], operations: [{ kind: "write-prose", path: "prose/review.md", text: "Uninterpreted narrative", beforeSha256: null }], decision: selected ? "undecided" : "selected", rejectionReason: null }],
  };
  const before = structuredClone({ base, state });
  const result = reviewWorkspace(state, base);
  expect({ base, state }).toEqual(before);
  expect(validateWorkspaceReviewReceipt(result.review)).toEqual({ valid: true, errors: [] });
  expect(verifyWorkspaceReviewReceipt(result.review, state, base)).toBe(true);
  return { ...result, assertion };
}

describe("selected machine proposal reference-type review", () => {
  it.each(["eligible", "located_in", "member_of"] as const)("rejects a selected wrong %s target without validating an unselected proposal or changing its base", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-review-"));
    try {
      const bundle = relation === "eligible" ? loadBundledV1WorldBundle(fixture) : buildAuthoringBundle({ ...project, facts: [] }, join(root, "base"));
      const body = referenceClaim(bundle, relation, relation === "eligible" ? "person:alys" : "person:member");
      const result = reviewProposal(bundle, body);
      expect(result.review.validity).toBe("invalid");
      expect(result.review.checks.find((check) => check.id === "references")?.status).toBe("failed");
      expect(result.review.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_REFERENCES", message: expect.stringMatching(/office descriptor|place target|faction target/) }));
      expect(result.candidate!.world.assertions).toContainEqual(result.assertion);
      expect(reviewProposal(bundle, body, false).review.validity).toBe("valid");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["eligible", "located_in", "member_of"] as const)("accepts the correct %s birth type under a misleading account prefix in an ordinary bundle and selected review", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-alias-"));
    try {
      const bundle = relation === "eligible" ? loadBundledV1WorldBundle(fixture) : buildAuthoringBundle(project, join(root, "base"));
      const type = relation === "eligible" ? "office" : relation === "located_in" ? "place" : "faction";
      const descriptor: DescriptorRecordV1 = { format: "wmm.descriptor/1", worldId: bundle.world.worldId, id: "account:type_alias", birthTypeDefinitionDigest: definitionDigest(bundle, type) };
      rewriteBundle(join(root, "aliased"), bundle, (body) => {
        if (relation === "eligible" && body.proposition.kind === "exists") return { ...body, proposition: { ...body.proposition, criterion: { ...body.proposition.criterion, arguments: { office: { kind: "ref", id: descriptor.id } } } } };
        if (body.proposition.kind === "atom" && body.proposition.predicateDefinitionDigest === definitionDigest(bundle, relation)) return { ...body, proposition: { ...body.proposition, value: { kind: "ref", id: descriptor.id } } };
        return body;
      }, [...bundle.descriptors, descriptor]);
      const admitted = loadReleaseWorldBundle(join(root, "aliased"));
      expect(validateWorldBundle(admitted).status).toBe("valid");
      const body = referenceClaim(admitted, relation, descriptor.id);
      const result = reviewProposal(admitted, { ...body, polarity: relation === "eligible" ? "negative" : "positive" });
      expect(result.review.validity).toBe("valid");
      expect(result.candidate!.world.assertions).toContainEqual(result.assertion);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("ordinary bundle reference-type admission", () => {
  it.each(["located_in", "member_of"] as const)("rejects a nonentity %s subject through ordinary loading and selected review", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-domain-"));
    try {
      const bundle = buildAuthoringBundle(project, join(root, "base"));
      const change = (body: ClaimBodyV1): ClaimBodyV1 => body.proposition.kind !== "atom" || body.proposition.predicateDefinitionDigest !== definitionDigest(bundle, relation) ? body : { ...body, proposition: { ...body.proposition, subjectId: "account:setting" } };
      rewriteBundle(join(root, "rewritten"), bundle, change);
      expect(() => loadReleaseWorldBundle(join(root, "rewritten"))).toThrow(expect.objectContaining({ code: "INVALID_WORLD", message: expect.stringMatching(/authored entity subject/) }));
      const body = bundle.assertions.map((record) => record.body).find((body) => change(body) !== body)!;
      const result = reviewProposal(bundle, change(body));
      expect(result.review.validity).toBe("invalid");
      expect(result.review.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_REFERENCES", message: expect.stringMatching(/authored entity subject/) }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["eligible", "located_in", "member_of"] as const)("rejects the wrong %s birth type even when the descriptor ID has the expected prefix", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-prefix-"));
    try {
      const bundle = relation === "eligible" ? loadBundledV1WorldBundle(fixture) : buildAuthoringBundle(project, join(root, "base"));
      const target = relation === "eligible" ? "office:valen-crown" : relation === "located_in" ? "place:hall" : "faction:guild";
      const descriptors = bundle.descriptors.map((record) => record.id !== target ? record : { ...record, birthTypeDefinitionDigest: definitionDigest(bundle, "person") });
      rewriteBundle(join(root, "rewritten"), bundle, (body) => body, descriptors);
      expect(() => loadReleaseWorldBundle(join(root, "rewritten"))).toThrow(expect.objectContaining({ code: "INVALID_WORLD", cause: expect.objectContaining({ code: "INVALID_OPERATION_VALUE" }) }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["eligible", "located_in", "member_of"] as const)("preserves the unavailable-reference error for a missing %s target", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-missing-"));
    try {
      const bundle = relation === "eligible" ? loadBundledV1WorldBundle(fixture) : buildAuthoringBundle(project, join(root, "base"));
      const missing = relation === "eligible" ? "office:missing" : relation === "located_in" ? "place:missing" : "faction:missing";
      rewriteBundle(join(root, "rewritten"), bundle, (body) => {
        if (relation === "eligible" && body.proposition.kind === "exists") return { ...body, proposition: { ...body.proposition, criterion: { ...body.proposition.criterion, arguments: { office: { kind: "ref", id: missing } } } } };
        if (body.proposition.kind === "atom" && body.proposition.predicateDefinitionDigest === definitionDigest(bundle, relation)) return { ...body, proposition: { ...body.proposition, value: { kind: "ref", id: missing } } };
        return body;
      });
      expect(() => loadReleaseWorldBundle(join(root, "rewritten"))).toThrow(expect.objectContaining({
        code: "INVALID_WORLD", message: `Descriptor is unavailable: ${missing}`, cause: expect.objectContaining({ code: "UNKNOWN_REFERENCE" }),
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["eligibility_satisfaction", "candidate_membership", "population_coverage", "existential_population"] as const)("rejects the wrong %s sibling reference type in a coherently rehashed bundle and selected review", (role) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-sibling-"));
    try {
      const bundle = loadBundledV1WorldBundle(fixture);
      const change = (body: ClaimBodyV1): ClaimBodyV1 => {
        if (role === "existential_population" && body.proposition.kind === "exists") return { ...body, proposition: { ...body.proposition, population: { ...body.proposition.population, descriptorId: "person:alys" } } };
        if (role === "existential_population" || body.proposition.kind !== "atom" || body.proposition.predicateDefinitionDigest !== definitionDigest(bundle, role)) return body;
        return { ...body, proposition: role === "population_coverage" ? { ...body.proposition, subjectId: "person:alys" } : { ...body.proposition, value: { kind: "ref", id: "person:alys" } } };
      };
      rewriteBundle(root, bundle, change);
      expect(() => validateWorldBundle(loadReleaseWorldBundle(root))).toThrow(expect.objectContaining({ code: "INVALID_WORLD", cause: expect.objectContaining({ code: "INVALID_OPERATION_VALUE" }) }));
      const body = bundle.assertions.map((record) => record.body).find((body) => change(body) !== body)!;
      const reviewed = reviewProposal(bundle, change(body));
      expect(reviewed.review.validity).toBe("invalid");
      expect(reviewed.review.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_REFERENCES" }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["located_in", "member_of"] as const)("rejects a wrong %s target through ordinary loading rather than only the compiler", (relation) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-types-"));
    try {
      const bundle = buildAuthoringBundle(project, join(root, "original"));
      const predicate = Object.entries(bundle.definitionsByDigest).find(([, definition]) => definition.key === relation)![0];
      rewriteBundle(join(root, "rewritten"), bundle, (body) => body.proposition.kind !== "atom" || body.proposition.predicateDefinitionDigest !== predicate ? body : {
        ...body, proposition: { ...body.proposition, value: { kind: "ref", id: "person:member" } },
      });
      expect(() => loadReleaseWorldBundle(join(root, "rewritten"))).toThrow(expect.objectContaining({
        code: "INVALID_WORLD", message: expect.stringMatching(new RegExp(`${relation} requires a (place|faction) target`)),
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an existing person used as the eligible office after coherent rehashing", () => {
    const root = mkdtempSync(join(tmpdir(), "wmm-reference-types-"));
    try {
      const bundle = loadBundledV1WorldBundle(fixture);
      expect(bundle.descriptors.find((record) => record.id === "person:alys")?.birthTypeDefinitionDigest)
        .toBe(Object.entries(bundle.definitionsByDigest).find(([, definition]) => definition.key === "person")![0]);
      rewriteBundle(root, bundle, (body) => body.proposition.kind !== "exists" ? body : {
        ...body, proposition: { ...body.proposition, criterion: { ...body.proposition.criterion, arguments: { office: { kind: "ref", id: "person:alys" } } } },
      });
      expect(() => validateWorldBundle(loadReleaseWorldBundle(root))).toThrow(expect.objectContaining({
        code: "INVALID_WORLD", message: expect.stringMatching(/office descriptor/),
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
