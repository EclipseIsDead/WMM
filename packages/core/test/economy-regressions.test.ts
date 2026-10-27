import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AssertionRecordV1, AuthoringEconomicRecord, AuthoringIndex, AuthoringProject, CompiledAuthoringProject, EconomicRecordValue, Quantity } from "@wmm/wire-contracts";
import { canonicalJsonBytes } from "@wmm/canonical";
import { admitEconomicRecordValue, authoringSemantics, bundledV1Semantics, buildEconomyView, compileAuthoringProject, economySemantics } from "../src/index.js";
import { stock, project, delivery, requirement } from "./helpers/economy.js";

function json<T>(compiled: CompiledAuthoringProject, path: string): T { return JSON.parse(new TextDecoder().decode(compiled.payload.find((file) => file.path === path)!.bytes)) as T; }
function projection(input: AuthoringProject) {
  const compiled = compileAuthoringProject(input);
  return { snapshotDigest: compiled.snapshot.snapshotDigest, project: input, world: json<import("@wmm/wire-contracts").WorldCatalogV1>(compiled, "world.json"), index: json<AuthoringIndex>(compiled, "authoring/index.json"), assertions: compiled.payload.filter((file) => file.path.startsWith("records/assertions/")).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as AssertionRecordV1) };
}
function literal(): EconomicRecordValue { return buildEconomyView(projection(project())).records[0]!.value; }
const context = () => ({ entityIds: new Set(project().entities.map((entity) => entity.id)), placeIds: new Set(["place:reedbank", "place:store"]), sourceIds: new Set(["source:ledger"]), definitionsByDigest: economySemantics().definitionsByDigest });

