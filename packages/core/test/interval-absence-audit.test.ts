import { describe, expect, it } from "vitest";

import {
  coverageInputSelectionDigest,
  intervalAbsenceEvaluationDigest,
  populationRosterDigest,
} from "@wmm/canonical";
import type {
  ExistsV1,
  IntervalAbsenceEvaluationBodyV1,
  IntervalAbsenceLimitsV1,
  IntervalAbsenceResultV1,
  ThroughoutTemporalQueryV1,
} from "@wmm/wire-contracts";
import { validateApiRequest, validateSemanticContract } from "@wmm/wire-contracts";
import {
  ClaimQueryInputError,
  IntervalAbsenceBudgetError,
  proveAbsenceThroughout,
  queryAbsence,
  resolvePopulationSelector,
  selectCoverageInputs,
  verifyIntervalAbsenceReceipt,
  verifyIntervalAbsenceReceiptIntegrity,
} from "../src/index.js";
import { buildSnapshot, findAssertion, operation, record, request } from "./absence-fixture.js";

type Snapshot = ReturnType<typeof buildSnapshot>;

const snapshot = buildSnapshot();
const target = request.payload.target;
const scope = request.payload.scope;
const axis = request.payload.temporal.axisDefinitionDigest;
const coverage = findAssertion((assertion) => operation(assertion) === "population-coverage-atom-v1");
const membership = findAssertion((assertion) => operation(assertion) === "population-membership-atom-v1");
const ineligible = findAssertion((assertion) =>
  operation(assertion) === "criterion-satisfaction-atom-v1" && assertion.body.polarity === "negative",
);
const selector = resolvePopulationSelector(target.population.definitionDigest, snapshot.definitionsByDigest);
if (selector === undefined) throw new Error("Missing bundled population selector fixture");

function throughout(start = "1000", endExclusive = "1030"): ThroughoutTemporalQueryV1 {
  return { format: "wmm.temporal-query/1", mode: "throughout", axisDefinitionDigest: axis, start, endExclusive };
}

function prove(
  input = snapshot,
  temporal = throughout(),
  limits?: Partial<IntervalAbsenceLimitsV1>,
): IntervalAbsenceResultV1 {
  return proveAbsenceThroughout(input, target, scope, temporal, limits);
}

function buildInvariantSnapshot(): Snapshot {
  const activate = snapshot.assertions
    .filter((assertion) => snapshot.activeAssertionIds.includes(assertion.id) && (
      operation(assertion) === "population-membership-atom-v1" ||
      (operation(assertion) === "criterion-satisfaction-atom-v1" && assertion.body.polarity === "negative")
    ))
    .map((assertion) => record({ ...assertion.body, applicability: { kind: "invariant" } }));
  const options = { deactivate: snapshot.activeAssertionIds, activate };
  const changed = buildSnapshot(options);
  const proposition = coverage.body.proposition;
  const roster = changed.rosters[0]?.body;
  if (selector === undefined || proposition.kind !== "atom" || proposition.value.kind !== "literal" || roster === undefined) {
    throw new Error("Missing roster-bound coverage fixture");
  }
  const active = new Set(changed.activeAssertionIds);
  const applicability = { kind: "invariant" } as const;
  const selection = selectCoverageInputs(
    changed.worldId, target.population.definitionDigest, selector, scope, applicability,
    changed.assertions.filter((assertion) => active.has(assertion.id)), changed.descriptors,
  );
  const renewed = record({
    ...coverage.body,
    applicability,
    proposition: {
      ...proposition,
      value: {
        ...proposition.value,
        data: {
          format: "wmm.population-coverage-basis/1",
          populationDefinitionDigest: target.population.definitionDigest,
          selectorDefinitionDigest: selection.selectorDefinitionDigest,
          rosterDigest: populationRosterDigest(roster),
          inputSelectionDigest: coverageInputSelectionDigest(selection),
          coverageMethod: "authorAttested",
        },
      },
    },
  });
  return buildSnapshot({ ...options, activate: [...activate, renewed] });
}

