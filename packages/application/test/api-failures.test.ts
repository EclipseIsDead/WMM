import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBundledV1WorldBundle, WorldBundleError } from "@wmm/exchange";
import { validateApiResponse } from "@wmm/wire-contracts";
import { executeApiRequest, operationExitCode } from "../src/index.js";

vi.mock("@wmm/exchange", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wmm/exchange")>();
  return { ...actual, loadBundledV1WorldBundle: vi.fn(actual.loadBundledV1WorldBundle) };
});

const realExchange = await vi.importActual<typeof import("@wmm/exchange")>("@wmm/exchange");
const loader = vi.mocked(loadBundledV1WorldBundle);
const bundlePath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const validRequest = {
  format: "wmm.request/1",
  apiVersion: "wmm/1",
  requestId: "direct-request",
  operation: "world.validate",
  payload: { bundlePath },
} as const;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  loader.mockReset().mockImplementation(realExchange.loadBundledV1WorldBundle);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("direct application request validation", () => {
  it.each([
    ["null", null],
    ["scalar", "request"],
    ["array", []],
    ["empty object", {}],
    ["missing format", { ...validRequest, format: undefined }],
    ["invalid format", { ...validRequest, format: "wmm.request/9" }],
    ["non-string version", { ...validRequest, apiVersion: 1 }],
    ["missing operation", { ...validRequest, operation: undefined }],
    ["non-string operation", { ...validRequest, operation: {} }],
    ["missing request ID", { ...validRequest, requestId: undefined }],
    ["empty request ID", { ...validRequest, requestId: "" }],
    ["missing payload", { ...validRequest, payload: undefined }],
    ["null payload", { ...validRequest, payload: null }],
    ["empty path", { ...validRequest, payload: { bundlePath: "" } }],
    ["non-string path", { ...validRequest, payload: { bundlePath: [] } }],
    ["extra authority", { ...validRequest, trusted: true }],
    ["cross-operation payload", { ...validRequest, payload: { bundlePath, recordId: "person:alys" } }],
    ["inherited request", Object.create(validRequest)],
    ["inherited path", { ...validRequest, payload: Object.create({ bundlePath }) }],
    ["non-scalar request ID", { ...validRequest, requestId: "\ud800" }],
    ["non-scalar path", { ...validRequest, payload: { bundlePath: "\udfff" } }],
  ])("rejects %s before invoking the loader", (_name, input) => {
    const response = executeApiRequest(input);
    expect(response).toMatchObject({
      outcome: "error",
      execution: "completed",
      error: { code: "INVALID_REQUEST" },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(loader).not.toHaveBeenCalled();
  });

  it("reports unsupported API versions and operations for direct JavaScript callers", () => {
    for (const [input, code] of [
      [{ ...validRequest, apiVersion: "wmm/9" }, "UNSUPPORTED_API_VERSION"],
      [{ ...validRequest, operation: "world.future" }, "UNSUPPORTED_FEATURE"],
    ] as const) {
      const response = executeApiRequest(input);
      expect(response).toMatchObject({
        outcome: "error",
        execution: "completed",
        requestId: "direct-request",
        operation: input.operation,
        error: { code },
      });
      expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
      expect(operationExitCode("world.validate", response)).toBe(2);
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("echoes only own, well-formed string correlation fields", () => {
    for (const value of [null, 1, {}, [], "\ud800"]) {
      const response = executeApiRequest({
        ...validRequest,
        requestId: value,
        operation: value,
        payload: null,
      });
      expect(response).toMatchObject({
        outcome: "error",
        requestId: null,
        operation: null,
        error: { code: "INVALID_REQUEST" },
      });
      expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    }
    const inherited = Object.assign(Object.create({ requestId: "inherited", operation: "world.validate" }), {
      format: "wmm.request/1",
      apiVersion: "wmm/1",
      payload: null,
    });
    expect(executeApiRequest(inherited)).toMatchObject({
      outcome: "error", requestId: null, operation: null, error: { code: "INVALID_REQUEST" },
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it("does not invoke correlation getters while rejecting a request", () => {
    const getter = vi.fn(() => { throw new Error("Correlation getter must not run"); });
    const input = Object.defineProperties({ ...validRequest, apiVersion: "wmm/9" }, {
      requestId: { get: getter, enumerable: true },
      operation: { get: getter, enumerable: true },
    });
    const response = executeApiRequest(input);
    expect(response).toMatchObject({
      outcome: "error",
      requestId: null,
      operation: null,
      error: { code: "UNSUPPORTED_API_VERSION" },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(getter).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("application failure classification", () => {
  it.each([
    ["INVALID_WORLD", "INVALID_WORLD", "completed", 3],
    ["FILESYSTEM_ERROR", "STORAGE_FAILURE", "completed", 4],
    ["INTERNAL_ERROR", "INTERNAL_ERROR", "incomplete", 4],
  ] as const)("maps the loader's %s code", (loaderCode, apiCode, execution, exitCode) => {
    loader.mockImplementation(() => { throw new WorldBundleError(loaderCode, "Typed loader failure"); });
    const response = executeApiRequest(validRequest);
    expect(response).toMatchObject({
      outcome: "error",
      requestId: "direct-request",
      operation: "world.validate",
      execution,
      error: { code: apiCode, message: "Typed loader failure" },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(operationExitCode("world.validate", response)).toBe(exitCode);
  });

  it("classifies ELOOP as an invalid symlink-containing world", () => {
    const root = mkdtempSync(join(tmpdir(), "wmm-api-loop-"));
    temporaryDirectories.push(root);
    symlinkSync("loop", join(root, "loop"));
    const response = executeApiRequest({
      ...validRequest, payload: { bundlePath: join(root, "loop", "bundle") },
    });
    expect(response).toMatchObject({
      outcome: "error", execution: "completed", error: { code: "INVALID_WORLD" },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  });

  it("classifies ENAMETOOLONG as a storage failure, not an invalid world", () => {
    const response = executeApiRequest({
      ...validRequest, payload: { bundlePath: join(bundlePath, "x".repeat(256)) },
    });
    expect(response).toMatchObject({
      outcome: "error", execution: "completed", error: { code: "STORAGE_FAILURE" },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  });

  for (const { name, failure } of [
    { name: "TypeError", failure: new TypeError("Unexpected implementation bug") },
    { name: "raw errno", failure: Object.assign(new Error("Unexpected raw errno"), { code: "ENOENT" }) },
    { name: "untyped code", failure: { code: "INVALID_WORLD" } },
    { name: "null", failure: null },
    { name: "unprintable object", failure: { toString: () => { throw new Error("Do not stringify arbitrary thrown values"); } } },
  ]) {
    it(`does not misclassify an unexpected ${name} throw as an invalid world`, () => {
      loader.mockImplementation(() => { throw failure; });
      const response = executeApiRequest(validRequest);
      expect(response).toMatchObject({
        outcome: "error",
        execution: "incomplete",
        error: { code: "INTERNAL_ERROR" },
      });
      expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
      expect(operationExitCode("world.validate", response)).toBe(4);
    });
  }
});
