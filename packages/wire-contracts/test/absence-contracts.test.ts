import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  AbsenceQueryResultV1,
  ApiRequestV1,
} from "../src/index.js";
import { validateApiRequest, validateSemanticContract } from "../src/index.js";

type AbsenceQueryRequest = Extract<ApiRequestV1, { readonly operation: "absence.query" }>;

interface AbsenceFixtures {
  readonly requests: readonly { readonly request: AbsenceQueryRequest }[];
}

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v2/absence-query-cases.json", import.meta.url),
    "utf8",
  ),
) as AbsenceFixtures;

describe("V2 absence-query wire contracts", () => {
  it("accepts exact-point absence requests", () => {
    expect(fixtures.requests).toHaveLength(3);
    for (const fixture of fixtures.requests) {
      expect(validateApiRequest(fixture.request)).toEqual({ valid: true, errors: [] });
    }
  });

  it("rejects interval-wide absence requests in the bounded profile", () => {
    const request = fixtures.requests[0]?.request;
    if (request === undefined) throw new Error("Missing absence fixture");
    expect(
      validateApiRequest({
        ...request,
        payload: {
          ...request.payload,
          temporal: {
            format: "wmm.temporal-query/1",
            mode: "throughout",
            axisDefinitionDigest: request.payload.temporal.axisDefinitionDigest,
            start: "1000",
            endExclusive: "1030",
          },
        },
      }).valid,
    ).toBe(false);
  });

  it("requires every exact coverage tuple field and rejects legacy roster selections", () => {
    const basis = {
      format: "wmm.population-coverage-basis/1", populationDefinitionDigest: "a".repeat(64),
      selectorDefinitionDigest: "b".repeat(64), rosterDigest: "c".repeat(64),
      inputSelectionDigest: "d".repeat(64), coverageMethod: "authorAttested",
    };
    expect(validateSemanticContract(basis).valid).toBe(true);
    expect(validateSemanticContract({ ...basis, coverageMethod: "sourceEnumeration" }).valid).toBe(true);
    for (const key of Object.keys(basis)) {
      const missing = { ...basis };
      Reflect.deleteProperty(missing, key);
      expect(validateSemanticContract(missing).valid).toBe(false);
    }
    expect(validateSemanticContract({ ...basis, coverageMethod: "inferred" }).valid).toBe(false);
    expect(validateSemanticContract({ ...basis, extra: true }).valid).toBe(false);
    expect(validateSemanticContract({ format: "wmm.population-roster-selection/1", worldId: "world:valen_v1", population: fixtures.requests[0]?.request.payload.target.population, membershipAssertionIds: [] }).valid).toBe(false);
  });

  it("forbids contradictory receipt status and reason combinations", () => {
    const request = fixtures.requests[0]?.request;
    if (request === undefined) throw new Error("Missing absence fixture");
    const result: AbsenceQueryResultV1 = {
      format: "wmm.absence-query-result/1",
      target: request.payload.target,
      scope: request.payload.scope,
      temporal: request.payload.temporal,
      conclusion: { status: "absence-not-established", bases: [] },
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
          worldId: "world:valen_v1",
          snapshotDigest: "a".repeat(64),
          target: request.payload.target,
          scope: request.payload.scope,
          temporal: request.payload.temporal,

          membershipAssertionIds: [],
        },
        inputSelectionDigest: "b".repeat(64),
        evaluationDigest: "c".repeat(64),
        positiveCoverageAssertionIds: [],
        negativeCoverageAssertionIds: [],
        staleCoverageAssertionIds: [],
        coverageChecks: [],
        selectedCoverageAssertionId: null,
        premiseAssertionIds: [],
        eligibilityAssertionIds: [],
        candidates: [],
        status: "unsupported",
        reason: "unsupported-semantics",
      },
    };
    // This validates shape, not hash integrity; the digests are intentionally arbitrary.
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
    expect(
      validateSemanticContract({
        ...result,
        derivation: { ...result.derivation, algorithm: "bundled-absence-point-v1" },
      }).valid,
    ).toBe(false);
    for (const field of ["coverageChecks", "selectedCoverageAssertionId", "premiseAssertionIds"] as const) {
      const derivation = { ...result.derivation };
      Reflect.deleteProperty(derivation, field);
      expect(validateSemanticContract({ ...result, derivation }).valid).toBe(false);
    }
    const withoutStaleCoverage = { ...result.derivation };
    Reflect.deleteProperty(withoutStaleCoverage, "staleCoverageAssertionIds");
    expect(
      validateSemanticContract({ ...result, derivation: withoutStaleCoverage }).valid,
    ).toBe(false);
    expect(
      validateSemanticContract({
        ...result,
        derivation: {
          ...result.derivation,
          status: "established",
          reason: "unsupported-semantics",
        },
      }).valid,
    ).toBe(false);
    expect(
      validateSemanticContract({
        ...result,
        conclusion: { status: "absence-derived", bases: [] },
      }).valid,
    ).toBe(false);
  });
});
