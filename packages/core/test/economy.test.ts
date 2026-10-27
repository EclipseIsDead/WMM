import { describe, expect, it } from "vitest";
import type { AssertionRecordV1, AuthoringEconomicRecord, AuthoringIndex, CompiledAuthoringProject, DescriptorRecordV1, SourceRecordV1, SupportRecordV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import { buildEconomyView, compileAuthoringProject, economySemantics, validateWorldSemantics } from "../src/index.js";
import { stock, project, delivery, requirement } from "./helpers/economy.js";

function parse<T>(compiled: CompiledAuthoringProject, path: string): T {
  return JSON.parse(new TextDecoder().decode(compiled.payload.find((file) => file.path === path)!.bytes)) as T;
}
function recordInput(records: readonly AuthoringEconomicRecord[] = [stock()]) {
  const compiled = compileAuthoringProject(project(records));
  const all = <T>(prefix: string): T[] => compiled.payload.filter((file) => file.path.startsWith(prefix)).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as T);
  return { compiled, world: parse<WorldCatalogV1>(compiled, "world.json"), definitionsByDigest: economySemantics().definitionsByDigest,
    descriptors: all<DescriptorRecordV1>("records/descriptors/"), sources: all<SourceRecordV1>("records/sources/"), assertions: all<AssertionRecordV1>("records/assertions/"), supports: all<SupportRecordV1>("records/supports/") };
}

describe("economic domain admission", () => {
  it("requires an actual economic subject descriptor, not a catalog-only reference", () => {
    const input = recordInput();
    expect(() => validateWorldSemantics({ ...input, descriptors: input.descriptors.filter((descriptor) => descriptor.id !== "place:reedbank") })).toThrow(/economic subject.*entity/i);
  });
  it("requires cited economic sources to have actual admitted records, not just catalog IDs", () => {
    const input = recordInput();
    expect(() => validateWorldSemantics({ ...input, sources: input.sources.filter((source) => source.id !== "source:ledger") })).toThrow(/citation source/i);
  });
  it("requires economic citations to be declared sources, not the reserved stipulation support", () => {
    expect(() => compileAuthoringProject(project([{ ...stock(), citations: [{ sourceId: "source:wmm_authoring", locator: "Not a declared citation" }] }]))).toThrow(/Unknown citation source/);
  });
  it("rejects an economic literal attached to a non-economic predicate", () => {
    const input = recordInput();
    const digest = "d".repeat(64);
    const definitionsByDigest = { ...input.definitionsByDigest, [digest]: { format: "wmm.semantic-definition/1" as const, key: "presentation", kind: "predicate" as const, operation: "text-value-v1" as const, version: "1", dependencies: [] } };
    const assertions = input.assertions.map((record) => {
      const p = record.body.proposition;
      if (p.kind !== "atom") throw new Error("Expected atom");
      return { ...record, body: { ...record.body, proposition: { ...p, predicateDefinitionDigest: digest } } };
    });
    expect(() => validateWorldSemantics({ ...input, definitionsByDigest, assertions })).toThrow(/economic literal.*predicate/i);
  });
  it("rejects an accounting-scope descriptor as an economic subject in ordinary validation", () => {
    const input = recordInput();
    const assertions = input.assertions.map((record) => {
      const p = record.body.proposition;
      if (p.kind !== "atom") throw new Error("Expected atom");
      return { ...record, body: { ...record.body, proposition: { ...p, subjectId: "account:setting" } } };
    });
    expect(() => validateWorldSemantics({ ...input, assertions })).toThrow(/economic subject.*entity/i);
  });
  it("bounds economic records in ordinary admission even for noncompiler callers", () => {
    const input = recordInput(Array.from({ length: 64 }, (_, index) => ({ ...stock(), id: `report-${index}` })));
    const original = input.assertions[0]!;
    const p = original.body.proposition;
    if (p.kind !== "atom" || p.value.kind !== "literal") throw new Error("Expected economic atom");
    const extra = { ...original, id: `asrt:${"f".repeat(64)}`, body: { ...original.body, proposition: { ...p, value: { ...p.value, data: { ...(p.value.data as Record<string, never>), id: "overflow" } } } } };
    expect(() => validateWorldSemantics({ ...input, assertions: [...input.assertions, extra], world: { ...input.world, assertionIds: [...input.world.assertionIds, extra.id].sort(), activeAssertionIds: [...input.world.activeAssertionIds, extra.id].sort() } })).toThrow(/64|budget|too many economic/i);
  });
  it("rejects duplicate report IDs through ordinary world validation, not only the compiler", () => {
    const input = recordInput([stock(), { ...stock(), id: "another" }]);
    const assertions = input.assertions.map((record) => {
      const p = record.body.proposition;
      if (p.kind !== "atom" || p.value.kind !== "literal") throw new Error("Expected economic atom");
      return { ...record, body: { ...record.body, proposition: { ...p, value: { ...p.value, data: { ...(p.value.data as Record<string, never>), id: "collision" } } } } };
    });
    expect(() => validateWorldSemantics({ ...input, assertions })).toThrow(/duplicate economic.*id/i);
  });
  it("binds pure projection metadata to the captured project instead of trusting loose labels", () => {
    const input = recordInput();
    const index = parse<AuthoringIndex>(input.compiled, "authoring/index.json");
    const forged = { ...index, notes: index.notes.map((note) => ({ ...note, name: "Forged label" })) };
    expect(() => buildEconomyView({ snapshotDigest: input.compiled.snapshot.snapshotDigest, world: input.world, assertions: input.assertions, index: forged, project: project() })).toThrow(/correspondence|captured|differs/i);
  });
  it("rejects negative-polarity economic records through ordinary world validation", () => {
    const input = recordInput();
    const assertions = input.assertions.map((record) => ({ ...record, body: { ...record.body, polarity: "negative" as const } }));
    expect(() => validateWorldSemantics({ ...input, assertions })).toThrow(/positive.*invariant/i);
  });
  it("rejects duplicate entry IDs even when the reports differ", () => {
    expect(() => compileAuthoringProject(project([stock(), { ...stock(), description: "Different report, same ID" }]))).toThrow(/duplicate economic.*id/i);
  });
  it.each(["0", "-1"])("requires a future delivery to start after its authored point (%s)", (start) => {
    expect(() => compileAuthoringProject(project([{ ...delivery(), reference: { kind: "mapped", axisKey: "days", start, endExclusive: "3" } }]))).toThrow(/future.*after/i);
  });
  it.each([delivery(), requirement()])("requires a nonempty finite half-open period for $kind", (entry) => {
    expect(() => compileAuthoringProject(project([{ ...entry, reference: { kind: "mapped", axisKey: "days", start: "3", endExclusive: "3" } }]))).toThrow(/start.*end|period/i);
  });
  it.each([stock(), delivery(), requirement()])("requires nonnegative physical amounts for $kind", (entry) => {
    expect(() => compileAuthoringProject(project([{ ...entry, quantity: { unitId: "unit:kilogram", magnitude: { kind: "exact", value: { numerator: "-1", denominator: "1" } } } }]))).toThrow(/nonnegative/i);
  });
  it("rejects unreduced economic quantities rather than repairing authored tokens", () => {
    const entry = { ...stock(), quantity: { unitId: "unit:tonne", magnitude: { kind: "exact" as const, value: { numerator: "6", denominator: "2" } } } };
    expect(() => compileAuthoringProject(project([entry]))).toThrow(/reduced|canonical/i);
  });
});
