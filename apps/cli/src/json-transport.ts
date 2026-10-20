import { canonicalJson } from "@wmm/canonical";
import {
  apiErrorResponse,
  executeApiRequest,
} from "@wmm/application";
import type {
  ApiErrorCodeV1,
  ApiOperationV1,
  ApiRequestV1,
  ApiResponseV1,
  JsonValue,
} from "@wmm/wire-contracts";
import {
  validateApiRequest,
  validateApiResponse,
} from "@wmm/wire-contracts";

import { MAX_REQUEST_BYTES, parseStrictJson } from "./json-input.js";

const SUPPORTED_OPERATIONS: ReadonlySet<string> = new Set(
  [
    "world.validate",
    "record.inspect",
    "world.export",
    "claims.query",
    "absence.query",
  ] satisfies readonly ApiOperationV1[],
);

export interface JsonTransportResult {
  readonly response: ApiResponseV1;
  readonly exitCode: number;
}

function metadata(input: unknown): {
  readonly requestId: string | null;
  readonly operation: string | null;
  readonly apiVersion: string | null;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { requestId: null, operation: null, apiVersion: null };
  }
  const record = input as Record<string, unknown>;
  const scalarString = (key: string): string | null => {
    if (!Object.hasOwn(record, key)) return null;
    const value = record[key];
    return typeof value === "string" && value.isWellFormed() ? value : null;
  };
  return {
    requestId: scalarString("requestId"),
    operation: scalarString("operation"),
    apiVersion: scalarString("apiVersion"),
  };
}

function errorExitCode(code: ApiErrorCodeV1): number {
  switch (code) {
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
}

export function jsonTransportError(
  code: ApiErrorCodeV1,
  message: string,
  requestId: string | null = null,
  operation: string | null = null,
): JsonTransportResult {
  return {
    response: apiErrorResponse(
      code,
      message,
      requestId,
      operation,
      code === "INTERNAL_ERROR" ? "incomplete" : "completed",
    ),
    exitCode: errorExitCode(code),
  };
}

function checkedResponse(response: ApiResponseV1): JsonTransportResult {
  const validation = validateApiResponse(response);
  if (!validation.valid) {
    const correlation = metadata(response);
    return jsonTransportError(
      "INTERNAL_ERROR",
      "Application produced a response outside the V1 wire contract",
      correlation.requestId,
      correlation.operation,
    );
  }
  return {
    response,
    exitCode: response.outcome === "success" ? 0 : errorExitCode(response.error.code),
  };
}

export function serializeJsonTransportResult(result: JsonTransportResult): {
  readonly output: string;
  readonly exitCode: number;
} {
  try {
    return {
      output: `${canonicalJson(result.response as unknown as JsonValue)}\n`,
      exitCode: result.exitCode,
    };
  } catch {
    const correlation = metadata(result.response);
    const fallback = jsonTransportError(
      "INTERNAL_ERROR",
      "Unable to serialize the JSON response",
      correlation.requestId,
      correlation.operation,
    );
    return {
      output: `${canonicalJson(fallback.response as unknown as JsonValue)}\n`,
      exitCode: fallback.exitCode,
    };
  }
}

export function runJsonTransport(bytes: Uint8Array): JsonTransportResult {
  if (bytes.length > MAX_REQUEST_BYTES) {
    return checkedResponse(
      apiErrorResponse(
        "INVALID_REQUEST",
        "JSON request exceeds the one-megabyte transport limit",
        null,
        null,
      ),
    );
  }

  let input: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    input = parseStrictJson(text);
  } catch (error) {
    return checkedResponse(
      apiErrorResponse(
        "INVALID_REQUEST",
        error instanceof Error ? error.message : String(error),
        null,
        null,
      ),
    );
  }

  const requestMetadata = metadata(input);
  if (
    requestMetadata.apiVersion !== null &&
    requestMetadata.apiVersion !== "wmm/1"
  ) {
    return checkedResponse(
      apiErrorResponse(
        "UNSUPPORTED_API_VERSION",
        `Unsupported API version: ${requestMetadata.apiVersion}`,
        requestMetadata.requestId,
        requestMetadata.operation,
      ),
    );
  }
  if (
    requestMetadata.operation !== null &&
    !SUPPORTED_OPERATIONS.has(requestMetadata.operation)
  ) {
    return checkedResponse(
      apiErrorResponse(
        "UNSUPPORTED_FEATURE",
        `Unsupported operation: ${requestMetadata.operation}`,
        requestMetadata.requestId,
        requestMetadata.operation,
      ),
    );
  }

  try {
    const validation = validateApiRequest(input);
    if (!validation.valid) {
      return checkedResponse(
        apiErrorResponse(
          "INVALID_REQUEST",
          "Request does not satisfy the wmm/1 operation schema",
          requestMetadata.requestId,
          requestMetadata.operation,
        ),
      );
    }

    return checkedResponse(executeApiRequest(input as ApiRequestV1));
  } catch {
    return jsonTransportError(
      "INTERNAL_ERROR",
      "Unable to process the JSON request",
      requestMetadata.requestId,
      requestMetadata.operation,
    );
  }
}
