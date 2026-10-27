import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiOperationV1, ApiRequestV1, ApiResultByOperationV1, ApiSuccessResponseV1, WorkspaceEconomyReadRequest, WorkspaceEconomyView, WorkspaceRequestV1, WorkspaceViewV1 } from "../src/index.js";
import * as wire from "../src/index.js";
import { workspaceView } from "./workspace-fixtures.js";
import { workspaceEconomyResponse, workspaceEconomyView } from "./workspace-economy-fixtures.js";

const request = {
  format: "wmm.request/1", apiVersion: "wmm/1", requestId: "economy-read",
  operation: "workspace.economy.read", payload: { workspaceId: "workspace:grain", atVersion: 1 },
} as const;

describe("captured workspace economy wire contract", () => {
  it("admits the opt-in captured-base read request", () => {
    expect(wire.validateApiRequest(request)).toEqual({ valid: true, errors: [] });
    expect(wire.validateApiContract(request).valid).toBe(true);
    expect(wire.validateApiRequest({ ...request, payload: { workspaceId: "workspace:grain" } }).valid).toBe(true);
    expectTypeOf<WorkspaceEconomyReadRequest["operation"]>().toExtend<ApiOperationV1>();
    expectTypeOf<Extract<ApiRequestV1, { operation: "workspace.economy.read" }>>().toEqualTypeOf<WorkspaceEconomyReadRequest>();
    expectTypeOf<Extract<WorkspaceRequestV1, { operation: "workspace.economy.read" }>>().toEqualTypeOf<never>();
    expectTypeOf<ApiResultByOperationV1["workspace.economy.read"]>().toEqualTypeOf<WorkspaceEconomyView>();
    expectTypeOf<Extract<ApiSuccessResponseV1, { operation: "workspace.economy.read" }>["data"]>().toEqualTypeOf<WorkspaceEconomyView>();
    expectTypeOf<ApiResultByOperationV1["workspace.read"]>().toEqualTypeOf<WorkspaceViewV1>();
  });

  it("admits only a distinct explicit base-only economy result", () => {
    expect(wire.validateApiResponse(workspaceEconomyResponse()).valid).toBe(true);
    expect(wire.validateApiContract(workspaceEconomyResponse()).valid).toBe(true);
    expect(wire.validateWorkspaceEconomyView(workspaceEconomyView())).toEqual({ valid: true, errors: [] });
    expect(wire.validateApiResponse(workspaceEconomyResponse(workspaceView)).valid).toBe(false);
    expect(wire.validateApiResponse({ ...workspaceEconomyResponse(), operation: "workspace.read" }).valid).toBe(false);
    for (const patch of [{ worldBasis: "candidate" }, { selectedProposalsIncluded: true }, { candidateView: "available" }, { accounting: "complete" }, { workspaceVersion: 0 }, { extra: true }]) {
      expect(wire.validateApiResponse(workspaceEconomyResponse({ ...workspaceEconomyView(), ...patch })).valid).toBe(false);
    }
  });

  it("rejects paths, candidate controls and nonpositive or unsafe version requests", () => {
    for (const field of ["bundlePath", "path", "scope", "temporal", "candidate", "review", "principal", "approval", "force"]) {
      expect(wire.validateApiRequest({ ...request, [field]: true }).valid, field).toBe(false);
      expect(wire.validateApiRequest({ ...request, payload: { ...request.payload, [field]: true } }).valid, field).toBe(false);
    }
    for (const atVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(wire.validateApiRequest({ ...request, payload: { ...request.payload, atVersion } }).valid).toBe(false);
    }
    for (const workspaceId of ["", "a".repeat(257), "🌾".repeat(129)]) {
      expect(wire.validateApiRequest({ ...request, payload: { workspaceId } }).valid).toBe(false);
    }
  });

  it("preflights result accessors and proxies without executing them", () => {
    let calls = 0;
    const getter = Object.defineProperty(workspaceEconomyView(), "economy", { enumerable: true, get: () => { calls += 1; throw new Error("Getter ran"); } });
    const proxy = new Proxy({}, { ownKeys: () => { calls += 1; throw new Error("Proxy ran"); } });
    expect(wire.validateWorkspaceEconomyView(getter).valid).toBe(false);
    expect(wire.validateWorkspaceEconomyView(proxy).valid).toBe(false);
    expect(wire.validateApiResponse(workspaceEconomyResponse(getter)).valid).toBe(false);
    expect(calls).toBe(0);
  });
});
