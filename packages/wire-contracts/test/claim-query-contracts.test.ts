import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ApiRequestV1, ClaimQueryResultV1 } from "../src/index.js";
import { validateApiRequest, validateSemanticContract } from "../src/index.js";

type ClaimsQueryRequest = Extract<ApiRequestV1, { readonly operation: "claims.query" }>;

interface QueryFixtures {
  readonly requests: readonly {
    readonly request: ClaimsQueryRequest;
  }[];
}

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v2/claim-query-cases.json", import.meta.url),
    "utf8",
  ),
) as QueryFixtures;

describe("V2 claim-query wire contracts", () => {
  it("accepts every checked-in query request", () => {
    expect(fixtures.requests).toHaveLength(4);
    for (const fixture of fixtures.requests) {
      expect(validateApiRequest(fixture.request)).toEqual({ valid: true, errors: [] });
    }
  });

  it("accepts the closed four-way query result", () => {
    const request = fixtures.requests[0]?.request;
    if (request === undefined) throw new Error("Missing query fixture");
    const result: ClaimQueryResultV1 = {
      format: "wmm.claim-query-result/1",
      scope: request.payload.scope,
      temporal: request.payload.temporal,
      definite: [],
      possible: [],
      unresolved: [],
      excluded: [],
      scopeCoverage: "exhaustive",
    };
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
    expect(
      validateSemanticContract({ ...result, scopeCoverage: "partial" }).valid,
    ).toBe(false);
  });

  it("rejects missing scope and temporal query fields", () => {
    const request = fixtures.requests[0]?.request;
    if (request === undefined) throw new Error("Missing query fixture");
    expect(
      validateApiRequest({
        ...request,
        payload: { bundlePath: request.payload.bundlePath },
      }).valid,
    ).toBe(false);
  });
});
