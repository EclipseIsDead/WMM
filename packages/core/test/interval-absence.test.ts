import { describe, expect, it } from "vitest";

import {
  absenceEvaluationDigest,
  coverageInputSelectionDigest,
  intervalAbsenceEvaluationDigest,
  populationRosterDigest,
} from "@wmm/canonical";
import { evaluateApplicability } from "@wmm/temporal";
import type {
  AbsenceEvaluationBodyV1,
  AbsenceQueryResultV1,
  AssertionRecordV1,
  ClaimBodyV1,
  IntervalAbsenceEvaluationBodyV1,
  IntervalAbsenceLimitsV1,
  IntervalAbsenceResultV1,
  IntervalPartitionIssueV1,
  TemporalQueryV1,
  ThroughoutTemporalQueryV1,
} from "@wmm/wire-contracts";
import { validateSemanticContract } from "@wmm/wire-contracts";
import {
  IntervalAbsenceBudgetError,
  proveAbsenceThroughout,
  queryAbsence,
  resolvePopulationSelector,
  selectCoverageInputs,
  verifyAbsenceReceiptIntegrity,
  verifyIntervalAbsenceReceipt,
  verifyIntervalAbsenceReceiptIntegrity,
} from "../src/index.js";
import {
  buildSnapshot, findAssertion, operation, originalSnapshot, record, request,
} from "./absence-fixture.js";

type Snapshot = ReturnType<typeof buildSnapshot>;
type SnapshotOptions = NonNullable<Parameters<typeof buildSnapshot>[0]>;

const snapshot = buildSnapshot();
const axis = request.payload.temporal.axisDefinitionDigest;
const coverage = findAssertion((assertion) => operation(assertion) === "population-coverage-atom-v1");
const declaration = findAssertion((assertion) => assertion.body.proposition.kind === "exists");
const membership = (id: string) => findAssertion((assertion) =>
  operation(assertion) === "population-membership-atom-v1" &&
  assertion.body.proposition.kind === "atom" && assertion.body.proposition.subjectId === id,
);
const ineligible = (id: string) => findAssertion((assertion) =>
  operation(assertion) === "criterion-satisfaction-atom-v1" && assertion.body.polarity === "negative" &&
  assertion.body.proposition.kind === "atom" && assertion.body.proposition.subjectId === id,
);

function throughout(start = "1000", endExclusive = "1030"): ThroughoutTemporalQueryV1 {
  return { format: "wmm.temporal-query/1", mode: "throughout", axisDefinitionDigest: axis, start, endExclusive };
}

function at(position: string) {
  return { format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: axis, position } as const;
}

function prove(
  temporal: TemporalQueryV1 = throughout(),
  input = snapshot,
  limits?: Partial<IntervalAbsenceLimitsV1>,
) {
  return proveAbsenceThroughout(input, request.payload.target, request.payload.scope, temporal, limits);
}

function pointWitness(position = "1005"): AssertionRecordV1 {
  return record({
    ...ineligible("person:alys").body,
    polarity: "positive",
    applicability: { kind: "point", axisDefinitionDigest: axis, position: { kind: "exact", position } },
  });
}

function coverageFor(input: Snapshot, body = coverage.body): AssertionRecordV1 {
  const proposition = coverage.body.proposition;
  const roster = input.rosters[0]?.body;
  const bindings = resolvePopulationSelector(request.payload.target.population.definitionDigest, input.definitionsByDigest);
  if (proposition.kind !== "atom" || proposition.value.kind !== "literal" || roster === undefined || bindings === undefined) {
    throw new Error("Missing coverage fixture inputs");
  }
  const active = new Set(input.activeAssertionIds);
  // Membership selection is global, but its commitment uses coverage's own context.
  const selection = selectCoverageInputs(
    input.worldId, request.payload.target.population.definitionDigest, bindings,
    body.scope, body.applicability,
    input.assertions.filter((assertion) => active.has(assertion.id)), input.descriptors,
  );
  return record({
    ...body,
    proposition: {
      ...proposition,
      value: {
        ...proposition.value,
        data: {
          format: "wmm.population-coverage-basis/1",
          populationDefinitionDigest: request.payload.target.population.definitionDigest,
          selectorDefinitionDigest: selection.selectorDefinitionDigest,
          rosterDigest: populationRosterDigest(roster),
          inputSelectionDigest: coverageInputSelectionDigest(selection),
          coverageMethod: "authorAttested",
        },
      },
    },
  });
}

