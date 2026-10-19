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
        algorithm: "bundled-absence-point-v1",
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
        eligibilityAssertionIds: [],
        candidates: [],
        status: "unsupported",
        reason: "unsupported-semantics",
      },
    };
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
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
