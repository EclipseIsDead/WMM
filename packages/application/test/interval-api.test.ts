import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  AbsenceQueryResultV1,
  ApiRequestV1,
  IntervalAbsenceResultV1,
} from "@wmm/wire-contracts";
import { validateApiResponse, validateSemanticContract } from "@wmm/wire-contracts";
import { executeApiRequest, operationExitCode } from "../src/index.js";

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

describe("interval absence application API", () => {
  it.each(fixtures.requests)("$name", ({ request, expected }) => {
    const response = executeApiRequest({
      ...request,
      payload: { ...request.payload, bundlePath },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(response).toMatchObject({
      requestId: request.requestId,
      operation: request.operation,
      outcome: expected.outcome,
      execution: expected.execution,
    });
    expect(operationExitCode(request.operation, response)).toBe(expected.exitCode);

    if (expected.outcome === "error") {
      expect(response).toMatchObject({ error: { code: expected.errorCode } });
      expect(response).not.toHaveProperty("data");
      return;
    }
    if (response.outcome !== "success" || response.operation !== "absence.proveThroughout") {
      throw new Error("Expected a completed interval absence result");
    }
    const result = response.data;
    expect(validateSemanticContract(result)).toEqual({ valid: true, errors: [] });
    expect(result).toMatchObject({
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
    expect(result.breakpoints).toEqual(expected.breakpoints);
    expect(result.partitionIssues).toEqual([]);
    expect(result.cells).toHaveLength(expected.cellCount);
    expect(result.cells.map((cell) => ({
      start: cell.start,
      endExclusive: cell.endExclusive,
      representativePosition: cell.representativePosition,
      derivation: cell.evaluation.derivation.status,
      derivationReason: cell.evaluation.derivation.reason,
      witnesses: cell.evaluation.witnesses.status,
    }))).toEqual(expected.cells);
    for (const cell of result.cells) {
      expect(cell.evaluation.temporal).toEqual({
        format: "wmm.temporal-query/1",
        mode: "at",
        axisDefinitionDigest: request.payload.temporal.axisDefinitionDigest,
        position: cell.representativePosition,
      });
    }
  });

  it("publishes the first established proof as the standalone interval request", () => {
    const request: unknown = JSON.parse(readFileSync(
      new URL("../../../fixtures/v2/interval-request.json", import.meta.url),
      "utf8",
    ));
    expect(request).toEqual(fixtures.requests[0]?.request);
  });
});
