import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ApiRequestV1 } from "@wmm/wire-contracts";
import { validateApiResponse } from "@wmm/wire-contracts";
import { executeApiRequest } from "../src/index.js";

const bundlePath = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);

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
