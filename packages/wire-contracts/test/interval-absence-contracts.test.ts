import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AbsenceQueryResultV1,
  ApiErrorCodeV1,
  ApiErrorResponseV1,
  ApiRequestV1,
  ApiResultByOperationV1,
  ApiSuccessResponseV1,
  ExistsV1,
  IntervalAbsenceCellV1,
  IntervalAbsenceEvaluationBodyV1,
  IntervalAbsenceLimitsV1,
  IntervalAbsenceResultV1,
  IntervalConstancyDeclarationV1,
  IntervalPartitionIssueV1,
  PointTemporalQueryV1,
  ScopeV1,
  SemanticContractV1,
  ThroughoutTemporalQueryV1,
} from "../src/index.js";
import {
  validateApiContract,
  validateApiRequest,
  validateApiResponse,
  validateSemanticContract,
} from "../src/index.js";

type ThroughoutRequest = Extract<ApiRequestV1, { readonly operation: "absence.proveThroughout" }>;

const digest = "a".repeat(64);
const coverageId = `asrt:${"1".repeat(64)}`;
const membershipId = `asrt:${"2".repeat(64)}`;
const eligibilityId = `asrt:${"3".repeat(64)}`;
const worldId = "world:interval_contract";
const target: ExistsV1 = {
  kind: "exists",
  population: { descriptorId: "population:members", definitionDigest: digest },
  criterion: { definitionDigest: digest, arguments: {} },
};
const scope: ScopeV1 = {
  account: { kind: "notApplicable" },
  jurisdiction: { kind: "notApplicable" },
  recognitionFrame: { kind: "notApplicable" },
};
const temporal: ThroughoutTemporalQueryV1 = {
  format: "wmm.temporal-query/1",
  mode: "throughout",
  axisDefinitionDigest: digest,
  start: "0",
  endExclusive: "10",
};
const pointTemporal: PointTemporalQueryV1 = {
  format: "wmm.temporal-query/1",
  mode: "at",
  axisDefinitionDigest: digest,
  position: "0",
};
const request: ThroughoutRequest = {
  format: "wmm.request/1",
  apiVersion: "wmm/1",
  requestId: "interval-contract",
  operation: "absence.proveThroughout",
  payload: { bundlePath: "fixtures/interval-world", target, scope, temporal },
};

