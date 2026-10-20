import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ApiRequestV1,
  ApiResponseV1,
} from "../src/index.js";
import {
  validateApiRequest,
  validateApiResponse,
} from "../src/index.js";

interface ApiFixtures {
  readonly requests: readonly ApiRequestV1[];
  readonly invalidRequests: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../../fixtures/v1/api-requests.json", import.meta.url), "utf8"),
) as ApiFixtures;

describe("wmm/1 API wire contract", () => {
  it("accepts every checked-in request example", () => {
    expect(fixtures.requests).toHaveLength(3);
    for (const request of fixtures.requests) {
      expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
    }
  });

  it("rejects malformed and authority-smuggling request shapes", () => {
    for (const testCase of fixtures.invalidRequests) {
      const result = validateApiRequest(testCase.payload);
      expect(result.valid, testCase.name).toBe(false);
      expect(result.errors.length, testCase.name).toBeGreaterThan(0);
    }
  });

  it("enforces success and error response tags", () => {
    const success: ApiResponseV1 = {
      format: "wmm.response/1",
      apiVersion: "wmm/1",
      requestId: "request-1",
      operation: "world.validate",
      outcome: "success",
      execution: "completed",
      resolved: {
        worldId: "world:valen_v1",
        snapshotDigest: "a".repeat(64),
      },
      data: {
        status: "valid",
        worldId: "world:valen_v1",
        snapshotDigest: "a".repeat(64),
        files: 0,
        descriptors: 0,
        sources: 0,
        assertions: 0,
        activeAssertions: 0,
        supports: 0,
        activeSupports: 0,
      },
      diagnostics: [],
    };
    const error: ApiResponseV1 = {
      format: "wmm.response/1",
      apiVersion: "wmm/1",
      requestId: null,
      operation: null,
      outcome: "error",
      execution: "completed",
      error: { code: "INVALID_REQUEST", message: "Invalid JSON" },
      diagnostics: [],
    };
    expect(validateApiResponse(success).valid).toBe(true);
    expect(validateApiResponse(error).valid).toBe(true);
    expect(
      validateApiResponse({ ...success, outcome: "success", execution: "incomplete" }).valid,
    ).toBe(false);
  });
});
