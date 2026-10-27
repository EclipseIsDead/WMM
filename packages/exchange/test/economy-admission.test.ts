import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { economySemantics } from "@wmm/core";
import { validateApiResponse, validateEconomyView } from "@wmm/wire-contracts";
import type { AuthoringEconomicRecord, ClaimBodyV1, EconomicRecordValue, JsonValue } from "@wmm/wire-contracts";
import { actorContextFromBundle, actorReviewFromBundle, buildAuthoringBundle, entityContextFromBundle, exportWorldBundle, inspectWorldBundle, loadBundledV1WorldBundle, loadReleaseWorldBundle, readAuthoringIndex, readEconomyView, validateWorldBundle } from "../src/index.js";
import { stock, delivery, requirement, project } from "../../core/test/helpers/economy.js";
import { changedBundle, writeChangedBundle } from "./helpers/economy-bundle.js";

function withRoot(run: (root: string) => void) { const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economic-admission-")); try { run(root); } finally { rmSync(root, { recursive: true, force: true }); } }
function literalChange(change: (value: EconomicRecordValue) => unknown): (body: ClaimBodyV1) => ClaimBodyV1 {
  return (body) => {
    const p = body.proposition;
    if (p.kind !== "atom" || p.value.kind !== "literal") throw new Error("Expected economic atom");
    return { ...body, proposition: { ...p, value: { ...p.value, data: change(p.value.data as unknown as EconomicRecordValue) as JsonValue } } };
  };
}
const bad: readonly [string, AuthoringEconomicRecord, (value: EconomicRecordValue) => unknown, RegExp][] = [
  ["unreduced rational", stock(), (v) => ({ ...v, quantity: { unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator: "2", denominator: "4" } } } }), /reduced/],
  ["negative stock", stock(), (v) => ({ ...v, quantity: { unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator: "-1", denominator: "1" } } } }), /nonnegative/],
  ["negative bounded requirement", requirement(), (v) => ({ ...v, quantity: { unitId: "unit:tonne", magnitude: { kind: "bounded", lower: { numerator: "-1", denominator: "1" }, upper: { numerator: "1", denominator: "1" } } } }), /nonnegative/],
  ["resource", stock(), (v) => ({ ...v, resourceId: "item:missing" }), /economic entity/],
  ["owner", stock(), (v) => ({ ...v, owner: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["custodian", stock(), (v) => ({ ...v, custodian: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["location", stock(), (v) => ({ ...v, location: { kind: "declared", entityId: "faction:council" } }), /requires a place/],
  ["boundary member", stock(), (v) => ({ ...v, boundary: { kind: "declared", description: "Declared", entityIds: ["place:missing"] } }), /economic entity/],
  ["citation source", stock(), (v) => ({ ...v, citations: [{ sourceId: "source:missing", locator: "Entry" }] }), /citation source/],
  ["point axis", stock(), (v) => ({ ...v, reference: { kind: "mapped", axisDefinitionDigest: "a".repeat(64), position: "0" } }), /reference axis/],
  ["promisor", delivery(), (v) => ({ ...v, promisor: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["recipient", delivery(), (v) => ({ ...v, recipient: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["destination", delivery(), (v) => ({ ...v, destination: { kind: "declared", entityId: "faction:council" } }), /requires a place/],
  ["future relative axis", delivery(), (v) => ({ ...v, timing: { kind: "future-as-authored", relativeTo: { kind: "mapped", axisDefinitionDigest: "a".repeat(64), position: "0" } } }), /reference axis/],
  ["future ordering", delivery(), (v) => ({ ...v, timing: { kind: "future-as-authored", relativeTo: { kind: "mapped", axisDefinitionDigest: economySemantics().definitionDigestsByKey["days"], position: "2" } } }), /future.*after/i],
  ["period ordering", requirement(), (v) => ({ ...v, reference: { kind: "mapped", axisDefinitionDigest: economySemantics().definitionDigestsByKey["days"], start: "4", endExclusive: "3" } }), /start.*end/],
  ["planner", requirement(), (v) => ({ ...v, planner: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["beneficiary", requirement(), (v) => ({ ...v, beneficiary: { kind: "declared", entityId: "person:missing" } }), /economic entity/],
  ["duplicated scope", stock(), (v) => ({ ...v, context: { kind: "setting" } }), /Invalid economic/],
  ["numeric position", stock(), (v) => ({ ...v, reference: { kind: "mapped", axisDefinitionDigest: economySemantics().definitionDigestsByKey["days"], position: 0 } }), /Invalid economic/],
];

describe("ordinary economic bundle admission", () => {
  it("loads, validates, inspects and exports through the ordinary release paths and API shapes", () => withRoot((root) => {
    const built = buildAuthoringBundle(project([stock(), delivery(), requirement()]), join(root, "world"));
    const bundle = loadReleaseWorldBundle(join(root, "world"));
    expect(bundle.snapshot).toEqual(built.snapshot);
    expect(validateWorldBundle(bundle).status).toBe("valid");
    const response = (operation: string, data: unknown) => ({ format: "wmm.response/1", apiVersion: "wmm/1", requestId: "economic-test", operation, outcome: "success", execution: "completed", resolved: { worldId: bundle.world.worldId, snapshotDigest: bundle.snapshot.snapshotDigest }, data, diagnostics: [] });
    for (const record of [bundle.assertions[0]!, bundle.definitionsByDigest[economySemantics().definitionDigestsByKey["economic_record"]!]!, bundle.definitionsByDigest[economySemantics().definitionDigestsByKey["economic_record_value"]!]!]) {
      const id = "id" in record ? record.id : economySemantics().definitionDigestsByKey[record.key]!;
      expect(inspectWorldBundle(bundle, id)).toEqual(record);
      expect(validateApiResponse(response("record.inspect", record))).toEqual({ valid: true, errors: [] });
    }
    expect(validateApiResponse(response("world.export", exportWorldBundle(bundle)))).toEqual({ valid: true, errors: [] });
    expect(validateApiResponse(response("world.validate", validateWorldBundle(bundle))).valid).toBe(true);
    expect(validateEconomyView(readEconomyView(bundle)).valid).toBe(true);
    expect(() => loadBundledV1WorldBundle(join(root, "world"))).toThrow(/release-allowlisted/);
  }));
  it.each(bad)("rejects coherent-rehashed %s through the ordinary loader", (_label, record, change, message) => withRoot((root) => {
    const compiled = changedBundle(project([record]), literalChange(change));
    writeChangedBundle(compiled, join(root, "world"));
    try { loadReleaseWorldBundle(join(root, "world")); throw new Error("Malformed semantic record admitted"); }
    catch (error) {
      expect(error).toMatchObject({ code: "INVALID_WORLD" });
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toMatch(/identity mismatch|bytes do not match|digest mismatch/);
    }
  }));
  it.each(["predicate", "literal"])("rejects coherently rehashed %s pairing swaps", (swap) => withRoot((root) => {
    const compiled = changedBundle(project(), (body) => {
      const p = body.proposition;
      if (p.kind !== "atom" || p.value.kind !== "literal") throw new Error("Expected atom");
      return { ...body, proposition: swap === "predicate" ? { ...p, predicateDefinitionDigest: economySemantics().definitionDigestsByKey["related_to"]! } : { ...p, value: { kind: "literal", valueDefinitionDigest: economySemantics().definitionDigestsByKey["safe_integer"]!, data: 3 } } };
    });
    writeChangedBundle(compiled, join(root, "world"));
    expect(() => loadReleaseWorldBundle(join(root, "world"))).toThrow(/economic literal.*predicate|pinned economic literal/i);
  }));
  it.each(["notes", "sources", "inputDigest"])("rejects coherent-rehashed presentation %s while ordinary world loading still succeeds", (field) => withRoot((root) => {
    const compiled = changedBundle(project(), undefined, (path, value) => {
      if (path !== "authoring/index.json") return value;
      const index = value as import("@wmm/wire-contracts").AuthoringIndex;
      if (field === "notes") return { ...index, notes: index.notes.map((note) => ({ ...note, name: "Forged label" })) };
      if (field === "sources") return { ...index, sources: index.sources.map((source) => ({ ...source, title: "Forged source", path: "Forged/Path.md" })) };
      return { ...index, inputDigest: "f".repeat(64) };
    });
    writeChangedBundle(compiled, join(root, "world"));
    const loaded = loadReleaseWorldBundle(join(root, "world"));
    expect(loaded.snapshot.snapshotDigest).toBe(compiled.snapshot.snapshotDigest);
    expect(() => readEconomyView(loaded)).toThrow(/differs from its compiled input/);
  }));
  it("keeps old authoring-index and entity-context guards strict for economic profiles", () => withRoot((root) => {
    const bundle = buildAuthoringBundle(project(), join(root, "world"));
    expect(() => readAuthoringIndex(bundle)).toThrow(/authoring-profile/);
    expect(() => entityContextFromBundle(bundle, { entityId: "place:reedbank" })).toThrow(/currently requires an authored/);
    const brief = { format: "wmm.actor-brief/1", snapshotDigest: bundle.snapshot.snapshotDigest, actorId: "faction:council", question: "What should the council propose?", items: [{ id: "question", kind: "goal", text: "Plan cautiously", basis: [] }] };
    expect(() => actorContextFromBundle(bundle, brief)).toThrow(/Actor preparation requires an authored/);
    const decision = { format: "wmm.actor-decision/1", status: "proposed", contextDigest: "a".repeat(64), action: { text: "Ask about the stores", basis: ["question"] }, rationale: { text: "Stock remains an authored report", basis: ["question"] }, uncertainties: [], communication: null };
    expect(() => actorReviewFromBundle(bundle, brief, decision)).toThrow(/Actor preparation requires an authored/);
  }));
  it("reads the exact retained data without a bundle format or source filesystem", () => withRoot((root) => {
    const original = buildAuthoringBundle(project(), join(root, "world"));
    const { format: _format, ...retained } = original;
    const expected = readEconomyView(retained);
    rmSync(join(root, "world"), { recursive: true });
    expect(readEconomyView(retained)).toEqual(expected);
  }));
});