function withRenewedCoverage(options: SnapshotOptions, body = coverage.body) {
  const deactivate = [...new Set([...(options.deactivate ?? []), coverage.id])];
  const changed = buildSnapshot({ ...options, deactivate });
  const renewed = coverageFor(changed, body);
  return {
    coverage: renewed,
    snapshot: buildSnapshot({
      ...options,
      deactivate: deactivate.filter((id) => id !== renewed.id),
      activate: [...(options.activate ?? []), renewed],
    }),
  };
}

function rehash(body: IntervalAbsenceEvaluationBodyV1): IntervalAbsenceResultV1 {
  return { ...body, evaluationDigest: intervalAbsenceEvaluationDigest(body) };
}

function expectValidReceipt(result: IntervalAbsenceResultV1, input = snapshot): void {
  const { evaluationDigest, ...body } = result;
  expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
  expect(evaluationDigest).toBe(intervalAbsenceEvaluationDigest(body));
  expect(result).toMatchObject({
    format: "wmm.interval-absence-result/1",
    algorithm: "bundled-absence-throughout-v1",
    worldId: input.worldId,
    snapshotDigest: input.snapshotDigest,
    target: request.payload.target,
    scope: request.payload.scope,
    execution: "completed",
  });
  expect(verifyIntervalAbsenceReceiptIntegrity(result))
    .toEqual({ valid: true, verification: "integrity-only", errors: [] });
  expect(verifyIntervalAbsenceReceipt(result, input))
    .toEqual({ valid: true, verification: "snapshot-replay", errors: [] });
  for (const [index, cell] of result.cells.entries()) {
    expect(cell.start).toBe(result.breakpoints[index]);
    expect(cell.endExclusive).toBe(result.breakpoints[index + 1]);
    expect(cell.representativePosition).toBe(cell.start);
    expect(cell.evaluation).toEqual(queryAbsence(
      input, result.target, result.scope,
      { ...at(cell.representativePosition), axisDefinitionDigest: result.temporal.axisDefinitionDigest },
    ));
  }
}

const relevantFamilies = [
  { name: "eligibility", assertion: ineligible("person:alys") },
  { name: "coverage", assertion: coverage },
  { name: "membership", assertion: membership("person:alys") },
] as const;
const uncertainties: readonly {
  readonly name: string;
  readonly reason: IntervalPartitionIssueV1["reason"];
  readonly change: (body: ClaimBodyV1) => ClaimBodyV1;
}[] = [
  {
    name: "bounded point",
    reason: "uncertain-change-position",
    change: (body) => ({
      ...body,
      applicability: {
        kind: "point", axisDefinitionDigest: axis,
        position: { kind: "boundedUnknown", lowerInclusive: "1005", upperExclusive: "1007" },
      },
    }),
  },
  {
    name: "unknown interval start",
    reason: "uncertain-change-position",
    change: (body) => ({
      ...body,
      applicability: {
        kind: "interval", axisDefinitionDigest: axis,
        start: { kind: "unknown" }, endExclusive: { kind: "exact", position: "1030" },
      },
    }),
  },
  {
    name: "unresolved scope",
    reason: "unresolved-scope",
    change: (body) => ({ ...body, scope: { ...body.scope, jurisdiction: { kind: "unresolved" } } }),
  },
];

