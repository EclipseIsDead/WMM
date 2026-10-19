import { ClaimQueryInputError, queryActiveClaims } from "@wmm/core";
import {
  exportWorldBundle,
  inspectWorldBundle,
  loadBundledV1WorldBundle,
  validateWorldBundle,
} from "@wmm/exchange";
import type {
  ApiErrorCodeV1,
  ApiOperationV1,
  ApiRequestV1,
  ApiResponseV1,
  JsonValue,
} from "@wmm/wire-contracts";

export function apiErrorResponse(
  code: ApiErrorCodeV1,
  message: string,
  requestId: string | null,
  operation: string | null,
  execution: "completed" | "incomplete" = "completed",
): ApiResponseV1 {
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

function successResponse(
  request: ApiRequestV1,
  worldId: string,
  snapshotDigest: string,
  data: JsonValue,
): ApiResponseV1 {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId: request.requestId,
    operation: request.operation,
    outcome: "success",
    execution: "completed",
    resolved: { worldId, snapshotDigest },
    data,
    diagnostics: [],
  };
}

function isStorageError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOTDIR" ||
    code === "EISDIR"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function executeApiRequest(request: ApiRequestV1): ApiResponseV1 {
  try {
    const world = loadBundledV1WorldBundle(request.payload.bundlePath);
    let data: JsonValue;

    switch (request.operation) {
      case "world.validate":
        data = validateWorldBundle(world) as unknown as JsonValue;
        break;
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
        data = record;
        break;
      }
      case "world.export":
        data = exportWorldBundle(world);
        break;
      case "claims.query":
        data = queryActiveClaims(
          {
            activeAssertionIds: world.world.activeAssertionIds,
            activeSupportIds: world.world.activeSupportIds,
            assertions: world.assertions,
            supports: world.supports,
          },
          request.payload.scope,
          request.payload.temporal,
        ) as unknown as JsonValue;
        break;
    }

    return successResponse(
      request,
      world.world.worldId,
      world.snapshot.snapshotDigest,
      data,
    );
  } catch (error) {
    const code: ApiErrorCodeV1 = isStorageError(error)
      ? "STORAGE_FAILURE"
      : error instanceof ClaimQueryInputError
        ? "INVALID_REQUEST"
        : "INVALID_WORLD";
    return apiErrorResponse(
      code,
      errorMessage(error),
      request.requestId,
      request.operation,
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
    case "STORAGE_FAILURE":
    case "INTERNAL_ERROR":
      return 4;
  }
  const exhaustive: never = response.error.code;
  throw new Error(`Unhandled API error for ${operation}: ${exhaustive}`);
}
