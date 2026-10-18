import {
  parse,
  printParseErrorCode,
  visit,
  type ParseError,
} from "jsonc-parser";

import {
  apiErrorResponse,
  executeApiRequest,
} from "@wmm/application";
import type {
  ApiErrorCodeV1,
  ApiRequestV1,
  ApiResponseV1,
} from "@wmm/wire-contracts";
import {
  validateApiRequest,
  validateApiResponse,
} from "@wmm/wire-contracts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const SUPPORTED_OPERATIONS = new Set([
  "world.validate",
  "record.inspect",
  "world.export",
]);

export interface JsonTransportResult {
  readonly response: ApiResponseV1;
  readonly exitCode: number;
}

class RequestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestParseError";
  }
}

function parseStrictJson(text: string): unknown {
  const objectKeys: Set<string>[] = [];
  let duplicateKey: string | undefined;
  const visitorErrors: ParseError[] = [];

  visit(
    text,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        const keys = objectKeys.at(-1);
        if (keys?.has(property) === true) duplicateKey ??= property;
        keys?.add(property);
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
      onError: (error, offset, length) => {
        visitorErrors.push({ error, offset, length });
      },
    },
    { allowTrailingComma: false, disallowComments: true },
  );

  if (duplicateKey !== undefined) {
    throw new RequestParseError(`Duplicate JSON object key: ${duplicateKey}`);
  }
  if (visitorErrors.length > 0) {
    const first = visitorErrors[0];
    throw new RequestParseError(
      `Invalid JSON: ${first === undefined ? "unknown parse error" : printParseErrorCode(first.error)}`,
    );
  }

  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new RequestParseError(
      `Invalid JSON: ${first === undefined ? "unknown parse error" : printParseErrorCode(first.error)}`,
    );
  }
  return value;
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
  return {
    requestId: typeof record["requestId"] === "string" ? record["requestId"] : null,
    operation: typeof record["operation"] === "string" ? record["operation"] : null,
    apiVersion: typeof record["apiVersion"] === "string" ? record["apiVersion"] : null,
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

function checkedResponse(response: ApiResponseV1): JsonTransportResult {
  const validation = validateApiResponse(response);
  if (!validation.valid) {
    const internal = apiErrorResponse(
      "INTERNAL_ERROR",
      "Application produced a response outside the V1 wire contract",
      response.requestId,
      response.operation,
      "incomplete",
    );
    return { response: internal, exitCode: 4 };
  }
  return {
    response,
    exitCode: response.outcome === "success" ? 0 : errorExitCode(response.error.code),
  };
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
}