describe("interval absence partitions", () => {
  it("establishes [1000, 1030) in one cell using the unchanged fixture identity", () => {
    expect(snapshot.snapshotDigest).toBe(originalSnapshot.snapshotDigest);
    const result = prove();
    expect(result).toMatchObject({ status: "established", reason: "all-cells-ineligible", temporal: throughout() });
    expect(result.breakpoints).toEqual(["1000", "1030"]);
    expect(result.partitionIssues).toEqual([]);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toMatchObject({
      start: "1000", endExclusive: "1030", representativePosition: "1000",
      evaluation: { derivation: { status: "established", reason: "all-candidates-ineligible" } },
    });
    expectValidReceipt(result);
  });

  it("records the witness at breakpoint 1030 rather than sampling only 1029", () => {
    const result = prove(throughout("1029", "1031"));
    expect(result).toMatchObject({ status: "not-established", reason: "recorded-witness" });
    expect(result.breakpoints).toEqual(["1029", "1030", "1031"]);
    expect(result.partitionIssues).toEqual([]);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]?.evaluation.derivation.status).toBe("established");
    expect(result.cells[1]).toMatchObject({
      start: "1030", endExclusive: "1031", representativePosition: "1030",
      evaluation: {
        derivation: { status: "not-established", reason: "recorded-witness" },
        witnesses: { status: "recorded", candidateIds: ["person:bran"] },
      },
    });
    expectValidReceipt(result);
  });

  it("keeps the uncovered [990, 1000) cell instead of extending later coverage backwards", () => {
    const result = prove(throughout("990", "1005"));
    expect(result).toMatchObject({ status: "not-established", reason: "cell-not-established" });
    expect(result.breakpoints).toEqual(["990", "1000", "1005"]);
    expect(result.partitionIssues).toEqual([]);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]?.evaluation.derivation).toMatchObject({ status: "not-established", reason: "coverage-not-established" });
    expect(result.cells[1]?.evaluation.derivation.status).toBe("established");
    expectValidReceipt(result);
  });

  it("isolates a positive point witness to [1005, 1006), preserving instant semantics", () => {
    const witness = pointWitness();
    const input = buildSnapshot({ activate: [witness] });
    expect(input.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    const result = prove(throughout(), input);
    expect(result).toMatchObject({ status: "not-established", reason: "recorded-witness" });
    expect(result.breakpoints).toEqual(["1000", "1005", "1006", "1030"]);
    expect(result.cells).toHaveLength(3);
    expect(result.cells.map((cell) => cell.evaluation.witnesses.status))
      .toEqual(["none-recorded", "recorded", "none-recorded"]);
    expect(result.cells[1]).toMatchObject({
      start: "1005", endExclusive: "1006", representativePosition: "1005",
      evaluation: { witnesses: { candidateIds: ["person:alys"] } },
    });
    expect(result.cells[0]?.evaluation.derivation.status).toBe("established");
    expect(result.cells[2]?.evaluation.derivation.status).toBe("established");
    expect(result.constancyDeclarations).toContainEqual(expect.objectContaining({
      assertionId: witness.id, provider: "recorded-applicability-v1", changePositions: ["1005", "1006"],
    }));
    expect(evaluateApplicability(witness.body.applicability, throughout("1005", "1006")))
      .toMatchObject({ kind: "excluded", reason: "applicabilityType" });
    expect(input.assertions.find((assertion) => assertion.id === witness.id)).toEqual(witness);
    expectValidReceipt(result, input);

    const singleton = prove(throughout("1005", "1006"), input);
    expect(singleton).toMatchObject({ status: "not-established", reason: "recorded-witness" });
    expect(singleton.breakpoints).toEqual(["1005", "1006"]);
    expect(singleton.cells).toHaveLength(1);
    expectValidReceipt(singleton, input);
    const after = prove(throughout("1006", "1007"), input);
    expect(after).toMatchObject({ status: "established", reason: "all-cells-ineligible" });
    expectValidReceipt(after, input);
  });

  it("does not derive a throughout proof from an authorial absence declaration alone", () => {
    const input = buildSnapshot({ deactivate: snapshot.activeAssertionIds.filter((id) => id !== declaration.id) });
    expect(input.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    const result = prove(throughout(), input);
    expect(result).toMatchObject({ status: "not-established", reason: "cell-not-established" });
    expect(result.breakpoints).toEqual(["1000", "1030"]);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]?.evaluation).toMatchObject({
      conclusion: { status: "absence-declared", bases: ["declared"] },
      derivation: { status: "not-established", reason: "coverage-not-established" },
    });
    expectValidReceipt(result, input);
  });
});

