import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateApiResponse } from "@wmm/wire-contracts";
import { MAX_JSON_DEPTH, MAX_REQUEST_BYTES } from "../src/json-input.js";
import { runJsonTransport, serializeJsonTransportResult } from "../src/json-transport.js";

const bundlePath = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");
const absenceRequest = JSON.parse(
  readFileSync(new URL("../../../fixtures/v2/absence-request.json", import.meta.url), "utf8"),
) as { readonly payload: Readonly<Record<string, unknown>> };

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
        scopeCoverage: "exhaustive",
      },
    });
  });

  it("distinguishes derived absence from an empty search", () => {
    const result = runJsonTransport(
      bytes({
        ...absenceRequest,
        payload: { ...absenceRequest.payload, bundlePath },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(validateApiResponse(result.response).valid).toBe(true);
    expect(result.response).toMatchObject({
      requestId: "absence-at-1005",
      operation: "absence.query",
      outcome: "success",
      data: {
        format: "wmm.absence-query-result/1",
        conclusion: {
          status: "absence-declared-and-derived",
          bases: ["declared", "derived"],
        },
        witnesses: { status: "none-recorded" },
        derivation: {
          status: "established",
          reason: "all-candidates-ineligible",
        },
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

  it.each([
    `"__proto__":{}`,
    `"__proto__":{"requestId":"inherited"}`,
    `"\\u005f_proto__":null`,
  ])("rejects an ordinary own __proto__ key through the closed schema: %s", (property) => {
    const request = `{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"proto-1","operation":"world.validate","payload":{"bundlePath":${JSON.stringify(bundlePath)}},${property}}`;
    const result = runJsonTransport(Buffer.from(request, "utf8"));
    expect(result.exitCode).toBe(2);
    expect(validateApiResponse(result.response).valid).toBe(true);
    expect(result.response).toMatchObject({
      requestId: "proto-1",
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("schema") },
    });
  });

  it.each([
    `{"bundlePath":${JSON.stringify(bundlePath)},"__proto__":{}}`,
    `{"__proto__":{"bundlePath":${JSON.stringify(bundlePath)}}}`,
  ])("does not accept prototype keys or inherited payload fields: %s", (payload) => {
    const request = `{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"proto-payload","operation":"world.validate","payload":${payload}}`;
    const result = runJsonTransport(Buffer.from(request, "utf8"));
    expect(result.exitCode).toBe(2);
    expect(result.response).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it.each(["requestId", "operation", "apiVersion", "format", "bundlePath"])(
    "rejects escaped lone surrogates in %s before constructing correlation errors",
    (field) => {
      for (const value of ["\ud800", "\udfff", "\ud800x", "\udc00\ud800"]) {
        const request: Record<string, unknown> = {
          format: "wmm.request/1",
          apiVersion: "wmm/2",
          requestId: "unicode-1",
          operation: "world.unknown",
          payload: { bundlePath },
        };
        if (field === "bundlePath") request["payload"] = { bundlePath: value };
        else request[field] = value;
        const result = runJsonTransport(bytes(request));
        expect(result.exitCode).toBe(2);
        expect(result.response).toMatchObject({
          format: "wmm.response/1",
          requestId: null,
          operation: null,
          error: { code: "INVALID_REQUEST", message: expect.stringContaining("Unicode scalar") },
        });
        expect(validateApiResponse(result.response).valid).toBe(true);
        expect(serializeJsonTransportResult(result).exitCode).toBe(2);
      }
    },
  );

  it("rejects non-scalar property names without echoing them", () => {
    const result = runJsonTransport(Buffer.from('{"\\ud800":1,"\\ud800":2}', "utf8"));
    expect(result.exitCode).toBe(2);
    expect(result.response).toMatchObject({
      requestId: null,
      operation: null,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("Unicode scalar") },
    });
    expect(serializeJsonTransportResult(result).output.isWellFormed()).toBe(true);
  });

  it("rejects malformed UTF-8 without replacing it", () => {
    const result = runJsonTransport(Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]));
    expect(result.exitCode).toBe(2);
    expect(result.response).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(validateApiResponse(result.response).valid).toBe(true);
  });

  it("accepts scalar supplementary characters in request correlation", () => {
    const result = runJsonTransport(bytes({
      format: "wmm.request/1",
      apiVersion: "wmm/1",
      requestId: "unicode-😀",
      operation: "record.inspect",
      payload: { bundlePath, recordId: "person:missing" },
    }));
    expect(result.exitCode).toBe(3);
    expect(result.response.requestId).toBe("unicode-😀");
    expect(serializeJsonTransportResult(result).exitCode).toBe(3);
  });

  it("enforces byte and parsing budgets as invalid requests", () => {
    const oversized = runJsonTransport(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20));
    expect(oversized.exitCode).toBe(2);
    expect(oversized.response).toMatchObject({
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("transport limit") },
    });
    const nested = runJsonTransport(Buffer.from("[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1)));
    expect(nested.exitCode).toBe(2);
    expect(nested.response).toMatchObject({
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("nesting limit") },
    });
  });

  it("does not weaken operation payload validation", () => {
    const result = runJsonTransport(bytes({
      format: "wmm.request/1",
      apiVersion: "wmm/1",
      requestId: "payload-1",
      operation: "world.validate",
      payload: { bundlePath, recordId: "person:alys" },
    }));
    expect(result.exitCode).toBe(2);
    expect(result.response).toMatchObject({ error: { code: "INVALID_REQUEST" } });
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
