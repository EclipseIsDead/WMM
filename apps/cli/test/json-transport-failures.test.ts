import { afterEach, describe, expect, it, vi } from "vitest";

import { executeApiRequest } from "@wmm/application";
import { validateApiResponse, type ApiResponseV1 } from "@wmm/wire-contracts";
import {
  jsonTransportError,
  runJsonTransport,
  serializeJsonTransportResult,
} from "../src/json-transport.js";

vi.mock("@wmm/application", async (importOriginal) => ({
  ...await importOriginal<typeof import("@wmm/application")>(),
  executeApiRequest: vi.fn(),
}));

afterEach(() => { vi.mocked(executeApiRequest).mockReset(); });

const request = Buffer.from(JSON.stringify({
  format: "wmm.request/1",
  apiVersion: "wmm/1",
  requestId: "failure-1",
  operation: "world.validate",
  payload: { bundlePath: "." },
}));

describe("JSON response failure boundary", () => {
  it("maps budget errors to incomplete execution with exit 4 and no data", () => {
    const result = jsonTransportError(
      "BUDGET_EXCEEDED", "Interval cell budget exceeded", "budget-1", "absence.proveThroughout",
    );
    expect(result.exitCode).toBe(4);
    expect(result.response).toMatchObject({
      requestId: "budget-1",
      operation: "absence.proveThroughout",
      outcome: "error",
      execution: "incomplete",
      error: { code: "BUDGET_EXCEEDED" },
    });
    expect(result.response).not.toHaveProperty("data");
    expect(validateApiResponse(result.response)).toEqual({ valid: true, errors: [] });
    expect(serializeJsonTransportResult(result).exitCode).toBe(4);
  });

  it("maps an unexpected application exception to a correlated internal error", () => {
    vi.mocked(executeApiRequest).mockImplementationOnce(() => {
      throw new Error("Untrusted failure with a lone surrogate: \ud800");
    });
    const result = runJsonTransport(request);
    expect(result.exitCode).toBe(4);
    expect(result.response).toMatchObject({
      format: "wmm.response/1",
      requestId: "failure-1",
      operation: "world.validate",
      outcome: "error",
      execution: "incomplete",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(validateApiResponse(result.response).valid).toBe(true);
    expect(serializeJsonTransportResult(result).exitCode).toBe(4);
  });

  it("keeps the response schema check and does not emit invalid application output", () => {
    vi.mocked(executeApiRequest).mockReturnValueOnce({
      ...jsonTransportError("INVALID_WORLD", "invalid world", "failure-1", "world.validate").response,
      diagnostics: "not an array",
    } as unknown as ApiResponseV1);
    const result = runJsonTransport(request);
    expect(result.exitCode).toBe(4);
    expect(result.response).toMatchObject({
      requestId: "failure-1",
      operation: "world.validate",
      execution: "incomplete",
      error: { code: "INTERNAL_ERROR", message: expect.stringContaining("wire contract") },
    });
    expect(validateApiResponse(result.response).valid).toBe(true);
  });

  it("replaces a non-canonical response with one canonical protocol error", () => {
    const result = jsonTransportError("INVALID_WORLD", "Invalid Unicode: \ud800", "failure-1", "world.validate");
    const serialized = serializeJsonTransportResult(result);
    expect(serialized.exitCode).toBe(4);
    expect(serialized.output.split("\n")).toHaveLength(2);
    const response: unknown = JSON.parse(serialized.output);
    expect(response).toMatchObject({
      format: "wmm.response/1",
      requestId: "failure-1",
      operation: "world.validate",
      execution: "incomplete",
      error: { code: "INTERNAL_ERROR", message: expect.stringContaining("serialize") },
    });
    expect(validateApiResponse(response).valid).toBe(true);
  });

  it("does not reuse malformed Unicode correlation when serializing a fallback", () => {
    const result = jsonTransportError("INVALID_REQUEST", "bad request", "\ud800", "world.\udfff");
    const serialized = serializeJsonTransportResult(result);
    expect(serialized.exitCode).toBe(4);
    const response: unknown = JSON.parse(serialized.output);
    expect(response).toMatchObject({
      format: "wmm.response/1",
      requestId: null,
      operation: null,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(validateApiResponse(response).valid).toBe(true);
  });

  it("handles cyclic response values without leaking development-mode output", () => {
    const result = jsonTransportError("INVALID_REQUEST", "bad request", "cycle-1", "world.validate");
    const diagnostics: unknown[] = [];
    diagnostics.push(diagnostics);
    const serialized = serializeJsonTransportResult({
      ...result,
      response: { ...result.response, diagnostics } as unknown as ApiResponseV1,
    });
    expect(serialized.exitCode).toBe(4);
    expect(JSON.parse(serialized.output)).toMatchObject({
      format: "wmm.response/1",
      requestId: "cycle-1",
      error: { code: "INTERNAL_ERROR" },
    });
  });
});