describe("interval absence relevance and uncertainty", () => {
  for (const family of relevantFamilies) {
    for (const uncertainty of uncertainties) {
      it(`leaves relevant ${family.name} with ${uncertainty.name} unresolved without evaluating cells`, () => {
        let changed = record(uncertainty.change(family.assertion.body));
        let input: Snapshot;
        if (family.name === "coverage") {
          const renewed = withRenewedCoverage({}, changed.body);
          changed = renewed.coverage;
          input = renewed.snapshot;
        } else {
          const options = { deactivate: [family.assertion.id], activate: [changed] };
          input = family.name === "membership" ? withRenewedCoverage(options).snapshot : buildSnapshot(options);
        }
        expect(input.snapshotDigest).not.toBe(snapshot.snapshotDigest);
        if (family.name === "membership") {
          const point = queryAbsence(input, request.payload.target, request.payload.scope, at("1005"));
          expect(point.derivation.coverageChecks).toHaveLength(1);
          expect(point.derivation.coverageChecks[0]).toMatchObject({
            status: "matched",
            inputSelection: { scope: coverage.body.scope, applicability: coverage.body.applicability },
          });
          expect(point.derivation.staleCoverageAssertionIds).toEqual([]);
        }
        const result = prove(throughout(), input);
        expect(result).toMatchObject({ status: "not-established", reason: "partition-unresolved", cells: [] });
        expect(result.partitionIssues).toContainEqual({ assertionId: changed.id, reason: uncertainty.reason });
        expectValidReceipt(result, input);
      });
    }
  }

  for (const uncertainty of uncertainties) {
    it(`ignores an unrelated atom with ${uncertainty.name}`, () => {
      const unrelated = findAssertion((assertion) => assertion.body.proposition.kind === "atom" &&
        !["population-membership-atom-v1", "population-coverage-atom-v1", "criterion-satisfaction-atom-v1"].includes(operation(assertion) ?? ""));
      const changed = record(uncertainty.change(unrelated.body));
      const input = buildSnapshot({ activate: [changed] });
      const result = prove(throughout(), input);
      expect(result).toMatchObject({ status: "established", reason: "all-cells-ineligible", partitionIssues: [] });
      expect(result.breakpoints).toEqual(["1000", "1030"]);
      expect(result.cells).toHaveLength(1);
      expect(result.constancyDeclarations.map((entry) => entry.assertionId)).not.toContain(changed.id);
      expectValidReceipt(result, input);
    });
  }

  for (const family of relevantFamilies) {
    it(`ignores uncertain ${family.name} in a definitely different scope`, () => {
      const uncertain = uncertainties[0]!.change(family.assertion.body);
      const body: ClaimBodyV1 = {
        ...uncertain,
        scope: {
          ...uncertain.scope,
          account: { kind: "notApplicable" },
          jurisdiction: { kind: "unresolved" },
        },
      };
      const changed = family.name === "coverage" ? coverageFor(snapshot, body) : record(body);
      const options = { activate: [changed] };
      // Even an excluded membership variant changes the coarse coverage commitment.
      const input = family.name === "membership" ? withRenewedCoverage(options).snapshot : buildSnapshot(options);
      const result = prove(throughout(), input);
      expect(result).toMatchObject({ status: "established", reason: "all-cells-ineligible", partitionIssues: [] });
      expect(result.breakpoints).toEqual(["1000", "1030"]);
      expect(result.cells).toHaveLength(1);
      expectValidReceipt(result, input);
    });
  }

  it("blocks relevant assertions on an unmapped query axis", () => {
    const temporal = { ...throughout(), axisDefinitionDigest: "f".repeat(64) };
    const result = prove(temporal);
    expect(result).toMatchObject({ status: "not-established", reason: "partition-unresolved", cells: [] });
    expect(result.partitionIssues).toContainEqual({ assertionId: coverage.id, reason: "unmapped-axis" });
    expectValidReceipt(result);
  });
});

