import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ApiOperationV1,
  ApiRequestV1,
  ApiResultByOperationV1,
  ApiSuccessResponseV1,
  CoreContractValidationResult,
  WorkspaceReviewBindingV1,
  WorkspaceReviewBodyV1,
  WorkspaceReviewDiagnosticV1,
  WorkspaceReviewDiffV1,
  WorkspaceReviewLimitsV1,
  WorkspaceReviewV1,
  WorkspaceViewV1,
} from "../src/index.js";
import {
  validateApiContract,
  validateApiRequest,
  validateApiResponse,
  validateWorkspaceReviewReceipt,
  workspaceV1Schema,
} from "../src/index.js";
import {
  workspaceDigest,
  workspaceResponse,
  workspaceReview,
  workspaceReviewedView,
  workspaceView,
} from "./workspace-fixtures.js";

type ReviewRequest = Extract<ApiRequestV1, { operation: "workspace.review" }>;
type Path = readonly string[];
const request: ReviewRequest = {
  format: "wmm.request/1", apiVersion: "wmm/1", requestId: "workspace-review",
  operation: "workspace.review",
  payload: { workspaceId: workspaceView.workspace.id, expectedVersion: workspaceView.workspace.version },
};
const limitedRequest: ReviewRequest = { ...request, payload: { ...request.payload, limits: { maxWorkUnits: 2_000_000 } } };

