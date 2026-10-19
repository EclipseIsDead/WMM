import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ApiRequestV1, ClaimQueryResultV1 } from "@wmm/wire-contracts";
import { validateApiResponse, validateSemanticContract } from "@wmm/wire-contracts";
import { executeApiRequest } from "../src/index.js";

const bundlePath = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);

type ClaimsQueryRequest = Extract<ApiRequestV1, { readonly operation: "claims.query" }>;
type ResultGroup = "definite" | "possible" | "unresolved" | "excluded";

interface QueryFixtures {
  readonly requests: readonly {
    readonly request: ClaimsQueryRequest;
    readonly expected: Readonly<Record<ResultGroup, readonly string[]>>;
  }[];
}

const queryFixtures = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v2/claim-query-cases.json", import.meta.url),
    "utf8",
  ),
) as QueryFixtures;

function request(
  operation: ApiRequestV1["operation"],
  payload: ApiRequestV1["payload"],
): ApiRequestV1 {
  return {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId: `request-${operation}`,
    operation,
    payload,
  } as ApiRequestV1;
}

describe("V1 application API", () => {
  it("validates a world with pinned resolved identifiers", () => {
    const response = executeApiRequest(
      request("world.validate", { bundlePath }),
    );
    expect(validateApiResponse(response).valid).toBe(true);
    expect(response).toMatchObject({
      requestId: "request-world.validate",
      operation: "world.validate",
      outcome: "success",
      execution: "completed",
      resolved: {
        worldId: "world:valen_v1",
        snapshotDigest: "ca759f1f66a555d2735e6f81b4cd44eafebf413ee2c595d5f4cc1e0b4b02b21a",
      },
      data: { status: "valid" },
    });
  });

  it("inspects and exports through the same response contract", () => {
    const inspected = executeApiRequest(
      request("record.inspect", { bundlePath, recordId: "person:alys" }),
    );
    expect(inspected).toMatchObject({
      outcome: "success",
      data: { format: "wmm.descriptor/1", id: "person:alys" },
    });

    const exported = executeApiRequest(request("world.export", { bundlePath }));
    expect(exported).toMatchObject({
      outcome: "success",
      data: { format: "wmm.world-export/1" },
    });
  });

  it("queries active claims with explicit four-way classification", () => {
    for (const fixture of queryFixtures.requests) {
      const response = executeApiRequest({
        ...fixture.request,
        payload: { ...fixture.request.payload, bundlePath },
      });
      expect(validateApiResponse(response).valid).toBe(true);
      expect(response.outcome).toBe("success");
      if (response.outcome !== "success") throw new Error(response.error.message);
      expect(validateSemanticContract(response.data).valid).toBe(true);
      const result = response.data as unknown as ClaimQueryResultV1;
      for (const group of ["definite", "possible", "unresolved", "excluded"] as const) {
        expect(result[group].map((item) => item.assertionId)).toEqual(
          fixture.expected[group],
        );
      }
    }
  });

  it("reports semantically invalid temporal query bounds as invalid requests", () => {
    const fixture = queryFixtures.requests[0]?.request;
    if (fixture === undefined) throw new Error("Missing query fixture");
    const response = executeApiRequest({
      ...fixture,
      payload: {
        ...fixture.payload,
        bundlePath,
        temporal: {
          format: "wmm.temporal-query/1",
          mode: "intersects",
          axisDefinitionDigest: fixture.payload.temporal.axisDefinitionDigest,
          start: "1000",
          endExclusive: "1000",
        },
      },
    });
    expect(response).toMatchObject({
      outcome: "error",
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("returns typed unknown-record and storage failures", () => {
    const unknown = executeApiRequest(
      request("record.inspect", { bundlePath, recordId: "person:missing" }),
    );
    expect(unknown).toMatchObject({
      outcome: "error",
      error: { code: "UNKNOWN_RECORD" },
    });

    const missing = executeApiRequest(
      request("world.validate", { bundlePath: `${bundlePath}-missing` }),
    );
    expect(missing).toMatchObject({
      outcome: "error",
      error: { code: "STORAGE_FAILURE" },
    });
  });
});