describe("interval absence numeric ordering and determinism", () => {
  it.each([
    {
      name: "negative positions",
      start: "-20", endExclusive: "0", points: ["-10", "-2"],
      breakpoints: ["-20", "-10", "-9", "-2", "-1", "0"],
    },
    {
      name: "positions beyond Number precision",
      start: "90071992547409931234567889", endExclusive: "90071992547409931234567895",
      points: ["90071992547409931234567890", "90071992547409931234567893"],
      breakpoints: [
        "90071992547409931234567889", "90071992547409931234567890", "90071992547409931234567891",
        "90071992547409931234567893", "90071992547409931234567894", "90071992547409931234567895",
      ],
    },
  ])("sorts and deduplicates $name numerically, including point successors", ({ start, endExclusive, points, breakpoints }) => {
    const applicability: ClaimBodyV1["applicability"] = {
      kind: "interval", axisDefinitionDigest: axis,
      start: { kind: "exact", position: start }, endExclusive: { kind: "exact", position: endExclusive },
    };
    const activate = ["person:alys", "person:bran"].flatMap((id) => [
      record({ ...membership(id).body, applicability }),
      record({ ...ineligible(id).body, applicability }),
    ]).concat(points.map((position) => pointWitness(position)));
    const input = withRenewedCoverage(
      { deactivate: snapshot.activeAssertionIds, activate }, { ...coverage.body, applicability },
    ).snapshot;
    const result = prove(throughout(start, endExclusive), input);
    expect(result).toMatchObject({ status: "not-established", reason: "recorded-witness", partitionIssues: [] });
    expect(result.breakpoints).toEqual(breakpoints);
    expect(result.cells).toHaveLength(breakpoints.length - 1);
    expect(result.cells.map((cell) => cell.representativePosition)).toEqual(breakpoints.slice(0, -1));
    expectValidReceipt(result, input);
  });

  it("has identical receipts under record permutations while catalog assertion IDs remain sorted", () => {
    const witnesses = [pointWitness("1005"), pointWitness("1015")];
    const left = buildSnapshot({ activate: witnesses });
    const right = buildSnapshot({ activate: [...witnesses].reverse() });
    expect(left.activeAssertionIds).toEqual([...new Set(left.activeAssertionIds)].sort());
    expect(right.activeAssertionIds).toEqual(left.activeAssertionIds);
    expect(right.snapshotDigest).toBe(left.snapshotDigest);
    const permuted: Snapshot = {
      ...right,
      assertions: [...right.assertions].reverse(),
      descriptors: [...right.descriptors].reverse(),
      rosters: [...right.rosters].reverse(),
      definitionsByDigest: Object.fromEntries(Object.entries(right.definitionsByDigest).reverse()),
    };
    const expected = prove(throughout(), left);
    expect(prove(throughout(), right)).toEqual(expected);
    expect(prove(throughout(), permuted)).toEqual(expected);
    expectValidReceipt(expected, permuted);
  });
});

describe("interval absence budgets and invalid queries", () => {
  it("accepts exactly enough cells without changing the partition", () => {
    const result = prove(throughout("1029", "1031"), snapshot, { maxCells: 2 });
    expect(result.limits.maxCells).toBe(2);
    expect(result.breakpoints).toEqual(["1029", "1030", "1031"]);
    expect(result.cells).toHaveLength(2);
    expectValidReceipt(result);
  });

  it.each([
    { name: "maxCells", temporal: throughout("1029", "1031"), limits: { maxCells: 1 } },
    { name: "maxWorkUnits", temporal: throughout(), limits: { maxWorkUnits: 1 } },
  ])("throws IntervalAbsenceBudgetError without returning a result on $name exhaustion", ({ temporal, limits }) => {
    let result: IntervalAbsenceResultV1 | undefined;
    let thrown: unknown;
    try {
      result = prove(temporal, snapshot, limits);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntervalAbsenceBudgetError);
    expect(result).toBeUndefined();
    expect(thrown).not.toHaveProperty("result");
    expect(thrown).not.toHaveProperty("evaluationDigest");
  });

  it.each([
    { name: "empty extent", start: "1000", endExclusive: "1000" },
    { name: "reversed extent", start: "1030", endExclusive: "1000" },
    { name: "noncanonical start", start: "01000", endExclusive: "1030" },
    { name: "negative zero", start: "-0", endExclusive: "1030" },
    { name: "fractional end", start: "1000", endExclusive: "1030.5" },
  ])('rejects $name instead of returning a proof', ({ start, endExclusive }) => {
    expect(proveAbsenceThroughout).toBeTypeOf("function");
    expect(() => prove(throughout(start, endExclusive))).toThrow();
  });

  it("rejects intersects rather than treating overlap as throughout", () => {
    expect(proveAbsenceThroughout).toBeTypeOf("function");
    expect(() => prove({ ...throughout(), mode: "intersects" })).toThrow();
  });

  it("rejects an at query rather than silently widening an instant", () => {
    expect(proveAbsenceThroughout).toBeTypeOf("function");
    expect(() => prove(at("1005"))).toThrow();
  });
});

