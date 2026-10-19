import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateApiResponse } from "@wmm/wire-contracts";
import { runJsonTransport } from "../src/json-transport.js";

const bundlePath = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");

describe("JSON stdin transport", () => {
  it("executes a valid request and preserves correlation", () => {
    const result = runJsonTransport(
      bytes({
        format: "wmm.request/1",
        apiVersion: "wmm/1",
        requestId: "transport-1",
        operation: "record.inspect",
        payload: { bundlePath, recordId: "person:alys" },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(validateApiResponse(result.response).valid).toBe(true);
    expect(result.response).toMatchObject({
      requestId: "transport-1",
      operation: "record.inspect",
      outcome: "success",
      data: { id: "person:alys" },
    });
  });

  it("executes claim queries through the strict JSON transport", () => {
    const result = runJsonTransport(
      bytes({
        format: "wmm.request/1",
        apiVersion: "wmm/1",
        requestId: "claims-transport-1",
        operation: "claims.query",
        payload: {
          bundlePath,
          scope: {
            account: { kind: "ref", id: "account:canonical" },
            jurisdiction: { kind: "ref", id: "polity:valen" },
            recognitionFrame: { kind: "ref", id: "frame:royal-court" },
          },
          temporal: {
            format: "wmm.temporal-query/1",
            mode: "at",
            axisDefinitionDigest:
              "8c82e615f363d8c4b497b49d497f8cf4f93727f60034ceb471d2bad7382f0667",
            position: "1005",
          },
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(validateApiResponse(result.response).valid).toBe(true);
    expect(result.response).toMatchObject({
      requestId: "claims-transport-1",
      operation: "claims.query",
      outcome: "success",
      data: {
        format: "wmm.claim-query-result/1",
        definite: [{ polarity: "negative" }, { polarity: "positive" }],
        possible: [],
        unresolved: [],
        excluded: [],
        scopeCoverage: "exhaustive",
      },
    });
  });

  it("rejects duplicate keys before schema validation", () => {
    const result = runJsonTransport(
      Buffer.from(
        `{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"one","requestId":"two","operation":"world.validate","payload":{"bundlePath":${JSON.stringify(bundlePath)}}}`,
        "utf8",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.response).toMatchObject({
      requestId: null,
      outcome: "error",
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("Duplicate") },
    });
  });

  it("distinguishes malformed, unsupported-version, and unsupported-operation requests", () => {
    const malformed = runJsonTransport(Buffer.from("{", "utf8"));
    expect(malformed.response).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const version = runJsonTransport(
      bytes({
        format: "wmm.request/1",
        apiVersion: "wmm/2",
        requestId: "version-1",
        operation: "world.validate",
        payload: { bundlePath },
      }),
    );
    expect(version.response).toMatchObject({
      requestId: "version-1",
      error: { code: "UNSUPPORTED_API_VERSION" },
    });

    const operation = runJsonTransport(
      bytes({
        format: "wmm.request/1",
        apiVersion: "wmm/1",
        requestId: "operation-1",
        operation: "world.delete",
        payload: { bundlePath },
      }),
    );
    expect(operation.response).toMatchObject({
      operation: "world.delete",
      error: { code: "UNSUPPORTED_FEATURE" },
    });
  });

  it("returns a typed unknown-record response", () => {
    const result = runJsonTransport(
      bytes({
        format: "wmm.request/1",
        apiVersion: "wmm/1",
        requestId: "missing-1",
        operation: "record.inspect",
        payload: { bundlePath, recordId: "person:missing" },
      }),
    );
    expect(result.exitCode).toBe(3);
    expect(result.response).toMatchObject({
      requestId: "missing-1",
      outcome: "error",
      error: { code: "UNKNOWN_RECORD" },
    });
  });
});
