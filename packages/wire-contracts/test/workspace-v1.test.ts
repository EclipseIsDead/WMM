import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ApiErrorCodeV1,
  ApiOperationV1,
  ApiRequestV1,
  ApiResultByOperationV1,
  ApiSuccessResponseV1,
  WorkspaceErrorCodeV1,
  WorkspaceRequestV1,
  WorkspaceViewV1,
} from "../src/index.js";
import { validateApiContract, validateApiRequest, validateApiResponse, workspaceV1Schema } from "../src/index.js";
import {
  workspaceActions,
  workspaceAssertion,
  workspaceDigest,
  workspaceMutate,
  workspacePins,
  workspaceProposal,
  workspaceRequests,
  workspaceResponse,
  workspaceView,
} from "./workspace-fixtures.js";

type Path = readonly string[];
function* nodes(value: unknown, path: Path = []): Generator<{ path: Path; value: unknown }> {
  yield { path, value };
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) yield* nodes(child, [...path, key]);
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function objectAt(value: unknown, path: Path): Record<string, unknown> {
  let result = value as Record<string, unknown>;
  for (const key of path) result = result[key] as Record<string, unknown>;
  return result;
}
function replace(value: object, path: Path, replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const copy = structuredClone(value);
  const key = path[path.length - 1];
  if (key === undefined) throw new Error("Missing replacement key");
  objectAt(copy, path.slice(0, -1))[key] = replacement;
  return copy;
}
function extra(value: object, path: Path, key: string, field: unknown): unknown {
  const copy = structuredClone(value);
  objectAt(copy, path)[key] = field;
  return copy;
}
function without(value: object, path: Path, key: string): unknown {
  const copy = structuredClone(value);
  delete objectAt(copy, path)[key];
  return copy;
}
function result(data: unknown): unknown {
  return { ...workspaceResponse(), data };
}
function expectRequest(input: unknown, valid: boolean): void {
  const validation = validateApiRequest(input);
  expect(validation.valid, valid ? JSON.stringify(validation.errors) : undefined).toBe(valid);
  expect(validateApiContract(input).valid).toBe(valid);
}
function expectResult(input: unknown, valid: boolean): void {
  const response = result(input);
  const validation = validateApiResponse(response);
  expect(validation.valid, valid ? JSON.stringify(validation.errors) : undefined).toBe(valid);
  expect(validateApiContract(response).valid).toBe(valid);
}

const create = workspaceRequests[0];
if (create === undefined) throw new Error("Missing create fixture");
const mutate = workspaceMutate({ kind: "put-proposal", proposal: workspaceProposal });
const read: Extract<WorkspaceRequestV1, { operation: "workspace.read" }> = {
  format: "wmm.request/1", apiVersion: "wmm/1", requestId: "historical-read",
  operation: "workspace.read", payload: { workspaceId: "workspace:succession", atVersion: 1 },
};
const workspaceOperations = ["workspace.create", "workspace.read", "workspace.review", "workspace.mutate"] as const;
const errorCodes = [
  "STALE_WORKSPACE", "IDEMPOTENCY_CONFLICT", "WORKSPACE_NOT_FOUND", "WORKSPACE_EXISTS", "INVALID_WORKSPACE_ACTION",
] as const satisfies readonly WorkspaceErrorCodeV1[];