// Hand-authored shape examples, not evaluator outputs or canonical digest vectors.
const establishedPoint: AbsenceQueryResultV1 = {
  format: "wmm.absence-query-result/1",
  target,
  scope,
  temporal: pointTemporal,
  conclusion: { status: "absence-derived", bases: ["derived"] },
  declaration: {
    status: "not-recorded",
    definiteAssertionIds: [],
    possibleAssertionIds: [],
    unresolvedAssertionIds: [],
  },
  witnesses: {
    status: "none-recorded",
    existentialAssertionIds: [],
    possibleExistentialAssertionIds: [],
    unresolvedExistentialAssertionIds: [],
    candidateIds: [],
    possibleCandidateIds: [],
    unresolvedCandidateIds: [],
  },
  derivation: {
    format: "wmm.absence-evaluation-receipt/1",
    algorithm: "bundled-absence-point-v3",
    inputSelection: {
      format: "wmm.absence-input-selection/1",
      worldId,
      snapshotDigest: digest,
      target,
      scope,
      temporal: pointTemporal,
      membershipAssertionIds: [membershipId],
    },
    inputSelectionDigest: digest,
    evaluationDigest: digest,
    positiveCoverageAssertionIds: [coverageId],
    negativeCoverageAssertionIds: [],
    staleCoverageAssertionIds: [],
    selectedCoverageAssertionId: coverageId,
    coverageChecks: [{
      assertionId: coverageId,
      basis: {
        format: "wmm.population-coverage-basis/1",
        populationDefinitionDigest: digest,
        selectorDefinitionDigest: digest,
        rosterDigest: digest,
        inputSelectionDigest: digest,
        coverageMethod: "authorAttested",
      },
      inputSelection: {
        format: "wmm.coverage-input/1",
        worldId,
        populationDefinitionDigest: digest,
        selectorDefinitionDigest: digest,
        scope,
        applicability: { kind: "invariant" },
        primitiveClaimIds: [membershipId],
        candidateBirthDigests: [digest],
      },
      inputSelectionDigest: digest,
      roster: {
        format: "wmm.roster/1",
        worldId,
        populationDefinitionDigest: digest,
        memberIds: ["person:member"],
      },
      status: "matched",
    }],
    premiseAssertionIds: [coverageId, membershipId, eligibilityId],
    eligibilityAssertionIds: [eligibilityId],
    candidates: [{
      candidateId: "person:member",
      membershipAssertionIds: [membershipId],
      membership: "member",
      eligibilityAssertionIds: [eligibilityId],
      eligibility: "ineligible",
    }],
    status: "established",
    reason: "all-candidates-ineligible",
  },
};
const notEstablishedPoint: AbsenceQueryResultV1 = {
  ...establishedPoint,
  conclusion: { status: "absence-not-established", bases: [] },
  derivation: {
    ...establishedPoint.derivation,
    status: "not-established",
    reason: "coverage-not-established",
    positiveCoverageAssertionIds: [],
    selectedCoverageAssertionId: null,
    coverageChecks: [],
  },
};
const witnessPoint: AbsenceQueryResultV1 = {
  ...notEstablishedPoint,
  conclusion: { status: "witness-recorded", bases: [] },
  witnesses: {
    ...notEstablishedPoint.witnesses,
    status: "recorded",
    existentialAssertionIds: [eligibilityId],
  },
  derivation: { ...notEstablishedPoint.derivation, status: "not-established", reason: "recorded-witness" },
};
const declaration: IntervalConstancyDeclarationV1 = {
  assertionId: membershipId,
  provider: "recorded-applicability-v1",
  definitionDigests: [digest],
  changePositions: ["0", "10"],
};
const issue: IntervalPartitionIssueV1 = { assertionId: membershipId, reason: "uncertain-change-position" };
const cell: IntervalAbsenceCellV1 = {
  start: "0",
  endExclusive: "10",
  representativePosition: "0",
  evaluation: establishedPoint,
};
const established: IntervalAbsenceResultV1 = {
  format: "wmm.interval-absence-result/1",
  algorithm: "bundled-absence-throughout-v1",
  worldId,
  snapshotDigest: digest,
  target,
  scope,
  temporal,
  limits: { maxCells: 256, maxWorkUnits: 2_000_000 },
  execution: "completed",
  status: "established",
  reason: "all-cells-ineligible",
  breakpoints: ["0", "10"],
  constancyDeclarations: [declaration],
  partitionIssues: [],
  cells: [cell],
  evaluationDigest: digest,
};
const notEstablished: IntervalAbsenceResultV1 = {
  ...established,
  status: "not-established",
  reason: "cell-not-established",
  cells: [{ ...cell, evaluation: notEstablishedPoint }],
};
const recordedWitness: IntervalAbsenceResultV1 = {
  ...established,
  status: "not-established",
  reason: "recorded-witness",
  cells: [{ ...cell, evaluation: witnessPoint }],
};
const unresolved: IntervalAbsenceResultV1 = {
  ...established,
  status: "not-established",
  reason: "partition-unresolved",
  breakpoints: [],
  partitionIssues: [issue],
  cells: [],
};
const results = [established, notEstablished, recordedWitness, unresolved];

function response(data: IntervalAbsenceResultV1): ApiSuccessResponseV1 {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId: request.requestId,
    operation: "absence.proveThroughout",
    outcome: "success",
    execution: "completed",
    resolved: { worldId, snapshotDigest: digest },
    data,
    diagnostics: [],
  };
}

function expectValidResult(value: IntervalAbsenceResultV1): void {
  expect(validateSemanticContract(value)).toEqual({ valid: true, errors: [] });
  expect(validateApiResponse(response(value))).toEqual({ valid: true, errors: [] });
  expect(validateApiContract(response(value))).toEqual({ valid: true, errors: [] });
}

function expectInvalidResult(value: unknown): void {
  expect(validateSemanticContract(value).valid).toBe(false);
  expect(validateApiResponse({ ...response(established), data: value }).valid).toBe(false);
}