describe("economic compatibility and completeness", () => {
  it("preserves both legacy profiles and the exact no-envelope fixture snapshot", () => {
    expect(bundledV1Semantics().profileDigest).toBe("4206429e2658b6f9847cbc7f48b0be91f342ebc297b9bfc5efec7b62922f28cf");
    expect(authoringSemantics().profileDigest).toBe("2c7babeb2121850c51cc3b76e77cc4161602a5cb5a35b011cec30ba67b44d544");
    const old = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as unknown;
    expect(compileAuthoringProject(old).snapshot.snapshotDigest).toBe("f21f10ae1e4f7efb972d0c1cdee08e96b83ee10e0342e207b82bacb5d5f9f1f1");
    const { economy: _economy, ...without } = project();
    const first = compileAuthoringProject(without);
    expect(first).toEqual(compileAuthoringProject(without));
    expect(json<{ semanticProfileDigest: string }>(first, "world.json").semanticProfileDigest).toBe(authoringSemantics().profileDigest);
    expect(json<{ semanticProfileDigest: string }>(compileAuthoringProject(project([])), "world.json").semanticProfileDigest).toBe(economySemantics().profileDigest);
  });
  it("pins distinct release-owned economic operations without changing authoringSemantics", () => {
    const semantics = economySemantics();
    const predicate = semantics.definitionsByDigest[semantics.definitionDigestsByKey["economic_record"]!]!;
    const value = semantics.definitionsByDigest[semantics.definitionDigestsByKey["economic_record_value"]!]!;
    expect(predicate).toMatchObject({ kind: "predicate", operation: "economic-record-atom-v1", dependencies: [semantics.definitionDigestsByKey["economic_record_value"]] });
    expect(value).toMatchObject({ kind: "literal", operation: "economic-record-literal-v1" });
    expect(authoringSemantics().definitionDigestsByKey["economic_record"]).toBeUndefined();
    expect(Object.isFrozen(semantics.profile)).toBe(true);
  });
  it("retains equal reports as distinct assertions and excludes them from fact/track indexes", () => {
    const input = projection(project([stock(), { ...stock(), id: "independent-report" }]));
    const view = buildEconomyView(input);
    expect(view.records).toHaveLength(2);
    expect(new Set(view.records.map((record) => record.assertionId)).size).toBe(2);
    expect(view.records.map((record) => record.value.id).sort()).toEqual(["independent-report", "opening"]);
    expect(input.index.notes.every((note) => note.facts.length === 0 && note.track === null)).toBe(true);
  });
  it("keeps authored contexts, invariant applicability, citations and captured-project supports", () => {
    const input: AuthoringProject = { ...project([stock(), { ...stock(), id: "campaign-report", context: { kind: "campaign", campaignId: "campaign:spring" } }]), campaigns: [{ id: "campaign:spring", name: "Spring", sections: [], tracks: [] }] };
    const compiled = compileAuthoringProject(input);
    const view = buildEconomyView(projection(input));
    expect(view.records.map((record) => record.scope.account).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ kind: "ref", id: "account:campaign_spring" }, { kind: "ref", id: "account:setting" }]);
    for (const record of projection(input).assertions) expect(record.body).toMatchObject({ polarity: "positive", applicability: { kind: "invariant" } });
    for (const record of view.records) expect(record.value.citations).toEqual(stock().citations);
    const supports = compiled.payload.filter((file) => file.path.startsWith("records/supports/")).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as import("@wmm/wire-contracts").SupportRecordV1);
    expect(supports).toHaveLength(2);
    for (const support of supports) expect(support.body).toMatchObject({ sourceId: "source:wmm_authoring", stance: "supports", sourceContentDigest: view.inputDigest, locator: { data: { kind: "authorStipulation" } } });
  });
  it.each([{ kind: "unmapped", label: "After the thaw" }, { kind: "unknown" }] as const)("retains explicit $kind references without inventing an axis or clock mapping", (reference) => {
    const input = project([{ ...stock(), status: "reported-estimate", reference }, { ...delivery(), reference, timing: { kind: "future-as-authored", relativeTo: reference } }, { ...requirement(), reference }]);
    const view = buildEconomyView(projection(input));
    expect(view.records.map((record) => record.value.reference)).toEqual([reference, reference, reference]);
    expect(view.axes).toEqual([]);
    expect(view.records.find((record) => record.value.kind === "stock-observation")?.value).toMatchObject({ status: "reported-estimate" });
  });
  it("does not compare unmapped future labels with mapped periods or use computer time", () => {
    const entry = { ...delivery(), reference: { kind: "mapped" as const, axisKey: "days", start: "-20", endExclusive: "-10" }, timing: { kind: "future-as-authored" as const, relativeTo: { kind: "unmapped" as const, label: "Tomorrow as authored" } } };
    expect(buildEconomyView(projection(project([entry]))).records[0]?.value).toMatchObject({ reference: { start: "-20", endExclusive: "-10" }, timing: entry.timing });
  });
  it("retains unknown and inclusive bounded quantities without equating them with zero", () => {
    const quantity: Quantity = { unitId: "unit:one", magnitude: { kind: "unknown" } };
    const bounded: Quantity = { unitId: "unit:kilogram", magnitude: { kind: "bounded", lower: { numerator: "0", denominator: "1" }, upper: { numerator: "1", denominator: "3" } } };
    const view = buildEconomyView(projection(project([{ ...stock(), quantity }, { ...requirement(), quantity: bounded }])));
    expect(view.records.find((record) => record.value.id === "opening")?.value.quantity).toEqual(quantity);
    expect(view.records.find((record) => record.value.id === "food-plan")?.value.quantity).toEqual(bounded);
  });
  it("fails a complete-view byte budget instead of dropping whole reports or labels", () => {
    const records = Array.from({ length: 20 }, (_, index) => ({ ...stock(), id: `large-${index}`, description: "x".repeat(60000) }));
    const input = projection(project(records));
    expect(() => buildEconomyView(input)).toThrow(/byte budget/i);
  });
  it("admits 64 complete records and rejects the 65th before producing an artifact", () => {
    const records = Array.from({ length: 64 }, (_, index) => ({ ...stock(), id: `report-${index}` }));
    const view = buildEconomyView(projection(project(records)));
    expect(view.records).toHaveLength(64);
    expect(() => compileAuthoringProject(project([...records, { ...stock(), id: "overflow" }]))).toThrow(/Invalid authoring project/);
  });
});