function buildReceiptNodeBoundarySnapshot(extraCandidates: number): Snapshot {
  const person = snapshot.descriptors.find((descriptor) => descriptor.id === "person:alys");
  if (person === undefined) throw new Error("Missing person descriptor fixture");
  const point = record({
    ...membership.body,
    applicability: {
      kind: "point", axisDefinitionDigest: axis, position: { kind: "exact", position: "1001" },
    },
  });
  const opposition = Array.from({ length: 5 }, (_, index) => record({
    ...membership.body,
    polarity: "negative",
    applicability: {
      kind: "interval", axisDefinitionDigest: axis,
      start: { kind: "exact", position: String(900 - index) },
      endExclusive: { kind: "exact", position: String(1200 + index) },
    },
  }));
  return buildSnapshot({
    deactivate: [coverage.id], activate: [point, ...opposition],
    descriptors: Array.from({ length: extraCandidates }, (_, index) => ({
      ...person, id: "p:" + index.toString(36),
    })),
  });
}

function jsonNodeCount(value: unknown): number {
  let count = 1;
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) count += jsonNodeCount(child);
  }
  return count;
}

function rehash(body: IntervalAbsenceEvaluationBodyV1): IntervalAbsenceResultV1 {
  return { ...body, evaluationDigest: intervalAbsenceEvaluationDigest(body) };
}

function withoutSnapshotIdentity(result: IntervalAbsenceResultV1) {
  const { snapshotDigest: _snapshotDigest, evaluationDigest: _evaluationDigest, cells, ...body } = result;
  return {
    ...body,
    cells: cells.map((cell) => {
      const { inputSelectionDigest: _selectionDigest, evaluationDigest: _cellDigest, inputSelection, ...derivation } = cell.evaluation.derivation;
      const { snapshotDigest: _cellSnapshotDigest, ...selection } = inputSelection;
      return {
        ...cell,
        evaluation: { ...cell.evaluation, derivation: { ...derivation, inputSelection: selection } },
      };
    }),
  };
}

const invariantSnapshot = buildInvariantSnapshot();

