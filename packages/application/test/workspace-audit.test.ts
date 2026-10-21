import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateApiRequest, validateApiResponse, type ApiResponseV1, type WorkspaceActionV1, type WorkspaceRequestV1, type WorkspaceViewV1 } from "@wmm/wire-contracts";
import { SqliteWorkspaceStore } from "../../store-authoring-sqlite/dist/index.js";
import { executeApiRequest, operationExitCode, WorkspaceApplication } from "../src/index.js";

type MutateRequest = Extract<WorkspaceRequestV1, { operation: "workspace.mutate" }>;
type PutProposal = Extract<WorkspaceActionV1, { kind: "put-proposal" }>;
const bundlePath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const directories: string[] = [];
const stores: SqliteWorkspaceStore[] = [];

function application(): { app: WorkspaceApplication; store: SqliteWorkspaceStore } {
  const directory = mkdtempSync(join(tmpdir(), "wmm-application-workspace-audit-"));
  directories.push(directory);
  const store = new SqliteWorkspaceStore(join(directory, "authoring.sqlite"));
  stores.push(store);
  return { app: new WorkspaceApplication(store), store };
}

function send(app: WorkspaceApplication, request: WorkspaceRequestV1): ApiResponseV1 {
  expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
  const response = executeApiRequest(request, { workspaces: app });
  expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  expect(response).toMatchObject({
    requestId: request.requestId, operation: request.operation, execution: "completed", diagnostics: [],
  });
  return response;
}

function view(response: ApiResponseV1): WorkspaceViewV1 {
  expect(response.outcome, JSON.stringify(response)).toBe("success");
  if (response.outcome !== "success" || (
    response.operation !== "workspace.create" && response.operation !== "workspace.read" && response.operation !== "workspace.mutate"
  )) throw new Error("Expected a workspace result");
  expect(response.data).toMatchObject({ validation: { status: "not-run" }, approval: "unavailable", canon: "unchanged" });
  return response.data;
}

function readRequest(atVersion?: number): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `audit-read-${atVersion ?? "latest"}`, operation: "workspace.read",
    payload: { workspaceId: "audit", ...(atVersion === undefined ? {} : { atVersion }) },
  };
}

function proposal(paths: readonly string[]): PutProposal {
  return { kind: "put-proposal", proposal: {
    id: "path-review", title: "Explicit document writes", author: "Human", rationale: "Review paths against the pinned base",
    dependencies: [], exclusions: [],
    operations: paths.map((path) => ({ kind: "write-prose", path, text: "Authored draft prose", beforeSha256: null })),
  } };
}

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace audit: intra-proposal file/directory admission", () => {
  it.each([
    { label: "parent first", paths: ["prose/audit.md", "prose/audit.md/child.md"] },
    { label: "child first", paths: ["prose/audit.md/child.md", "prose/audit.md"] },
    { label: "case-folded parent first", paths: ["prose/Audit.md", "prose/AUDIT.MD/child.md"] },
    { label: "case-folded child first", paths: ["prose/AUDIT.MD/child.md", "prose/Audit.md"] },
  ])("rejects $label atomically without consuming its idempotency key", ({ paths }) => {
    const { app, store } = application();
    const initial = view(send(app, {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "audit-create", operation: "workspace.create",
      payload: { workspaceId: "audit", bundlePath, title: "Path admission", goal: "Explicit operations only", mode: "world", idempotencyKey: "create" },
    }));
    const base = store.readBase("audit");
    const request: MutateRequest = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "audit-collision", operation: "workspace.mutate",
      payload: { workspaceId: "audit", expectedVersion: 1, idempotencyKey: "retryable-collision", action: proposal(paths) },
    };
    const rejected = send(app, request);
    expect(rejected).toMatchObject({
      outcome: "error", error: { code: "INVALID_WORKSPACE_ACTION", message: expect.stringMatching(/file and directory/) },
    });
    expect(operationExitCode(request.operation, rejected)).toBe(3);
    expect(rejected).not.toHaveProperty("data");
    expect(rejected).not.toHaveProperty("resolved");
    expect(view(send(app, readRequest()))).toEqual(initial);
    expect(store.readBase("audit")).toEqual(base);
    expect(send(app, readRequest(2))).toMatchObject({ outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });

    // A sibling sharing a filename prefix is not a descendant; reuse the failed attempt's key/version.
    const action = proposal(["prose/audit.md", "prose/audit.md-notes/child.md"]);
    const corrected: MutateRequest = {
      ...request, requestId: "audit-corrected", payload: { ...request.payload, action },
    };
    const saved = view(send(app, corrected));
    expect(saved.workspace.version).toBe(2);
    expect(saved.workspace.proposals).toEqual([{ ...action.proposal, version: 1, decision: "undecided", rejectionReason: null }]);
    expect(saved.workspace.history).toEqual([{ version: 2, action }]);
    expect(saved.selection.requested).toEqual([]);
    expect(store.read("audit", 1)).toEqual(initial.workspace);
    expect(store.readBase("audit")).toEqual(base);
    expect(view(send(app, { ...corrected, requestId: "audit-corrected-replay" }))).toEqual(saved);
  });
});
