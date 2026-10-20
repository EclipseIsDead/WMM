import {
  ClaimQueryInputError,
  IntervalAbsenceBudgetError,
  proveAbsenceThroughout,
  queryAbsence,
  queryActiveClaims,
} from "@wmm/core";
import {
  exportWorldBundle,
  inspectWorldBundle,
  loadBundledV1WorldBundle,
  validateWorldBundle,
  WorldBundleError,
} from "@wmm/exchange";
import type {
  ApiErrorCodeV1,
  ApiErrorResponseV1,
  ApiOperationV1,
  ApiRequestV1,
  ApiResponseV1,
  ApiResultByOperationV1,
  ApiSuccessResponseV1,
  ResolvedSnapshotV1,
} from "@wmm/wire-contracts";
import { validateApiRequest } from "@wmm/wire-contracts";

const SUPPORTED_OPERATIONS: ReadonlySet<string> = new Set(
  [
    "world.validate",
    "record.inspect",
    "world.export",
    "claims.query",
    "absence.query",
    "absence.proveThroughout",
  ] satisfies readonly ApiOperationV1[],
);

export function apiErrorResponse(
  code: ApiErrorCodeV1,
  message: string,
  requestId: string | null,
  operation: string | null,
  execution: "completed" | "incomplete" = "completed",
): ApiErrorResponseV1 {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId,
    operation,
    outcome: "error",
    execution,
    error: { code, message },
    diagnostics: [],
  };
}

type OperationResult = {
  [Operation in ApiOperationV1]: {
    readonly operation: Operation;
    readonly data: ApiResultByOperationV1[Operation];
  };
}[ApiOperationV1];

function successResponse(
  requestId: string,
  resolved: ResolvedSnapshotV1,
  result: OperationResult,
): ApiSuccessResponseV1 {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId,
    outcome: "success",
    execution: "completed",
    resolved,
    ...result,
    diagnostics: [],
  };
}

function ownScalarString(input: unknown, key: string): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  // Error correlation must not invoke getters or echo inherited/non-scalar values.
  const value: unknown = Object.getOwnPropertyDescriptor(input, key)?.value;
  return typeof value === "string" && value.isWellFormed() ? value : null;
}

export function executeApiRequest(input: unknown): ApiResponseV1 {
  let requestId: string | null = null;
  let operation: string | null = null;
  try {
    requestId = ownScalarString(input, "requestId");
    operation = ownScalarString(input, "operation");
    const apiVersion = ownScalarString(input, "apiVersion");
    if (apiVersion !== null && apiVersion !== "wmm/1") {
      return apiErrorResponse(
        "UNSUPPORTED_API_VERSION",
        `Unsupported API version: ${apiVersion}`,
        requestId,
        operation,
      );
    }
    if (operation !== null && !SUPPORTED_OPERATIONS.has(operation)) {
      return apiErrorResponse(
        "UNSUPPORTED_FEATURE",
        `Unsupported operation: ${operation}`,
        requestId,
        operation,
      );
    }
    if (!validateApiRequest(input).valid) {
      return apiErrorResponse(
        "INVALID_REQUEST",
        "Request does not satisfy the wmm/1 operation schema",
        requestId,
        operation,
      );
    }

    const request = input as ApiRequestV1;
    const world = loadBundledV1WorldBundle(request.payload.bundlePath);
    const resolved: ResolvedSnapshotV1 = {
      worldId: world.world.worldId,
      snapshotDigest: world.snapshot.snapshotDigest,
    };

    switch (request.operation) {
      case "world.validate":
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: validateWorldBundle(world),
        });
      case "record.inspect": {
        const record = inspectWorldBundle(world, request.payload.recordId);
        if (record === undefined) {
          return apiErrorResponse(
            "UNKNOWN_RECORD",
            `Unknown world record: ${request.payload.recordId}`,
            request.requestId,
            request.operation,
          );
        }
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: record,
        });
      }
      case "world.export":
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: exportWorldBundle(world),
        });
      case "claims.query":
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: queryActiveClaims(
            {
              activeAssertionIds: world.world.activeAssertionIds,
              activeSupportIds: world.world.activeSupportIds,
              assertions: world.assertions,
              supports: world.supports,
            },
            request.payload.scope,
            request.payload.temporal,
          ),
        });
      case "absence.query":
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: queryAbsence(
            {
              worldId: world.world.worldId,
              snapshotDigest: world.snapshot.snapshotDigest,
              activeAssertionIds: world.world.activeAssertionIds,
              assertions: world.assertions,
              definitionsByDigest: world.definitionsByDigest,
              descriptors: world.descriptors,
              rosters: world.rosters,
            },
            request.payload.target,
            request.payload.scope,
            request.payload.temporal,
          ),
        });
      case "absence.proveThroughout":
        return successResponse(request.requestId, resolved, {
          operation: request.operation,
          data: proveAbsenceThroughout(
            {
              worldId: world.world.worldId,
              snapshotDigest: world.snapshot.snapshotDigest,
              activeAssertionIds: world.world.activeAssertionIds,
              assertions: world.assertions,
              definitionsByDigest: world.definitionsByDigest,
              descriptors: world.descriptors,
              rosters: world.rosters,
            },
            request.payload.target,
            request.payload.scope,
            request.payload.temporal,
            request.payload.limits,
          ),
        });
    }
  } catch (error) {
    if (error instanceof IntervalAbsenceBudgetError) {
      return apiErrorResponse("BUDGET_EXCEEDED", error.message, requestId, operation, "incomplete");
    }
    if (error instanceof WorldBundleError) {
      const code: ApiErrorCodeV1 = error.code === "FILESYSTEM_ERROR"
        ? "STORAGE_FAILURE"
        : error.code;
      return apiErrorResponse(
        code,
        error.message,
        requestId,
        operation,
        code === "INTERNAL_ERROR" ? "incomplete" : "completed",
      );
    }
    if (error instanceof ClaimQueryInputError) {
      return apiErrorResponse("INVALID_REQUEST", error.message, requestId, operation);
    }
    return apiErrorResponse(
      "INTERNAL_ERROR",
      "Unexpected application failure",
      requestId,
      operation,
      "incomplete",
    );
  }
}

export function operationExitCode(operation: ApiOperationV1, response: ApiResponseV1): number {
  if (response.outcome === "success") return 0;
  switch (response.error.code) {
    case "UNSUPPORTED_API_VERSION":
    case "UNSUPPORTED_FEATURE":
    case "INVALID_REQUEST":
      return 2;
    case "INVALID_WORLD":
    case "UNKNOWN_RECORD":
      return 3;
    case "BUDGET_EXCEEDED":
    case "STORAGE_FAILURE":
    case "INTERNAL_ERROR":
      return 4;
  }
  const exhaustive: never = response.error.code;
  throw new Error(`Unhandled API error for ${operation}: ${exhaustive}`);
}