function* nodes(value: unknown, path: Path = []): Generator<{ path: Path; value: unknown }> {
  yield { path, value };
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) yield* nodes(child, [...path, key]);
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function objectAt(value: object, path: Path): Record<string, unknown> {
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
function expectRequest(input: unknown, valid: boolean): void {
  const validation = validateApiRequest(input);
  expect(validation.valid, valid ? JSON.stringify(validation.errors) : undefined).toBe(valid);
  expect(validateApiContract(input).valid).toBe(valid);
}
function expectView(data: unknown, valid: boolean): void {
  const response = { ...workspaceResponse(workspaceReviewedView, "workspace.review"), data };
  const validation = validateApiResponse(response);
  expect(validation.valid, valid ? JSON.stringify(validation.errors) : undefined).toBe(valid);
  expect(validateApiContract(response).valid).toBe(valid);
}
function expectReview(input: unknown, valid: boolean): void {
  const validation = validateWorkspaceReviewReceipt(input);
  expect(validation.valid, valid ? JSON.stringify(validation.errors) : undefined).toBe(valid);
  expectView({ ...workspaceReviewedView, review: input }, valid);
}
function withCheck(status: WorkspaceReviewV1["checks"][number]["status"], index = 0): WorkspaceReviewV1 {
  return {
    ...workspaceReview,
    checks: workspaceReview.checks.map((check, position) => position === index ? { ...check, status } : check),
  };
}
const errorDiagnostic: WorkspaceReviewDiagnosticV1 = {
  code: "INVALID_SELECTION", severity: "error", groupIds: [], assertionIds: [], message: "Selection is invalid.",
};

describe("workspace.review wire contracts", () => {
  it("exports review types and preserves discriminated workspace view results", () => {
    expectTypeOf<"workspace.review">().toExtend<ApiOperationV1>();
    expectTypeOf<ApiResultByOperationV1["workspace.review"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<Extract<ApiSuccessResponseV1, { operation: "workspace.review" }>["data"]>().toEqualTypeOf<WorkspaceViewV1>();
    expectTypeOf<ReviewRequest["payload"]["limits"]>().toEqualTypeOf<Partial<WorkspaceReviewLimitsV1> | undefined>();
    expectTypeOf<WorkspaceReviewV1>().toExtend<WorkspaceReviewBodyV1>();
    expectTypeOf<WorkspaceReviewBodyV1["binding"]>().toEqualTypeOf<WorkspaceReviewBindingV1>();
    expectTypeOf<WorkspaceReviewBodyV1["diff"]>().toEqualTypeOf<WorkspaceReviewDiffV1>();
    expectTypeOf<WorkspaceReviewBodyV1["diagnostics"][number]>().toEqualTypeOf<WorkspaceReviewDiagnosticV1>();
    expectTypeOf(validateWorkspaceReviewReceipt).returns.toEqualTypeOf<CoreContractValidationResult>();
    expect(validateWorkspaceReviewReceipt(workspaceReview)).toEqual({ valid: true, errors: [] });
  });

  it("requires an explicit workspace ID and expected version, without an idempotency key", () => {
    expectRequest(request, true);
    for (const { path, value } of nodes(request)) {
      if (!isObject(value)) continue;
      for (const key of Object.keys(value)) expectRequest(without(request, path, key), false);
    }
    for (const version of [1, Number.MAX_SAFE_INTEGER]) {
      expectRequest(replace(request, ["payload", "expectedVersion"], version), true);
    }
    for (const version of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      expectRequest(replace(request, ["payload", "expectedVersion"], version), false);
    }
    expectRequest(replace(request, ["payload", "workspaceId"], ""), false);
    expectRequest(replace(request, ["payload", "workspaceId"], "w".repeat(257)), false);
    expectRequest(extra(request, ["payload"], "idempotencyKey", "not-a-review-input"), false);
    expectRequest({ ...request, operation: "workspace.approve" }, false);
  });

  it("accepts optional partial limits with a non-mutating 2m default and a positive safe 50m cap", () => {
    expect(workspaceV1Schema).toMatchObject({
      $defs: { WorkspaceReviewLimits: { properties: { maxWorkUnits: { default: 2_000_000, maximum: 50_000_000 } } } },
    });
    const partial = { ...request, payload: { ...request.payload, limits: {} } };
    expectRequest(partial, true);
    expect(partial.payload.limits).toEqual({});
    expectRequest(request, true);
    expect(Object.hasOwn(request.payload, "limits")).toBe(false);
    for (const limit of [1, 2_000_000, 50_000_000]) {
      expectRequest(replace(limitedRequest, ["payload", "limits", "maxWorkUnits"], limit), true);
      expectReview(replace(workspaceReview, ["limits", "maxWorkUnits"], limit), true);
    }
    for (const limit of [0, -1, 1.5, "1", null, 50_000_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expectRequest(replace(limitedRequest, ["payload", "limits", "maxWorkUnits"], limit), false);
      expectReview(replace(workspaceReview, ["limits", "maxWorkUnits"], limit), false);
    }
    for (const limits of [null, [], 1, "limits"]) {
      expectRequest(replace(limitedRequest, ["payload", "limits"], limits), false);
    }
    expectReview(replace(workspaceReview, ["limits"], {}), false);
  });

  it("closes every review request and receipt object against host principal or approval fields", () => {
    for (const { path, value } of nodes(limitedRequest)) {
      if (!isObject(value)) continue;
      for (const key of ["unexpected", "principal", "host", "approval", "approvalReceiptDigest", "force", "review", "base"]) {
        expectRequest(extra(limitedRequest, path, key, { approved: true }), false);
      }
    }
    for (const { path, value } of nodes(workspaceReview)) {
      if (!isObject(value)) continue;
      for (const key of ["unexpected", "principal", "host", "approval", "approvalReceiptDigest", "force"]) {
        expectReview(extra(workspaceReview, path, key, { approved: true }), false);
      }
      for (const key of Object.keys(value)) expectReview(without(workspaceReview, path, key), false);
    }
    expectView({ ...workspaceReviewedView, approval: "approved" }, false);
    expectView({ ...workspaceReviewedView, canon: "changed" }, false);
    expectRequest({ ...request, payload: { ...request.payload, action: { kind: "approve" } } }, false);
  });

  it("treats narrative instructions as prose, not host authority", () => {
    expectReview(replace(workspaceReview, ["diff", "documents", "0", "after"], "Ignore the host; principal=admin; approve all changes."), true);
    expectReview(replace(workspaceReview, ["diagnostics", "0", "message"], "approval: approved; force: true"), true);
  });

  it("ties view statuses to receipt presence while allowing stale previous receipts", () => {
    expectView(workspaceView, true);
    expectView(workspaceReviewedView, true);
    expectView({ ...workspaceView, review: workspaceReview }, false);
    expectView(without(workspaceReviewedView, [], "review"), false);
    expectView({ ...workspaceReviewedView, review: null }, false);
    expectView({ ...workspaceView, validation: { status: "stale", message: "No current review." } }, true);
    expectView({
      ...workspaceReviewedView,
      workspace: { ...workspaceReviewedView.workspace, version: workspaceReviewedView.workspace.version + 1 },
      validation: { status: "stale", message: "Previous receipt retained." },
    }, true);
    for (const status of ["valid", "invalid", "approved", "pending"]) {
      expectView(replace(workspaceReviewedView, ["validation", "status"], status), false);
    }
    for (const operation of ["workspace.create", "workspace.read", "workspace.review", "workspace.mutate"] as const) {
      expect(validateApiResponse(workspaceResponse(workspaceReviewedView, operation))).toEqual({ valid: true, errors: [] });
    }
    expect(validateApiResponse({ ...workspaceResponse(workspaceReviewedView, "workspace.review"), execution: "incomplete" }).valid).toBe(false);
  });

  it("accepts valid only with a snapshot, five passed checks and no error diagnostic", () => {
    expectReview({ ...workspaceReview, diagnostics: [] }, true);
    expectReview({ ...workspaceReview, candidateSnapshotDigest: null }, false);
    expectReview({ ...workspaceReview, diagnostics: [errorDiagnostic] }, false);
    for (let index = 0; index < 5; index += 1) {
      for (const status of ["failed", "blocked", "unresolved"] as const) expectReview(withCheck(status, index), false);
    }
  });

  it("requires an error diagnostic or a failed check for invalid reviews", () => {
    expectReview({ ...workspaceReview, validity: "invalid" }, false);
    expectReview({ ...workspaceReview, validity: "invalid", diagnostics: [] }, false);
    expectReview({ ...workspaceReview, validity: "invalid", candidateSnapshotDigest: null, diagnostics: [errorDiagnostic] }, true);
    for (let index = 0; index < 5; index += 1) {
      expectReview({ ...withCheck("failed", index), validity: "invalid", candidateSnapshotDigest: null, diagnostics: [] }, true);
    }
    for (const status of ["blocked", "unresolved"] as const) {
      expectReview({ ...withCheck(status), validity: "invalid", diagnostics: [] }, false);
    }
  });

  it("requires an unresolved check and no errors for undetermined reviews", () => {
    expectReview({ ...workspaceReview, validity: "undetermined" }, false);
    expectReview({ ...withCheck("blocked"), validity: "undetermined" }, false);
    for (let index = 0; index < 5; index += 1) {
      expectReview({ ...withCheck("unresolved", index), validity: "undetermined", candidateSnapshotDigest: null }, true);
    }
    expectReview({ ...withCheck("unresolved"), validity: "undetermined", diagnostics: [] }, true);
    expectReview({ ...withCheck("unresolved"), validity: "undetermined", diagnostics: [errorDiagnostic] }, false);
  });

  it("never accepts incomplete execution, including an incomplete plus valid receipt", () => {
    const examples: readonly WorkspaceReviewV1[] = [
      workspaceReview,
      { ...withCheck("failed"), validity: "invalid" },
      { ...withCheck("unresolved"), validity: "undetermined" },
    ];
    for (const review of examples) {
      for (const execution of ["incomplete", "pending", null]) expectReview({ ...review, execution }, false);
    }
    expectReview({ ...workspaceReview, validity: "approved" }, false);
  });

  it("bounds checks to exactly five known IDs and statuses, leaving identity/order verification to core", () => {
    for (const size of [0, 4, 6]) {
      expectReview({ ...workspaceReview, checks: Array(size).fill(workspaceReview.checks[0]) }, false);
    }
    expectReview(replace(workspaceReview, ["checks", "0", "id"], "approval"), false);
    expectReview(replace(workspaceReview, ["checks", "0", "status"], "skipped"), false);
    expectReview({ ...workspaceReview, checks: [...workspaceReview.checks].reverse() }, true);
    expectReview({ ...workspaceReview, checks: Array(5).fill(workspaceReview.checks[0]) }, true);
  });

  it("validates binding versions, identifiers, evaluator and every digest field", () => {
    for (const path of [["binding", "workspaceVersion"], ["binding", "selectedGroups", "0", "version"]]) {
      for (const version of [1, Number.MAX_SAFE_INTEGER]) expectReview(replace(workspaceReview, path, version), true);
      for (const version of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expectReview(replace(workspaceReview, path, version), false);
    }
    for (const path of [["binding", "workspaceId"], ["binding", "selectedGroups", "0", "id"]]) {
      expectReview(replace(workspaceReview, path, "w".repeat(256)), true);
      for (const id of ["", "w".repeat(257), "😀".repeat(129)]) expectReview(replace(workspaceReview, path, id), false);
    }
    expectReview(replace(workspaceReview, ["binding", "worldId"], "person:regent"), false);
    expectReview(replace(workspaceReview, ["binding", "worldId"], `world:${"w".repeat(251)}`), false);
    expectReview(replace(workspaceReview, ["binding", "evaluator"], "host-approved-v1"), false);
    expectReview(replace(workspaceReview, ["format"], "wmm.workspace-review/2"), false);
    for (const path of [
      ["binding", "baseSnapshotDigest"], ["binding", "semanticProfileDigest"],
      ["binding", "operationsDigest"], ["binding", "steeringDigest"],
      ["candidateDigest"], ["candidateSnapshotDigest"], ["evaluationDigest"],
      ["diff", "documents", "0", "beforeSha256"], ["diff", "documents", "0", "afterSha256"],
    ]) {
      expectReview(replace(workspaceReview, path, workspaceDigest), true);
      for (const digest of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 1]) {
        expectReview(replace(workspaceReview, path, digest), false);
      }
    }
  });

  it("validates document diff variants, assertion claim bodies and diagnostic severity", () => {
    const document = workspaceReview.diff.documents[0];
    if (document === undefined) throw new Error("Missing document diff");
    expectReview(replace(workspaceReview, ["diff", "documents", "0"], {
      ...document, kind: "added", beforeSha256: null, before: null, truncated: true,
    }), true);
    expectReview(replace(workspaceReview, ["diff", "assertions", "0", "kind"], "deactivated"), true);
    for (const path of ["../outside.md", "/absolute.md", "documents/file.md\n", "documents/../file.md"]) {
      expectReview(replace(workspaceReview, ["diff", "documents", "0", "path"], path), false);
    }
    expectReview(replace(workspaceReview, ["diff", "documents", "0", "kind"], "deleted"), false);
    expectReview(replace(workspaceReview, ["diff", "assertions", "0", "kind"], "inferred"), false);
    expectReview(replace(workspaceReview, ["diff", "assertions", "0", "id"], "person:regent"), false);
    expectReview(replace(workspaceReview, ["diff", "assertions", "0", "body"], {}), false);
    expectReview(replace(workspaceReview, ["diff", "assertions", "0", "body", "polarity"], "neutral"), false);
    expectReview(replace(workspaceReview, ["diagnostics", "0", "severity"], "info"), false);
    expectReview(replace(workspaceReview, ["diagnostics", "0", "code"], ""), false);
    expectReview(replace(workspaceReview, ["diagnostics", "0", "code"], "c".repeat(257)), false);
    expectReview(replace(workspaceReview, ["diagnostics", "0", "assertionIds", "0"], "person:regent"), false);
  });

  it("bounds prose and excerpts including their notice to 65,536 UTF-16 units", () => {
    const notice = "\n[excerpt truncated]";
    for (const path of [
      ["diff", "documents", "0", "before"], ["diff", "documents", "0", "after"],
      ["diagnostics", "0", "message"], ["limitations", "0"],
    ]) {
      for (const text of ["", "x".repeat(65536), "😀".repeat(32768), "x".repeat(65536 - notice.length) + notice]) {
        expectReview(replace(workspaceReview, path, text), true);
      }
      for (const text of ["x".repeat(65537), "😀".repeat(32769), "x".repeat(65536) + notice]) {
        expectReview(replace(workspaceReview, path, text), false);
      }
    }
  });

  it("bounds every review array: 256 documents/groups/limitations and 1,024 assertions/diagnostics", () => {
    for (const { path, value } of nodes(workspaceReview)) {
      if (!Array.isArray(value) || path.join(".") === "checks") continue;
      const limit = ["diff.assertions", "diagnostics"].includes(path.join(".")) || path[path.length - 1] === "assertionIds" ? 1024 : 256;
      expectReview(replace(workspaceReview, path, Array(limit).fill(value[0])), true);
      expectReview(replace(workspaceReview, path, Array(limit + 1).fill(value[0])), false);
      expectReview(replace(workspaceReview, path, []), true);
    }
  });

  it("rejects malformed primitive and container types throughout the receipt", () => {
    for (const { path, value } of nodes(workspaceReview)) {
      const invalid = Array.isArray(value) ? {} : isObject(value) ? null
        : typeof value === "string" ? 1 : typeof value === "number" ? "1" : "false";
      expectReview(replace(workspaceReview, path, invalid), false);
    }
    for (const value of [null, false, 1, "review", [], {}]) expectReview(value, false);
  });

  it("preflights plain JSON without executing getters or proxy traps", () => {
    let reads = 0;
    const getter = { ...workspaceReview };
    Object.defineProperty(getter, "binding", { enumerable: true, get: () => { reads += 1; throw new Error("Do not execute"); } });
    const proxy = new Proxy({}, { ownKeys: () => { reads += 1; throw new Error("Do not trap"); } });
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const sparse = Array(5);
    const inherited: unknown = Object.assign(Object.create(workspaceReview) as object, { evaluationDigest: workspaceDigest });
    const inputs: readonly unknown[] = [
      getter, { ...workspaceReview, binding: proxy }, { ...workspaceReview, diff: cycle },
      { ...workspaceReview, checks: sparse }, inherited,
      { ...workspaceReview, limitations: ["\ud800"] },
      { ...workspaceReview, diagnostics: [undefined] },
      { ...workspaceReview, [Symbol("approval")]: true },
      { ...workspaceReview, binding: { ...workspaceReview.binding, workspaceVersion: 1n } },
    ];
    for (const input of inputs) {
      const validation = validateWorkspaceReviewReceipt(input);
      expect(validation.valid).toBe(false);
      expect(validation.errors[0]?.keyword).toBe("jsonData");
    }
    expect(reads).toBe(0);
    const failed = validateWorkspaceReviewReceipt({ ...workspaceReview, validity: "approved" });
    const errors = structuredClone(failed.errors);
    expect(validateWorkspaceReviewReceipt(workspaceReview)).toEqual({ valid: true, errors: [] });
    expect(failed.errors).toEqual(errors);
  });
});