describe("wmm/1 workspace wire contracts", () => {
  it("exports workspace types through the existing discriminated API", () => {
    expectTypeOf<Extract<ApiRequestV1, { operation: WorkspaceRequestV1["operation"] }>>().toEqualTypeOf<WorkspaceRequestV1>();
    expectTypeOf<WorkspaceRequestV1["operation"]>().toExtend<ApiOperationV1>();
    expectTypeOf<WorkspaceErrorCodeV1>().toExtend<ApiErrorCodeV1>();
    expectTypeOf<typeof errorCodes[number]>().toEqualTypeOf<WorkspaceErrorCodeV1>();
    expectTypeOf<ApiResultByOperationV1["workspace.create"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<ApiResultByOperationV1["workspace.read"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<ApiResultByOperationV1["workspace.review"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<ApiResultByOperationV1["workspace.mutate"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<Extract<ApiSuccessResponseV1, { operation: "workspace.read" }>["data"]>().toEqualTypeOf<WorkspaceViewV1>();
    expect(workspaceV1Schema).toMatchObject({ $id: "urn:wmm:workspace:v1" });
  });

  it("accepts creation, current and historical reads, and every nested mutation action", () => {
    for (const request of workspaceRequests) expectRequest(request, true);
    for (const mode of ["world", "succession-demo"]) {
      expectRequest(replace(create, ["payload", "mode"], mode), true);
    }
    expectRequest({ ...read, payload: { workspaceId: "workspace:succession" } }, true);
    expectRequest(replace(read, ["payload", "atVersion"], Number.MAX_SAFE_INTEGER), true);
    expectRequest(replace(mutate, ["payload", "expectedVersion"], Number.MAX_SAFE_INTEGER), true);
  });

  it("closes every request object and requires every nonoptional field", () => {
    for (const request of workspaceRequests) {
      for (const { path, value } of nodes(request)) {
        if (!isObject(value)) continue;
        expectRequest(extra(request, path, "unexpected", true), false);
        for (const key of Object.keys(value)) {
          if (key !== "atVersion" && key !== "reason") expectRequest(without(request, path, key), false);
        }
      }
    }
  });

  it("rejects model-supplied authority at every request nesting level", () => {
    for (const request of workspaceRequests) {
      for (const { path, value } of nodes(request)) {
        if (!isObject(value)) continue;
        for (const key of ["flags", "principal", "approval", "approvalReceiptDigest", "force", "base"]) {
          expectRequest(extra(request, path, key, { approved: true }), false);
        }
      }
    }
  });

  it("does not accept adapter-verified base content or server proposal fields from clients", () => {
    for (const key of ["base", "snapshot", "world", "documents"]) {
      expectRequest(extra(create, ["payload"], key, {}), false);
    }
    for (const [key, value] of Object.entries({ version: 1, decision: "selected", rejectionReason: "Rejected" })) {
      expectRequest(extra(mutate, ["payload", "action", "proposal"], key, value), false);
    }
  });

  it("rejects malformed types throughout requests, including nested actions and assertion bodies", () => {
    for (const request of workspaceRequests) {
      for (const { path, value } of nodes(request)) {
        const invalid = Array.isArray(value) ? {} : isObject(value) ? null
          : typeof value === "string" ? 1 : typeof value === "number" ? "1"
          : typeof value === "boolean" ? "true" : false;
        expectRequest(replace(request, path, invalid), false);
      }
    }
  });

  it("enforces action, mode, decision, pin and operation discriminants", () => {
    expectRequest(replace(create, ["payload", "mode"], "demo"), false);
    expectRequest(replace(mutate, ["payload", "action", "kind"], "approve"), false);
    expectRequest(workspaceMutate({ kind: "decide", groupId: "group:one", decision: "selected" }), true);
    expectRequest(replace(workspaceMutate(workspaceActions[0]), ["payload", "action", "decision"], "approved"), false);
    expectRequest(replace(mutate, ["payload", "action", "proposal", "operations", "0", "kind"], "execute"), false);
    expectRequest(replace(workspaceMutate({ kind: "put-pin", pin: workspacePins[0] }), ["payload", "action", "pin", "kind"], "preference"), false);
    expectRequest({ ...read, operation: "workspace.approve" }, false);
    expectRequest({ ...create, operation: "workspace.read" }, false);
    expectRequest({ ...read, operation: "workspace.mutate" }, false);
    expectRequest({ ...mutate, operation: "workspace.create" }, false);
  });

  it("uses the world AssertionRecord schema for activation and assertion IDs for deactivation", () => {
    expectRequest(mutate, true);
    const operationPath = ["payload", "action", "proposal", "operations"];
    for (const assertion of [
      {}, { id: workspaceAssertion.id },
      { ...workspaceAssertion, body: {} },
      { ...workspaceAssertion, id: "asrt:not-a-digest" },
      { ...workspaceAssertion, body: { ...workspaceAssertion.body, polarity: "neutral" } },
      { ...workspaceAssertion, principal: "host" },
    ]) {
      expectRequest(replace(mutate, [...operationPath, "1", "assertion"], assertion), false);
    }
    expectRequest(replace(mutate, [...operationPath, "2", "assertionId"], "person:regent"), false);
    expectRequest(replace(mutate, [...operationPath, "0", "beforeSha256"], workspaceDigest), true);
    expectRequest(replace(mutate, [...operationPath, "0", "beforeSha256"], "bad-digest"), false);
  });

  it("bounds stable IDs, titles, direction and rationale", () => {
    const cases: readonly [object, Path, number][] = [
      [create, ["requestId"], 256],
      [create, ["payload", "workspaceId"], 256],
      [create, ["payload", "idempotencyKey"], 256],
      [create, ["payload", "title"], 160],
      [create, ["payload", "goal"], 16000],
      [mutate, ["payload", "action", "proposal", "id"], 256],
      [mutate, ["payload", "action", "proposal", "author"], 256],
      [mutate, ["payload", "action", "proposal", "title"], 160],
      [mutate, ["payload", "action", "proposal", "rationale"], 16000],
      [workspaceMutate({ kind: "set-direction", text: "" }), ["payload", "action", "text"], 16000],
      [workspaceMutate({ kind: "decide", groupId: "group:one", decision: "rejected", reason: "" }), ["payload", "action", "reason"], 16000],
      [workspaceMutate({ kind: "add-regency", title: "Regency", rationale: "" }), ["payload", "action", "rationale"], 16000],
    ];
    for (const [request, path, limit] of cases) {
      expectRequest(replace(request, path, "x".repeat(limit)), true);
      expectRequest(replace(request, path, "x".repeat(limit + 1)), false);
    }
    for (const path of [["requestId"], ["payload", "workspaceId"], ["payload", "idempotencyKey"]]) {
      expectRequest(replace(create, path, ""), false);
    }
  });

  it("measures prose in UTF-16 code units, including supplementary characters", () => {
    const path = ["payload", "action", "proposal", "operations", "0", "text"];
    for (const text of ["", "x".repeat(65536), "😀".repeat(32768)]) {
      expectRequest(replace(mutate, path, text), true);
      expectResult(replace(workspaceView, ["documents", "0", "text"], text), true);
    }
    for (const text of ["x".repeat(65537), "😀".repeat(32768) + "x", "😀".repeat(32769)]) {
      expectRequest(replace(mutate, path, text), false);
      expectResult(replace(workspaceView, ["documents", "0", "text"], text), false);
    }
  });

  it("requires portable relative document paths for prose, pins and the read model", () => {
    const prosePath = ["payload", "action", "proposal", "operations", "0", "path"];
    const pin = workspaceMutate({ kind: "put-pin", pin: workspacePins[0] });
    const pinPath = ["payload", "action", "pin", "path"];
    for (const path of ["documents/succession.md", "documents/Chapter-1.txt", "notes/draft.v2.md", "x".repeat(4096)]) {
      expectRequest(replace(mutate, prosePath, path), true);
      expectRequest(replace(pin, pinPath, path), true);
      expectResult(replace(workspaceView, ["documents", "0", "path"], path), true);
    }
    for (const path of [
      "", "/tmp/canon.md", "../canon.md", "documents/../canon.md", "./canon.md", "a//b.md", "a/",
      "C:/canon.md", "documents\\canon.md", "documents/%2e%2e/canon.md", "documents/\u0000.md",
      "documents/canon.md\n", "documents/canon.md\r", "documents/canon.md\r\n",
      "documents/canon.md\u2028", "documents/canon.md\u2029", "x".repeat(4097),
    ]) {
      expectRequest(replace(mutate, prosePath, path), false);
      expectRequest(replace(pin, pinPath, path), false);
      expectResult(replace(workspaceView, ["documents", "0", "path"], path), false);
    }
  });

  it("requires positive safe integer versions for reads, writes, proposals and history", () => {
    for (const version of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      expectRequest(replace(read, ["payload", "atVersion"], version), false);
      expectRequest(replace(mutate, ["payload", "expectedVersion"], version), false);
      for (const path of [["workspace", "version"], ["workspace", "proposals", "0", "version"], ["workspace", "history", "0", "version"]]) {
        expectResult(replace(workspaceView, path, version), false);
      }
    }
  });

  it("bounds every request array to 256 entries", () => {
    for (const request of workspaceRequests) {
      for (const { path, value } of nodes(request)) {
        if (!Array.isArray(value)) continue;
        expectRequest(replace(request, path, Array(256).fill(value[0] ?? "proposal:one")), true);
        expectRequest(replace(request, path, Array(257).fill(value[0] ?? "proposal:one")), false);
      }
    }
  });

  it.each(workspaceOperations)("returns a fully typed view in the unchanged %s machine envelope", (operation) => {
    expect(validateApiResponse(workspaceResponse(workspaceView, operation))).toEqual({ valid: true, errors: [] });
    expect(validateApiResponse({ ...workspaceResponse(workspaceView, operation), resolved: undefined }).valid).toBe(false);
    expect(validateApiResponse({ ...workspaceResponse(workspaceView, operation), execution: "incomplete" }).valid).toBe(false);
    expect(validateApiResponse({ ...workspaceResponse(workspaceView, operation), operation: "workspace.approve" }).valid).toBe(false);
  });

  it.each(workspaceOperations)("accepts optional document digests and keeps %s document results closed", (operation) => {
    const withDigest: WorkspaceViewV1 = {
      ...workspaceView,
      documents: workspaceView.documents.map((document) => ({ ...document, sha256: workspaceDigest })),
    };
    const response = workspaceResponse(withDigest, operation);
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(validateApiContract(response).valid).toBe(true);
    expect(validateApiResponse(without(response, ["data", "documents", "0"], "sha256")).valid).toBe(true);
    for (const sha256 of [null, false, 1, {}, [], "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
      expect(validateApiResponse(replace(response, ["data", "documents", "0", "sha256"], sha256)).valid).toBe(false);
    }
    for (const key of ["unexpected", "principal", "approval"]) {
      expect(validateApiResponse(extra(response, ["data", "documents", "0"], key, true)).valid).toBe(false);
    }
  });

  it("accepts a historical version without requiring the current state's proposals or history", () => {
    const historical: WorkspaceViewV1 = {
      ...workspaceView,
      workspace: { ...workspaceView.workspace, version: 1, proposals: [], pins: [], history: [] },
      changes: [],
      prerequisites: [],
      selection: { requested: [], required: [], missing: [], rejectedRequired: [], diagnostics: [] },
    };
    expectRequest(read, true);
    expect(validateApiResponse(workspaceResponse(historical, "workspace.read"))).toEqual({ valid: true, errors: [] });
  });

  it("closes and requires the entire read model, base identifiers, state and typed history", () => {
    const response = workspaceResponse();
    for (const { path, value } of nodes(response)) {
      if (!isObject(value)) continue;
      expect(validateApiResponse(extra(response, path, "unexpected", true)).valid).toBe(false);
      for (const key of Object.keys(value)) {
        if (key !== "reason") expect(validateApiResponse(without(response, path, key)).valid).toBe(false);
      }
    }
    expectResult(replace(workspaceView, ["workspace", "base", "worldId"], "person:regent"), false);
    expectResult(replace(workspaceView, ["workspace", "base", "snapshotDigest"], "bad-digest"), false);
    expectResult(extra(workspaceView, ["workspace", "base"], "snapshot", {}), false);
    expectResult(replace(workspaceView, ["workspace", "history", "0", "action"], { kind: "approve" }), false);
    expectResult(extra(workspaceView, ["workspace", "history", "4", "action", "proposal"], "decision", "selected"), false);
  });

  it("rejects malformed result types at every nesting level", () => {
    for (const { path, value } of nodes(workspaceView)) {
      const invalid = Array.isArray(value) ? {} : isObject(value) ? null
        : typeof value === "string" ? 1 : typeof value === "number" ? "1"
        : typeof value === "boolean" ? "false" : false;
      expectResult(replace(workspaceView, path, invalid), false);
    }
  });

  it("bounds every view array to 256 entries except the 2000-entry history", () => {
    for (const { path, value } of nodes(workspaceView)) {
      if (!Array.isArray(value)) continue;
      const limit = path.join(".") === "workspace.history" ? 2000 : 256;
      expectResult(replace(workspaceView, path, Array(limit).fill(value[0] ?? "proposal:one")), true);
      expectResult(replace(workspaceView, path, Array(limit + 1).fill(value[0] ?? "proposal:one")), false);
    }
  });

  it("enforces output modes, decisions, representations and separate non-authoritative statuses", () => {
    for (const mode of ["world", "succession-demo"]) expectResult(replace(workspaceView, ["workspace", "mode"], mode), true);
    for (const decision of ["undecided", "selected", "rejected"]) expectResult(replace(workspaceView, ["workspace", "proposals", "0", "decision"], decision), true);
    expectResult(replace(workspaceView, ["workspace", "proposals", "0", "rejectionReason"], "Try an alternative."), true);
    for (const representation of ["explicit-prose", "explicit-claims", "mixed"]) expectResult(replace(workspaceView, ["changes", "0", "representation"], representation), true);
    for (const [path, value] of [
      [["format"], "wmm.workspace-view/2"],
      [["workspace", "format"], "wmm.workspace/2"],
      [["workspace", "mode"], "demo"],
      [["workspace", "proposals", "0", "decision"], "approved"],
      [["changes", "0", "representation"], "inferred-claims"],
      [["validation", "status"], "valid"],
      [["approval"], "approved"],
      [["canon"], "changed"],
    ] as const) expectResult(replace(workspaceView, path, value), false);
  });

  it.each(errorCodes)("extends the closed error code enum with %s", (code) => {
    const response = {
      format: "wmm.response/1", apiVersion: "wmm/1", requestId: "workspace-error",
      operation: "workspace.mutate", outcome: "error", execution: "completed",
      error: { code, message: "Workspace mutation failed." }, diagnostics: [],
    };
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(validateApiContract(response).valid).toBe(true);
    expect(validateApiResponse({ ...response, error: { ...response.error, code: "UNKNOWN_WORKSPACE_ERROR" } }).valid).toBe(false);
    expect(validateApiResponse({ ...response, error: { ...response.error, principal: "host" } }).valid).toBe(false);
  });
});
