import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  AbsenceQueryResultV1,
  ApiRequestV1,
  IntervalAbsenceResultV1,
} from "@wmm/wire-contracts";
import { validateApiResponse } from "@wmm/wire-contracts";
import { runJsonTransport, serializeJsonTransportResult } from "../src/json-transport.js";

type ThroughoutRequest = Extract<ApiRequestV1, { readonly operation: "absence.proveThroughout" }>;
interface IntervalFixtures {
  readonly requests: readonly {
    readonly name: string;
    readonly request: ThroughoutRequest;
    readonly expected:
      | {
          readonly outcome: "success";
          readonly execution: "completed";
          readonly exitCode: 0;
          readonly status: IntervalAbsenceResultV1["status"];
          readonly reason: IntervalAbsenceResultV1["reason"];
          readonly breakpoints: readonly string[];
          readonly cellCount: number;
          readonly cells: readonly {
            readonly start: string;
            readonly endExclusive: string;
            readonly representativePosition: string;
            readonly derivation: AbsenceQueryResultV1["derivation"]["status"];
            readonly derivationReason: AbsenceQueryResultV1["derivation"]["reason"];
            readonly witnesses: AbsenceQueryResultV1["witnesses"]["status"];
          }[];
        }
      | {
          readonly outcome: "error";
          readonly execution: "incomplete";
          readonly exitCode: 4;
          readonly errorCode: "BUDGET_EXCEEDED";
        };
  }[];
}

const bundlePath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const fixtures = JSON.parse(readFileSync(
  new URL("../../../fixtures/v2/interval-query-cases.json", import.meta.url),
  "utf8",
)) as IntervalFixtures;

describe("interval absence JSON transport", () => {
  it.each(fixtures.requests)("$name", ({ request, expected }) => {
    const result = runJsonTransport(Buffer.from(JSON.stringify({
      ...request,
      payload: { ...request.payload, bundlePath },
    }), "utf8"));
    expect(result.exitCode).toBe(expected.exitCode);
    expect(validateApiResponse(result.response)).toEqual({ valid: true, errors: [] });
    expect(result.response).toMatchObject({
      requestId: request.requestId,
      operation: "absence.proveThroughout",
      outcome: expected.outcome,
      execution: expected.execution,
    });
    const serialized = serializeJsonTransportResult(result);
    expect(serialized.exitCode).toBe(expected.exitCode);
    expect(serialized.output.split("\n")).toHaveLength(2);
    expect(JSON.parse(serialized.output)).toEqual(result.response);

    if (expected.outcome === "error") {
      expect(result.response).toMatchObject({ error: { code: expected.errorCode } });
      expect(result.response).not.toHaveProperty("data");
      expect(JSON.parse(serialized.output)).not.toHaveProperty("data");
      return;
    }
    const response = result.response;
    if (response.outcome !== "success" || response.operation !== "absence.proveThroughout") {
      throw new Error("Expected a completed interval absence result through the JSON transport");
    }
    expect(response.data).toMatchObject({
      format: "wmm.interval-absence-result/1",
      algorithm: "bundled-absence-throughout-v1",
      ...response.resolved,
      target: request.payload.target,
      scope: request.payload.scope,
      temporal: request.payload.temporal,
      execution: "completed",
      status: expected.status,
      reason: expected.reason,
    });
    expect(response.data.breakpoints).toEqual(expected.breakpoints);
    expect(response.data.partitionIssues).toEqual([]);
    expect(response.data.cells).toHaveLength(expected.cellCount);
    expect(response.data.cells.map((cell) => ({
      start: cell.start,
      endExclusive: cell.endExclusive,
      representativePosition: cell.representativePosition,
      derivation: cell.evaluation.derivation.status,
      derivationReason: cell.evaluation.derivation.reason,
      witnesses: cell.evaluation.witnesses.status,
    }))).toEqual(expected.cells);
  });
});