function without(value: object, key: string): object {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

const limitCases = [
  { key: "maxCells", maximum: 1024 },
  { key: "maxWorkUnits", maximum: 50_000_000 },
] as const;

describe("absence.proveThroughout requests", () => {
  it("exposes the narrowed temporal, per-key optional limits, and correlated result types", () => {
    expectTypeOf<ThroughoutRequest["payload"]["temporal"]>().toEqualTypeOf<ThroughoutTemporalQueryV1>();
    expectTypeOf<ThroughoutTemporalQueryV1["mode"]>().toEqualTypeOf<"throughout">();
    expectTypeOf<ThroughoutRequest["payload"]["limits"]>().toEqualTypeOf<Partial<IntervalAbsenceLimitsV1> | undefined>();
    expectTypeOf<ApiResultByOperationV1["absence.proveThroughout"]>().toEqualTypeOf<IntervalAbsenceResultV1>();
    expectTypeOf<Extract<ApiSuccessResponseV1, { operation: "absence.proveThroughout" }>["data"]>()
      .toEqualTypeOf<IntervalAbsenceResultV1>();
    expectTypeOf<Extract<IntervalAbsenceEvaluationBodyV1, { status: "established" }>["reason"]>()
      .toEqualTypeOf<"all-cells-ineligible">();
    expectTypeOf<Extract<IntervalAbsenceEvaluationBodyV1, { status: "not-established" }>["reason"]>()
      .toEqualTypeOf<"cell-not-established" | "recorded-witness" | "partition-unresolved">();
    expectTypeOf<IntervalAbsenceResultV1>().toExtend<SemanticContractV1>();
    expectTypeOf<"BUDGET_EXCEEDED">().toExtend<ApiErrorCodeV1>();
  });

  it("accepts omitted, empty, partial, and complete limits without filling in defaults", () => {
    const before = structuredClone(request);
    expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
    expect(validateApiContract(request)).toEqual({ valid: true, errors: [] });
    expect(request).toEqual(before);
    for (const limits of [{}, { maxCells: 1 }, { maxWorkUnits: 1 }, established.limits, { maxCells: 1024, maxWorkUnits: 50_000_000 }]) {
      const input = { ...request, payload: { ...request.payload, limits } };
      const original = structuredClone(input);
      expect(validateApiRequest(input)).toEqual({ valid: true, errors: [] });
      expect(input).toEqual(original);
    }
  });

  it.each(limitCases)("rejects invalid $key request limits", ({ key, maximum }) => {
    for (const value of [0, -1, 1.5, maximum + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null, true]) {
      expect(validateApiRequest({ ...request, payload: { ...request.payload, limits: { [key]: value } } }).valid).toBe(false);
    }
  });

  it("requires closed request and temporal shapes", () => {
    for (const key of Object.keys(request)) {
      expect(validateApiRequest(without(request, key)).valid).toBe(false);
    }
    for (const key of Object.keys(request.payload)) {
      expect(validateApiRequest({ ...request, payload: without(request.payload, key) }).valid).toBe(false);
    }
    for (const key of Object.keys(temporal)) {
      expect(validateApiRequest({ ...request, payload: { ...request.payload, temporal: without(temporal, key) } }).valid).toBe(false);
    }
    for (const limits of [null, [], 1, "1", { extra: 1 }]) {
      expect(validateApiRequest({ ...request, payload: { ...request.payload, limits } }).valid).toBe(false);
    }
    expect(validateApiRequest({ ...request, extra: true }).valid).toBe(false);
    expect(validateApiRequest({ ...request, payload: { ...request.payload, extra: true } }).valid).toBe(false);
    expect(validateApiRequest({ ...request, payload: { ...request.payload, temporal: { ...temporal, position: "0" } } }).valid).toBe(false);
    expect(validateApiRequest({ ...request, payload: { ...request.payload, bundlePath: "" } }).valid).toBe(false);
  });

  it("requires the explicit operation and throughout mode without broadening absence.query", () => {
    for (const query of [pointTemporal, { ...temporal, mode: "intersects" }, { ...temporal, mode: "at" }]) {
      expect(validateApiRequest({ ...request, payload: { ...request.payload, temporal: query } }).valid).toBe(false);
    }
    for (const operation of ["absence.query", "absence.prove", "absence.provethroughout"]) {
      expect(validateApiRequest({ ...request, operation }).valid).toBe(false);
    }
    expect(validateApiRequest({ ...request, operation: "absence.query", payload: { ...request.payload, temporal: pointTemporal } }))
      .toEqual({ valid: true, errors: [] });
    expect(validateApiRequest({ ...request, operation: "absence.query", payload: { ...request.payload, temporal: { ...temporal, mode: "intersects" } } }).valid).toBe(false);
    for (const mode of ["intersects", "throughout"]) {
      expect(validateApiRequest({ ...request, operation: "claims.query", payload: { bundlePath: request.payload.bundlePath, scope, temporal: { ...temporal, mode } } }).valid).toBe(true);
    }
  });
});

describe("interval absence result shapes", () => {
  it.each(results)("accepts completed $status / $reason results at both schema roots", (result) => {
    expectValidResult(result);
    for (const { evaluation } of result.cells) {
      expect(validateSemanticContract(evaluation)).toEqual({ valid: true, errors: [] });
    }
  });

  it("requires every result field, including the digest and effective limits", () => {
    for (const key of Object.keys(established)) {
      expectInvalidResult(without(established, key));
    }
    for (const limits of [{}, { maxCells: 256 }, { maxWorkUnits: 2_000_000 }, null, [], { ...established.limits, extra: true }]) {
      expectInvalidResult({ ...established, limits });
    }
    expectInvalidResult({ ...established, extra: true });
  });

  it.each(limitCases)("enforces required positive capped $key effective limits", ({ key, maximum }) => {
    for (const value of [1, maximum]) {
      expectValidResult({ ...established, limits: { ...established.limits, [key]: value } });
    }
    for (const value of [0, -1, 0.5, maximum + 1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
      expectInvalidResult({ ...established, limits: { ...established.limits, [key]: value } });
    }
  });

  it("correlates every status and reason combination", () => {
    for (const status of ["established", "not-established"] as const) {
      for (const reason of ["all-cells-ineligible", "cell-not-established", "recorded-witness", "partition-unresolved"] as const) {
        const value = { ...(reason === "partition-unresolved" ? unresolved : established), status, reason };
        const valid = (status === "established") === (reason === "all-cells-ineligible");
        expect(validateSemanticContract(value).valid, `${status} / ${reason}`).toBe(valid);
        expect(validateApiResponse({ ...response(established), data: value }).valid, `${status} / ${reason}`).toBe(valid);
      }
    }
  });

  it("requires established partitions to have at least two breakpoints, one cell, and no issues", () => {
    for (const breakpoints of [[], ["0"]]) expectInvalidResult({ ...established, breakpoints });
    expectInvalidResult({ ...established, cells: [] });
    expectInvalidResult({ ...established, partitionIssues: [issue] });
    for (const result of [notEstablished, recordedWitness]) {
      expectInvalidResult({ ...result, cells: [] });
      expectInvalidResult({ ...result, partitionIssues: [issue] });
    }
  });

  it("requires an unresolved partition to contain issues and no evaluated cells", () => {
    expectInvalidResult({ ...unresolved, partitionIssues: [] });
    expectInvalidResult({ ...unresolved, cells: [cell] });
    expectValidResult({ ...unresolved, constancyDeclarations: [] });
    for (const reason of ["uncertain-change-position", "unmapped-axis", "unresolved-scope", "unsupported-semantics", "unsupported-primitive"] as const) {
      for (const assertionId of [null, membershipId]) {
        expectValidResult({ ...unresolved, partitionIssues: [{ assertionId, reason }] });
      }
    }
  });

  it("rejects unsupported tags, malformed digests, identifiers, and temporal modes", () => {
    for (const patch of [
      { format: "wmm.interval-absence-result/2" },
      { algorithm: "bundled-absence-point-v3" },
      { worldId: "not-a-world" },
      { snapshotDigest: "bad-digest" },
      { evaluationDigest: "A".repeat(64) },
      { status: "unsupported" },
      { reason: "budget-exceeded" },
      { execution: "incomplete" },
      { target: { ...target, kind: "atom" } },
      { scope: without(scope, "account") },
      { temporal: pointTemporal },
      { temporal: { ...temporal, mode: "intersects" } },
    ]) expectInvalidResult({ ...established, ...patch });
    for (const key of ["breakpoints", "constancyDeclarations", "partitionIssues", "cells"]) {
      for (const value of [null, {}, "array"]) expectInvalidResult({ ...established, [key]: value });
    }
    for (const position of [0, "01", "-0", "1.5", "unknown"]) {
      expectInvalidResult({ ...established, breakpoints: [position, "10"] });
      expectInvalidResult({ ...established, temporal: { ...temporal, start: position } });
      expect(validateApiRequest({ ...request, payload: { ...request.payload, temporal: { ...temporal, endExclusive: position } } }).valid).toBe(false);
    }
  });

  it("requires closed implementation-owned constancy declarations", () => {
    for (const key of Object.keys(declaration)) {
      expectInvalidResult({ ...established, constancyDeclarations: [without(declaration, key)] });
    }
    for (const patch of [
      { assertionId: null }, { assertionId: "bad-id" }, { provider: "other-provider" },
      { definitionDigests: ["bad-digest"] }, { definitionDigests: null },
      { changePositions: ["01"] }, { changePositions: [1] }, { extra: true },
    ]) expectInvalidResult({ ...established, constancyDeclarations: [{ ...declaration, ...patch }] });
    expectValidResult({ ...established, constancyDeclarations: [{ ...declaration, definitionDigests: [], changePositions: [] }] });
  });

  it("requires closed partition issues with an assertion id or explicit null", () => {
    for (const key of Object.keys(issue)) {
      expectInvalidResult({ ...unresolved, partitionIssues: [without(issue, key)] });
    }
    for (const patch of [{ assertionId: "bad-id" }, { assertionId: 1 }, { reason: "unknown" }, { extra: true }]) {
      expectInvalidResult({ ...unresolved, partitionIssues: [{ ...issue, ...patch }] });
    }
  });

  it("requires complete cells embedding the unchanged point-result schema", () => {
    for (const key of Object.keys(cell)) expectInvalidResult({ ...established, cells: [without(cell, key)] });
    for (const key of ["start", "endExclusive", "representativePosition"]) {
      for (const value of [1, "01", "unknown"]) expectInvalidResult({ ...established, cells: [{ ...cell, [key]: value }] });
    }
    expectInvalidResult({ ...established, cells: [{ ...cell, extra: true }] });
    for (const evaluation of [
      null, {}, established,
      { ...establishedPoint, temporal },
      { ...establishedPoint, temporal: { ...temporal, mode: "intersects" } },
      { ...establishedPoint, extra: true },
      { ...establishedPoint, derivation: without(establishedPoint.derivation, "evaluationDigest") },
      { ...establishedPoint, derivation: { ...establishedPoint.derivation, reason: "recorded-witness" } },
    ]) expectInvalidResult({ ...established, cells: [{ ...cell, evaluation }] });
  });

  it("leaves numeric ordering, cell consistency, replay, and hash integrity to core", () => {
    expectValidResult({
      ...established,
      breakpoints: ["10", "0", "0"],
      cells: [{ ...cell, start: "10", endExclusive: "0", representativePosition: "99", evaluation: notEstablishedPoint }],
    });
    expectValidResult({ ...notEstablished, breakpoints: [] });
    expect(validateApiRequest({ ...request, payload: { ...request.payload, temporal: { ...temporal, start: "10", endExclusive: "0" } } }).valid).toBe(true);
  });

  it("binds interval results exclusively to the new operation", () => {
    for (const operation of ["world.validate", "record.inspect", "world.export", "claims.query", "absence.query"]) {
      expect(validateApiResponse({ ...response(established), operation }).valid).toBe(false);
    }
    for (const data of [null, false, 1, "data", [], {}, { arbitrary: true }, establishedPoint]) {
      expect(validateApiResponse({ ...response(established), data }).valid).toBe(false);
    }
    expect(validateApiResponse({ ...response(established), operation: "absence.query", data: establishedPoint }))
      .toEqual({ valid: true, errors: [] });
  });
});

describe("interval absence budget errors", () => {
  const error: ApiErrorResponseV1 = {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId: request.requestId,
    operation: "absence.proveThroughout",
    outcome: "error",
    execution: "incomplete",
    error: { code: "BUDGET_EXCEEDED", message: "Interval absence work budget exhausted" },
    diagnostics: [],
  };

  it("accepts exhaustion only as an incomplete error without data", () => {
    expect(validateApiResponse(error)).toEqual({ valid: true, errors: [] });
    expect(validateApiContract(error)).toEqual({ valid: true, errors: [] });
    expect(validateApiResponse({ ...error, execution: "completed" }).valid).toBe(false);
    for (const data of [null, {}, established, { cells: [cell] }]) {
      expect(validateApiResponse({ ...error, data }).valid).toBe(false);
    }
    for (const extra of [{ cells: [cell] }, { proof: established }, { evaluationDigest: digest }]) {
      expect(validateApiResponse({ ...error, ...extra }).valid).toBe(false);
      expect(validateApiResponse({ ...error, error: { ...error.error, ...extra } }).valid).toBe(false);
    }
  });

  it("never accepts incomplete or partial proof envelopes", () => {
    const success = response(established);
    for (const outcome of ["success", "partial"]) {
      expect(validateApiResponse({ ...success, outcome, execution: "incomplete" }).valid).toBe(false);
    }
    expect(validateApiResponse({ ...success, data: { ...established, execution: "incomplete" } }).valid).toBe(false);
    expect(validateApiResponse({ ...success, outcome: "partial" }).valid).toBe(false);
    expect(validateApiResponse({ ...error, error: { ...error.error, code: "UNKNOWN_ERROR" } }).valid).toBe(false);
    expect(validateApiResponse({ ...error, execution: "completed", error: { code: "INVALID_REQUEST", message: "Malformed interval" } }))
      .toEqual({ valid: true, errors: [] });
  });
});