describe("interval absence receipt integrity versus snapshot replay", () => {
  it.each([
    { name: "null", input: null },
    { name: "object", input: {} },
    { name: "array", input: [] },
  ])("rejects a malformed receipt: $name", ({ input }) => {
    const integrity = verifyIntervalAbsenceReceiptIntegrity(input);
    expect(integrity).toMatchObject({ valid: false, verification: "integrity-only" });
    expect(integrity.errors.length).toBeGreaterThan(0);
    const replay = verifyIntervalAbsenceReceipt(input, snapshot);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors.length).toBeGreaterThan(0);
  });

  it("rejects unrehashed digest, breakpoint, and embedded-cell edits", () => {
    const result = prove();
    const edits = [
      { ...result, evaluationDigest: "0".repeat(64) },
      { ...result, breakpoints: ["1001", "1030"] },
      {
        ...result,
        cells: result.cells.map((cell) => ({
          ...cell,
          evaluation: { ...cell.evaluation, conclusion: { status: "absence-not-established", bases: [] } },
        })),
      },
    ];
    for (const edited of edits) {
      const integrity = verifyIntervalAbsenceReceiptIntegrity(edited);
      expect(integrity).toMatchObject({ valid: false, verification: "integrity-only" });
      expect(integrity.errors.length).toBeGreaterThan(0);
      expect(verifyIntervalAbsenceReceipt(edited, snapshot).valid).toBe(false);
    }
  });

  it("replays fake cell conclusions even after both nested and interval receipts are rehashed", () => {
    const result = prove(throughout("1029", "1031"));
    const cell = result.cells[1]!;
    const { evaluationDigest: _pointDigest, ...pointBody } = cell.evaluation.derivation;
    const falsePointBody: AbsenceEvaluationBodyV1 = {
      ...pointBody,
      status: "established", reason: "all-candidates-ineligible",
      candidates: pointBody.candidates.map((candidate) => ({ ...candidate, eligibility: "ineligible" })),
    };
    const falsePoint: AbsenceQueryResultV1 = {
      ...cell.evaluation,
      conclusion: { status: "absence-derived", bases: ["derived"] },
      witnesses: {
        status: "none-recorded",
        existentialAssertionIds: [], possibleExistentialAssertionIds: [], unresolvedExistentialAssertionIds: [],
        candidateIds: [], possibleCandidateIds: [], unresolvedCandidateIds: [],
      },
      derivation: { ...falsePointBody, evaluationDigest: absenceEvaluationDigest(falsePointBody) },
    };
    expect(verifyAbsenceReceiptIntegrity(falsePoint.derivation).valid).toBe(true);
    const { evaluationDigest: _intervalDigest, ...body } = result;
    const forged = rehash({
      ...body,
      status: "established", reason: "all-cells-ineligible",
      cells: [body.cells[0]!, { ...cell, evaluation: falsePoint }],
    });
    expect(verifyIntervalAbsenceReceiptIntegrity(forged))
      .toEqual({ valid: true, verification: "integrity-only", errors: [] });
    const replay = verifyIntervalAbsenceReceipt(forged, snapshot);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors.length).toBeGreaterThan(0);
  });

  it("recomputes omitted point breakpoints instead of trusting fully rehashed constancy declarations", () => {
    const witness = pointWitness();
    const input = buildSnapshot({ activate: [witness] });
    const result = prove(throughout(), input);
    expect(result.breakpoints).toEqual(["1000", "1005", "1006", "1030"]);
    const { evaluationDigest: _digest, ...body } = result;
    const forged = rehash({
      ...body,
      status: "established", reason: "all-cells-ineligible",
      breakpoints: ["1000", "1030"],
      constancyDeclarations: body.constancyDeclarations.map((entry) => entry.assertionId === witness.id
        ? { ...entry, changePositions: [] } : entry),
      cells: [{ ...body.cells[0]!, endExclusive: "1030" }],
    });
    expect(verifyIntervalAbsenceReceiptIntegrity(forged))
      .toEqual({ valid: true, verification: "integrity-only", errors: [] });
    const replay = verifyIntervalAbsenceReceipt(forged, input);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors.length).toBeGreaterThan(0);
  });

  it("rejects a different source snapshot even when the receipt has valid integrity", () => {
    const result = prove();
    const changed = buildSnapshot({ deactivate: [coverage.id] });
    expect(changed.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    expect(verifyIntervalAbsenceReceiptIntegrity(result).valid).toBe(true);
    const replay = verifyIntervalAbsenceReceipt(result, changed);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors).toContain("SNAPSHOT_MISMATCH");
  });
});