describe("economic reference and quantity rejection", () => {
  const failures: readonly [string, AuthoringEconomicRecord][] = [
    ["subject", { ...stock(), subjectId: "place:missing" }], ["resource", { ...stock(), resourceId: "item:missing" }],
    ["owner", { ...stock(), owner: { kind: "declared", entityId: "faction:missing" } }], ["custodian", { ...stock(), custodian: { kind: "declared", entityId: "person:missing" } }],
    ["location closure", { ...stock(), location: { kind: "declared", entityId: "place:missing" } }], ["location type", { ...stock(), location: { kind: "declared", entityId: "faction:council" } }],
    ["boundary", { ...stock(), boundary: { kind: "declared", description: "Declared", entityIds: ["place:missing"] } }], ["source", { ...stock(), citations: [{ sourceId: "source:missing", locator: "Entry" }] }],
    ["axis", { ...stock(), reference: { kind: "mapped", axisKey: "unadmitted", position: "0" } }], ["campaign", { ...stock(), context: { kind: "campaign", campaignId: "campaign:missing" } }],
    ["promisor", { ...delivery(), promisor: { kind: "declared", entityId: "person:missing" } }], ["recipient", { ...delivery(), recipient: { kind: "declared", entityId: "place:missing" } }],
    ["destination", { ...delivery(), destination: { kind: "declared", entityId: "faction:council" } }], ["relative point axis", { ...delivery(), timing: { kind: "future-as-authored", relativeTo: { kind: "mapped", axisKey: "missing", position: "0" } } }],
    ["planner", { ...requirement(), planner: { kind: "declared", entityId: "person:missing" } }], ["beneficiary", { ...requirement(), beneficiary: { kind: "declared", entityId: "place:missing" } }],
    ["inverted period", { ...requirement(), reference: { kind: "mapped", axisKey: "days", start: "3", endExclusive: "2" } }],
  ];
  it.each(failures)("rejects dangling or wrong-role %s references", (_label, entry) => { expect(() => compileAuthoringProject(project([entry]))).toThrow(); });
  const badQuantities: readonly Quantity[] = [
    { unitId: "unit:sacks", magnitude: { kind: "unknown" } },
    ...["-0", "01", "+1", "1e3", "1".repeat(65)].map((numerator): Quantity => ({ unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator, denominator: "1" } } })),
    { unitId: "unit:one", magnitude: { kind: "exact", value: { numerator: "0", denominator: "2" } } },
    { unitId: "unit:one", magnitude: { kind: "exact", value: { numerator: "1", denominator: "0" } } },
    { unitId: "unit:one", magnitude: { kind: "bounded", lower: { numerator: "-1", denominator: "1" }, upper: { numerator: "1", denominator: "1" } } },
    { unitId: "unit:one", magnitude: { kind: "bounded", lower: { numerator: "2", denominator: "1" }, upper: { numerator: "1", denominator: "1" } } },
    { unitId: "unit:one", magnitude: { kind: "bounded", lower: { numerator: "0", denominator: "1" }, upper: { numerator: "2", denominator: "4" } } },
  ];
  it.each(badQuantities)("rejects noncanonical, unadmitted or negative physical quantity %#", (quantity) => { expect(() => compileAuthoringProject(project([{ ...stock(), quantity }]))).toThrow(); });
  it.each(["00", "-0", "+1", "1.0", "1e3", "1".repeat(65)])("rejects noncanonical mapped position %s", (position) => { expect(() => compileAuthoringProject(project([{ ...stock(), reference: { kind: "mapped", axisKey: "days", position } }]))).toThrow(); });
});

describe("detached economic programmatic admission", () => {
  it("does not execute caller-owned nested methods or freeze the caller", () => {
    const value = literal();
    const citations = [...value.citations];
    let calls = 0;
    Object.setPrototypeOf(citations, Object.create(Array.prototype, { map: { get: () => { calls += 1; throw new Error("map getter"); } }, [Symbol.iterator]: { get: () => { calls += 1; throw new Error("iterator getter"); } } }));
    const input = { ...value, citations };
    const admitted = admitEconomicRecordValue(input, context());
    expect(admitted).toEqual(value);
    expect(admitted.citations).not.toBe(citations);
    expect(Object.isFrozen(input)).toBe(false);
    expect(calls).toBe(0);
  });
  it("rejects nested accessors and proxies before reading or canonicalizing them", () => {
    let calls = 0;
    const value = literal();
    Object.defineProperty(value, "quantity", { enumerable: true, get: () => { calls += 1; throw new Error("getter"); } });
    expect(() => admitEconomicRecordValue(value, context())).toThrow(/Invalid economic/);
    expect(() => admitEconomicRecordValue(new Proxy({}, { ownKeys: () => { calls += 1; throw new Error("proxy"); } }), context())).toThrow(/Invalid economic/);
    expect(calls).toBe(0);
  });
  it("detaches compiler arrays and preserves caller-owned input bytes", () => {
    const input = project();
    const before = canonicalJsonBytes(input as never);
    let calls = 0;
    Object.setPrototypeOf(input.economy!.records, Object.create(Array.prototype, { [Symbol.iterator]: { get: () => { calls += 1; throw new Error("iterator"); } } }));
    compileAuthoringProject(input);
    expect(canonicalJsonBytes(input as never)).toEqual(before);
    expect(Object.isFrozen(input.economy)).toBe(false);
    expect(calls).toBe(0);
  });
});