describe("interval absence independent audit regressions", () => {
  it("establishes and successfully replays an ordinary invariant proof", () => {
    expect(invariantSnapshot.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    const active = new Set(invariantSnapshot.activeAssertionIds);
    expect(invariantSnapshot.assertions.filter((assertion) => active.has(assertion.id))
      .every((assertion) => assertion.body.applicability.kind === "invariant")).toBe(true);
    const result = prove(invariantSnapshot);
    expect(result).toMatchObject({
      snapshotDigest: invariantSnapshot.snapshotDigest,
      execution: "completed", status: "established", reason: "all-cells-ineligible",
      breakpoints: ["1000", "1030"], partitionIssues: [],
    });
    expect(result.cells).toHaveLength(1);
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
    expect(verifyIntervalAbsenceReceiptIntegrity(result))
      .toEqual({ valid: true, verification: "integrity-only", errors: [] });
    expect(verifyIntervalAbsenceReceipt(result, invariantSnapshot))
      .toEqual({ valid: true, verification: "snapshot-replay", errors: [] });
  });

  describe.each([
    { name: "invariant premises", input: invariantSnapshot },
    { name: "time-bounded premises", input: snapshot },
  ])("query axis admission with $name", ({ input }) => {
    it.each([
      { name: "unadmitted digest", axisDefinitionDigest: "f".repeat(64) },
      { name: "descriptor-type definition", axisDefinitionDigest: selector.candidateTypeDefinitionDigest },
      { name: "criterion definition", axisDefinitionDigest: target.criterion.definitionDigest },
      { name: "malformed digest", axisDefinitionDigest: "not-a-digest" },
      { name: "empty digest", axisDefinitionDigest: "" },
    ])("completes without establishing a proof for a $name", ({ axisDefinitionDigest }) => {
      const result = prove(input, { ...throughout(), axisDefinitionDigest });
      expect(result).toMatchObject({
        worldId: input.worldId, snapshotDigest: input.snapshotDigest,
        execution: "completed", status: "not-established", reason: "partition-unresolved", cells: [],
      });
      expect(result.partitionIssues.length).toBeGreaterThan(0);
    });
  });

  it("does not let an unreferenced roster promote irrelevant uncertain eligibility into a proof input", () => {
    const office = target.criterion.arguments["office"];
    const proposition = ineligible.body.proposition;
    const roster = snapshot.rosters[0]?.body;
    if (office?.kind !== "ref" || proposition.kind !== "atom" || roster === undefined) {
      throw new Error("Missing office and roster fixtures");
    }
    const irrelevant = record({
      ...ineligible.body,
      proposition: { ...proposition, subjectId: office.id },
      applicability: {
        kind: "point", axisDefinitionDigest: axis,
        position: { kind: "boundedUnknown", lowerInclusive: "1005", upperExclusive: "1007" },
      },
    });
    const unusedRoster = { ...roster, memberIds: [office.id] };
    const before = buildSnapshot({ activate: [irrelevant] });
    const after = buildSnapshot({
      activate: [irrelevant], rosters: [...snapshot.rosters.map((entry) => entry.body), unusedRoster],
    });
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
    for (let position = 1000; position < 1030; position += 1) {
      expect(queryAbsence(after, target, scope, {
        format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: axis, position: String(position),
      }).derivation.status).toBe("established");
    }
    const expected = prove(before);
    expect(expected.status).toBe("established");
    const actual = prove(after);
    expect(actual).toMatchObject({
      execution: "completed", status: "established", reason: "all-cells-ineligible", partitionIssues: [],
    });
    expect(withoutSnapshotIdentity(actual)).toEqual(withoutSnapshotIdentity(expected));
    expect(actual.constancyDeclarations.map((declaration) => declaration.assertionId)).not.toContain(irrelevant.id);
    expect(actual.cells.flatMap((cell) => cell.evaluation.derivation.coverageChecks)
      .some((check) => check.basis.rosterDigest === populationRosterDigest(unusedRoster))).toBe(false);
    expect(verifyIntervalAbsenceReceipt(actual, after))
      .toEqual({ valid: true, verification: "snapshot-replay", errors: [] });
  });

  it("exhausts the output budget for a large valid target repeated over 33 cells even with 50m work units", () => {
    const points = Array.from({ length: 16 }, (_, index) => record({
      ...membership.body,
      applicability: {
        kind: "point", axisDefinitionDigest: axis,
        position: { kind: "exact", position: String(1001 + 2 * index) },
      },
    }));
    const input = buildSnapshot({ activate: points });
    const temporal = throughout("1000", "1035");
    const limits = { maxWorkUnits: 50_000_000 };
    const shortTarget: ExistsV1 = {
      ...target,
      criterion: { ...target.criterion, arguments: { office: { kind: "ref", id: "office:x" } } },
    };
    const ordinary = proveAbsenceThroughout(input, shortTarget, scope, temporal, limits);
    expect(ordinary.partitionIssues).toEqual([]);
    expect(ordinary.cells).toHaveLength(33);
    const largeTarget: ExistsV1 = {
      ...shortTarget,
      criterion: { ...shortTarget.criterion, arguments: { office: { kind: "ref", id: "office:" + "x".repeat(256 * 1024) } } },
    };
    const largeRequest = {
      ...request, operation: "absence.proveThroughout",
      payload: { ...request.payload, target: largeTarget, temporal, limits },
    };
    expect(validateApiRequest(largeRequest)).toEqual({ valid: true, errors: [] });
    expect(Buffer.byteLength(JSON.stringify(largeRequest))).toBeLessThan(1024 * 1024);
    let result: IntervalAbsenceResultV1 | undefined;
    let thrown: unknown;
    try {
      result = proveAbsenceThroughout(input, largeTarget, scope, temporal, limits);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntervalAbsenceBudgetError);
    expect(thrown).toHaveProperty("message", expect.stringMatching(/budget/i));
    expect(result).toBeUndefined();
    for (const property of ["result", "receipt", "evaluationDigest", "cells"]) {
      expect(thrown).not.toHaveProperty(property);
    }
  });

  it("reserves the final digest node instead of returning the genuine 150001-node counterexample", () => {
    const input = buildReceiptNodeBoundarySnapshot(8299);
    expect(input.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    let result: IntervalAbsenceResultV1 | undefined;
    let thrown: unknown;
    try {
      result = prove(input, throughout("1000", "1003"), { maxWorkUnits: 50_000_000 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntervalAbsenceBudgetError);
    expect(thrown).toHaveProperty("message", expect.stringMatching(/receipt.*budget/i));
    expect(result).toBeUndefined();
    for (const property of ["result", "receipt", "evaluationDigest", "cells"]) {
      expect(thrown).not.toHaveProperty(property);
    }
  });

  it("returns an integrity-valid adjacent in-limit receipt counting the final digest node", () => {
    const input = buildReceiptNodeBoundarySnapshot(8298);
    expect(input.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    const result = prove(input, throughout("1000", "1003"), { maxWorkUnits: 50_000_000 });
    expect(result).toMatchObject({
      snapshotDigest: input.snapshotDigest,
      execution: "completed", status: "not-established", reason: "cell-not-established",
      breakpoints: ["1000", "1001", "1002", "1003"], partitionIssues: [],
      limits: { maxWorkUnits: 50_000_000 },
    });
    expect(result.cells).toHaveLength(3);
    // One additional candidate contributes six value nodes in each of the three cells.
    expect(jsonNodeCount(result)).toBe(149_983);
    expect(jsonNodeCount(result) + 6 * result.cells.length).toBe(150_001);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8 * 1024 * 1024);
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
    expect(verifyIntervalAbsenceReceiptIntegrity(result))
      .toEqual({ valid: true, verification: "integrity-only", errors: [] });
    expect(verifyIntervalAbsenceReceipt(result, input))
      .toEqual({ valid: true, verification: "snapshot-replay", errors: [] });
  });

  it.each([4096, 16384])("rejects a shape-valid rehashed imported partition with %i breakpoints", (count) => {
    const template = prove(invariantSnapshot);
    const declaration = template.constancyDeclarations[0];
    if (declaration === undefined) throw new Error("Missing invariant constancy declaration");
    const { evaluationDigest: _digest, ...body } = template;
    const breakpoints = Array.from({ length: count }, (_, index) => String(index));
    const imported = rehash({
      ...body,
      temporal: { ...body.temporal, start: "0", endExclusive: String(count - 1) },
      limits: { maxCells: 1, maxWorkUnits: 50_000_000 },
      status: "not-established", reason: "partition-unresolved", cells: [], breakpoints,
      constancyDeclarations: [{ ...declaration, changePositions: breakpoints }],
      partitionIssues: [{ assertionId: null, reason: "unsupported-semantics" }],
    });
    expect(imported.snapshotDigest).toBe(invariantSnapshot.snapshotDigest);
    expect(validateSemanticContract(imported)).toEqual({ valid: true, errors: [] });
    const integrity = verifyIntervalAbsenceReceiptIntegrity(imported);
    expect(integrity).toMatchObject({ valid: false, verification: "integrity-only" });
    expect(integrity.errors.length).toBeGreaterThan(0);
    expect(integrity.errors).not.toContain("EVALUATION_DIGEST_MISMATCH");
    const replay = verifyIntervalAbsenceReceipt(imported, invariantSnapshot);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors.length).toBeGreaterThan(0);
  });

  it("returns invalid rather than leaking a budget exception when replaying rehashed forged work limits", () => {
    const original = prove(invariantSnapshot);
    const { evaluationDigest: _digest, ...body } = original;
    const forged = rehash({ ...body, limits: { ...body.limits, maxWorkUnits: 1 } });
    expect(validateSemanticContract(forged)).toEqual({ valid: true, errors: [] });
    expect(forged.snapshotDigest).toBe(invariantSnapshot.snapshotDigest);
    const replay = verifyIntervalAbsenceReceipt(forged, invariantSnapshot);
    expect(replay).toMatchObject({ valid: false, verification: "snapshot-replay" });
    expect(replay.errors.length).toBeGreaterThan(0);
  });

  it.each([
    { name: "zero cells", limits: { maxCells: 0 } },
    { name: "negative cells", limits: { maxCells: -1 } },
    { name: "fractional cells", limits: { maxCells: 1.5 } },
    { name: "excessive cells", limits: { maxCells: 1025 } },
    { name: "NaN cells", limits: { maxCells: Number.NaN } },
    { name: "infinite cells", limits: { maxCells: Number.POSITIVE_INFINITY } },
    { name: "zero work", limits: { maxWorkUnits: 0 } },
    { name: "negative work", limits: { maxWorkUnits: -1 } },
    { name: "fractional work", limits: { maxWorkUnits: 1.5 } },
    { name: "excessive work", limits: { maxWorkUnits: 50_000_001 } },
    { name: "NaN work", limits: { maxWorkUnits: Number.NaN } },
    { name: "infinite work", limits: { maxWorkUnits: Number.POSITIVE_INFINITY } },
  ])("rejects invalid core limits: $name", ({ limits }) => {
    let thrown: unknown;
    try {
      prove(invariantSnapshot, throughout(), limits);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaimQueryInputError);
    expect(thrown).toHaveProperty("code", "INVALID_QUERY");
  });
});
