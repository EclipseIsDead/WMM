import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertionId, canonicalJsonBytes, sha256Hex, snapshotDigest, workspaceCandidateDigest, workspaceReviewDigest,
} from "@wmm/canonical";
import { reviewWorkspace } from "@wmm/core";
import { WorkspaceStoreError, type WorkspaceStore } from "@wmm/ports";
import {
  validateApiRequest, validateApiResponse, validateWorkspaceReviewReceipt, validateWorldRecord,
  type ApiErrorCodeV1, type ApiResponseV1, type AssertionRecordV1, type ClaimBodyV1, type JsonValue,
  type SnapshotRecordV1, type WorkspaceActionV1, type WorkspaceOperationV1, type WorkspaceRequestV1,
  type WorkspaceReviewBindingV1, type WorkspaceReviewLimitsV1, type WorkspaceReviewV1, type WorkspaceViewV1,
} from "@wmm/wire-contracts";
import { SqliteWorkspaceStore } from "../../store-authoring-sqlite/dist/index.js";
import { executeApiRequest, operationExitCode, WorkspaceApplication } from "../src/index.js";

type CreateRequest = Extract<WorkspaceRequestV1, { operation: "workspace.create" }>;
type MutateRequest = Extract<WorkspaceRequestV1, { operation: "workspace.mutate" }>;
type ReviewRequest = Extract<WorkspaceRequestV1, { operation: "workspace.review" }>;
type ProposalInput = Extract<WorkspaceActionV1, { kind: "put-proposal" }>["proposal"];
const bundlePath = fileURLToPath(new URL("../../../fixtures/v3/succession-world/", import.meta.url));
const directories: string[] = [];
const stores: SqliteWorkspaceStore[] = [];
let sourceBefore: Record<string, string>;

function treeHashes(root: string, relative = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, treeHashes(root, path));
    else if (entry.isFile()) files[path] = sha256Hex(readFileSync(join(root, path)));
    else throw new Error(`Unexpected fixture entry: ${path}`);
  }
  return files;
}
function open(databasePath?: string) {
  if (databasePath === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "wmm-application-review-"));
    directories.push(directory);
    databasePath = join(directory, "authoring.sqlite");
  }
  const store = new SqliteWorkspaceStore(databasePath);
  stores.push(store);
  return { databasePath, store, app: new WorkspaceApplication(store) };
}
// Delegate every port method with its real receiver, including the adapter's private fields.
function wrappedStore(store: WorkspaceStore, overrides: Partial<WorkspaceStore>): WorkspaceStore {
  return {
    create: store.create.bind(store), read: store.read.bind(store), readBase: store.readBase.bind(store),
    mutate: store.mutate.bind(store), putReview: store.putReview.bind(store), readReview: store.readReview.bind(store),
    readOutcomeReview: store.readOutcomeReview.bind(store), close: store.close.bind(store), ...overrides,
  };
}
function createRequest(): CreateRequest {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: "review-create-中立", operation: "workspace.create",
    payload: { workspaceId: "succession", bundlePath, title: "The succession crisis", goal: "Review explicit alternatives without changing canon.", mode: "succession-demo", idempotencyKey: "create" },
  };
}
function readRequest(atVersion?: number): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `review-read-${atVersion ?? "latest"}`, operation: "workspace.read",
    payload: { workspaceId: "succession", ...(atVersion === undefined ? {} : { atVersion }) },
  };
}
function mutation(current: WorkspaceViewV1, action: WorkspaceActionV1, key = `mutation-${current.workspace.version}`): MutateRequest {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `review-${key}`, operation: "workspace.mutate",
    payload: { workspaceId: current.workspace.id, expectedVersion: current.workspace.version, idempotencyKey: key, action },
  };
}
function reviewRequest(current: WorkspaceViewV1, limits?: Partial<WorkspaceReviewLimitsV1>): ReviewRequest {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `review-v${current.workspace.version}-👑`, operation: "workspace.review",
    payload: { workspaceId: current.workspace.id, expectedVersion: current.workspace.version, ...(limits === undefined ? {} : { limits }) },
  };
}
function send(app: WorkspaceApplication, request: WorkspaceRequestV1): ApiResponseV1 {
  expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
  const response = executeApiRequest(JSON.parse(JSON.stringify(request)), { workspaces: app });
  expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  expect(response).toMatchObject({ format: "wmm.response/1", apiVersion: "wmm/1", requestId: request.requestId, operation: request.operation, diagnostics: [] });
  return response;
}
function success(app: WorkspaceApplication, request: WorkspaceRequestV1): WorkspaceViewV1 {
  const response = send(app, request);
  expect(response.outcome, JSON.stringify(response)).toBe("success");
  if (response.outcome !== "success" || !(
    response.operation === "workspace.create" || response.operation === "workspace.read" ||
    response.operation === "workspace.mutate" || response.operation === "workspace.review"
  )) throw new Error("Expected a workspace view");
  expect(response.execution).toBe("completed");
  expect(response.resolved).toEqual(response.data.workspace.base);
  expect(response.data).toMatchObject({ format: "wmm.workspace-view/1", approval: "unavailable", canon: "unchanged" });
  expect(operationExitCode(request.operation, response)).toBe(0);
  return response.data;
}
function failure(app: WorkspaceApplication, request: WorkspaceRequestV1, code: ApiErrorCodeV1, exitCode = 3): ApiResponseV1 {
  const response = send(app, request);
  expect(response).toMatchObject({ outcome: "error", execution: code === "BUDGET_EXCEEDED" ? "incomplete" : "completed", error: { code } });
  expect(response).not.toHaveProperty("data");
  expect(response).not.toHaveProperty("resolved");
  expect(operationExitCode(request.operation, response)).toBe(exitCode);
  return response;
}
function mutate(app: WorkspaceApplication, current: WorkspaceViewV1, action: WorkspaceActionV1): WorkspaceViewV1 {
  return success(app, mutation(current, action));
}
function selected(app: WorkspaceApplication): WorkspaceViewV1 {
  return mutate(app, success(app, createRequest()), { kind: "select", groupIds: ["death", "council"] });
}
function receipt(view: WorkspaceViewV1): WorkspaceReviewV1 {
  expect(view.validation.status).toBe("current");
  if (view.review === undefined) throw new Error("Missing review receipt");
  expect(validateWorkspaceReviewReceipt(view.review)).toEqual({ valid: true, errors: [] });
  const { evaluationDigest, ...body } = view.review;
  expect(evaluationDigest).toBe(workspaceReviewDigest(body));
  expect(view.review.candidateDigest).toBe(workspaceCandidateDigest(view.review.binding));
  return view.review;
}
function put(id: string, operations: readonly WorkspaceOperationV1[], extra: Partial<ProposalInput> = {}): WorkspaceActionV1 {
  return { kind: "put-proposal", proposal: { id, title: id, author: "Human", rationale: "Explicit authored operations.", dependencies: [], exclusions: [], operations, ...extra } };
}
function rehash(review: WorkspaceReviewV1): WorkspaceReviewV1 {
  const { evaluationDigest: _old, ...body } = review;
  return { ...body, evaluationDigest: workspaceReviewDigest(body) };
}
function noNextVersion(app: WorkspaceApplication, current: WorkspaceViewV1): void {
  failure(app, readRequest(current.workspace.version + 1), "WORKSPACE_NOT_FOUND");
}

beforeEach(() => { sourceBefore = treeHashes(bundlePath); });
afterEach(() => {
  try { expect(treeHashes(bundlePath)).toEqual(sourceBefore); }
  finally {
    vi.restoreAllMocks();
    for (const store of stores.splice(0).reverse()) store.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace.review application boundary", () => {
  it("reviews the fixed v3 demo as exactly three authored documents without advancing semantic state or touching sources", () => {
    const { app, store } = open();
    const initial = success(app, createRequest());
    const snapshot = JSON.parse(readFileSync(join(bundlePath, "snapshot.json"), "utf8")) as SnapshotRecordV1;
    const base = store.readBase("succession");
    expect(base.snapshot).toEqual(snapshot);
    expect(snapshot.manifest.files).toHaveLength(47);
    expect(initial.workspace).toMatchObject({ version: 1, history: [], base: { snapshotDigest: snapshot.snapshotDigest } });
    expect(initial.validation.status).toBe("not-run");
    expect(initial).not.toHaveProperty("review");
    const title = "Negotiate a regency";
    const rationale = "Preserve the dynasty through an explicitly authored diplomatic settlement.";
    const actions: readonly WorkspaceActionV1[] = [
      { kind: "select", groupIds: ["death", "council"] },
      { kind: "decide", groupId: "coup", decision: "rejected", reason: "Prefer diplomacy." },
      { kind: "decide", groupId: "intervention", decision: "rejected", reason: "Keep the neighbor neutral." },
      { kind: "add-regency", title, rationale },
      { kind: "select", groupIds: ["death", "council", "regency"] },
      { kind: "set-direction", text: "Keep the existing dynasty. Do not infer eligible heirs." },
    ];
    let current = initial;
    for (const action of actions) current = mutate(app, current, action);
    const stateBefore = structuredClone(current.workspace);
    const reviewed = success(app, reviewRequest(current));
    const review = receipt(reviewed);
    expect(review).toMatchObject({ execution: "completed", validity: "valid", limits: { maxWorkUnits: 2_000_000 }, diagnostics: [] });
    expect(review.checks).toEqual(["selection", "operations", "references", "pins", "explicit-opposition"].map(id => ({ id, status: "passed" })));
    expect(review.binding).toMatchObject({
      worldId: stateBefore.base.worldId, workspaceId: "succession", workspaceVersion: 7,
      baseSnapshotDigest: snapshot.snapshotDigest, semanticProfileDigest: base.world.world.semanticProfileDigest,
      evaluator: "bundled-workspace-review-v1", selectedGroups: [{ id: "council", version: 1 }, { id: "death", version: 1 }, { id: "regency", version: 1 }],
    });
    // This oracle is authored independently of both proposal traversal and evaluator output.
    const expectedDocuments = [
      { path: "prose/developments/council.md", groupId: "council", text: "# Interim council\n\nThe existing council temporarily administers Valen after Edric's death.\n" },
      { path: "prose/developments/death.md", groupId: "death", text: "# King Edric's death\n\nProposed authorial account: King Edric dies in 1172. No conclusion about eligible heirs is inferred.\n" },
      { path: "prose/developments/regency.md", groupId: "regency", text: `# ${title}\n\n${rationale}\n` },
    ];
    expect(review.diff).toEqual({ documents: expectedDocuments.map(({ path, groupId, text }) => ({
      path, kind: "added", beforeSha256: null, afterSha256: sha256Hex(Buffer.from(text)), before: null, after: text, truncated: false, groupIds: [groupId],
    })), assertions: [] });
    const worldBytes = canonicalJsonBytes(base.world.world as unknown as JsonValue);
    const expectedManifest = { ...snapshot.manifest, files: [
      ...snapshot.manifest.files.filter(entry => entry.path !== "world.json"),
      { path: "world.json", mediaType: "application/json" as const, byteLength: String(worldBytes.length), sha256: sha256Hex(worldBytes) },
      ...expectedDocuments.map(({ path, text }) => ({ path, mediaType: "text/markdown" as const, byteLength: String(Buffer.byteLength(text)), sha256: sha256Hex(Buffer.from(text)) })),
    ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const { candidate } = reviewWorkspace(stateBefore, base);
    if (candidate === null) throw new Error("Expected a compiled candidate");
    expect(candidate.snapshot.manifest).toEqual(expectedManifest);
    expect(candidate.snapshot.snapshotDigest).toBe(snapshotDigest(expectedManifest));
    expect(review.candidateSnapshotDigest).toBe(candidate.snapshot.snapshotDigest);
    expect(review.candidateSnapshotDigest).not.toBe(snapshot.snapshotDigest);
    expect(candidate.world.snapshotDigest).toBe(review.candidateSnapshotDigest);
    expect(validateWorldRecord(candidate.snapshot)).toEqual({ valid: true, errors: [] });
    expect(candidate.world.assertions).toEqual(base.world.assertions);
    expect(candidate.world.sources).toEqual(base.world.sources);
    expect(candidate.world.supports).toEqual(base.world.supports);
    expect(reviewed.workspace).toEqual(stateBefore);
    expect(reviewed.documents).toEqual(initial.documents);
    expect(store.read("succession")).toEqual(stateBefore);
    expect(store.readBase("succession")).toEqual(base);
    expect(store.readReview("succession", 7)).toEqual(review);
    expect(success(app, readRequest())).toEqual(reviewed);
    expect(success(app, reviewRequest(current, {}))).toEqual(reviewed);
    noNextVersion(app, reviewed);
  });

  it("freezes absent and stale review associations on idempotent mutation/create replay, while reads use the latest receipt after restart", () => {
    const first = open();
    const create = createRequest();
    const initial = success(first.app, create);
    const m0 = mutation(initial, { kind: "select", groupIds: ["death", "council"] }, "no-review-yet");
    const originalM0 = success(first.app, m0);
    expect(originalM0.validation.status).toBe("not-run");
    expect(originalM0).not.toHaveProperty("review");
    const r1View = success(first.app, reviewRequest(originalM0));
    const r1 = receipt(r1View);
    expect(success(first.app, { ...m0, requestId: "retry-with-new-correlation" })).toEqual(originalM0);
    const m1 = mutation(r1View, { kind: "set-direction", text: "Keep diplomacy advisory." }, "associated-r1");
    const originalM1 = success(first.app, m1);
    expect(originalM1.validation.status).toBe("stale");
    expect(originalM1.review).toEqual(r1);
    const r2View = success(first.app, reviewRequest(originalM1, { maxWorkUnits: 3_000_000 }));
    const r2 = receipt(r2View);
    expect(r2.evaluationDigest).not.toBe(r1.evaluationDigest);
    expect(r2.binding.steeringDigest).not.toBe(r1.binding.steeringDigest);
    expect(r2.binding.operationsDigest).toBe(r1.binding.operationsDigest);
    first.store.close();
    const reopened = open(first.databasePath);
    expect(success(reopened.app, { ...m0, requestId: "reopened-retry-m0" })).toEqual(originalM0);
    expect(success(reopened.app, { ...m1, requestId: "reopened-retry-m1" })).toEqual(originalM1);
    expect(reopened.store.readOutcomeReview("succession", m0.payload.idempotencyKey)).toBeUndefined();
    expect(reopened.store.readOutcomeReview("succession", m1.payload.idempotencyKey)).toEqual(r1);
    expect(success(reopened.app, { ...create, requestId: "reopened-create-replay" })).toEqual(initial);
    expect(success(reopened.app, readRequest(2))).toEqual(r1View);
    expect(success(reopened.app, readRequest(3))).toEqual(r2View);
    expect(success(reopened.app, readRequest())).toEqual(r2View);
    failure(reopened.app, { ...m1, requestId: "changed-intent", payload: { ...m1.payload, action: { kind: "set-direction", text: "Different intent" } } }, "IDEMPOTENCY_CONFLICT");
    expect(success(reopened.app, readRequest())).toEqual(r2View);
    noNextVersion(reopened.app, r2View);
  });

  it.each([
    ["missing prerequisite", "MISSING_PREREQUISITE", "selection"],
    ["excluded alternatives", "INCOMPATIBLE_ALTERNATIVES", "selection"],
    ["protected document change", "PIN_CHANGED", "pins"],
    ["conflicting writes", "CONFLICTING_WRITES", "operations"],
  ] as const)("persists a completed invalid review for %s, not an execution failure or semantic version", (scenario, code, check) => {
    const { app, store, databasePath } = open();
    let current = success(app, createRequest());
    if (scenario === "missing prerequisite") current = mutate(app, current, { kind: "select", groupIds: ["council"] });
    if (scenario === "excluded alternatives") {
      current = mutate(app, current, { kind: "add-regency", title: "Regency", rationale: "An alternative to the coup." });
      current = mutate(app, current, { kind: "select", groupIds: ["death", "council", "regency", "coup"] });
    }
    if (scenario === "protected document change") current = mutate(app, current, { kind: "select", groupIds: ["death", "intervention"] });
    if (scenario === "conflicting writes") {
      for (const id of ["a", "b"]) current = mutate(app, current, put(id, [{ kind: "write-prose", path: "prose/shared.md", beforeSha256: null, text: id }]));
      current = mutate(app, current, { kind: "select", groupIds: ["a", "b"] });
    }
    const base = store.readBase("succession");
    const reviewed = success(app, reviewRequest(current));
    const review = receipt(reviewed);
    expect(review.validity).toBe("invalid");
    expect(review.checks).toContainEqual({ id: check, status: "failed" });
    expect(review.diagnostics).toContainEqual(expect.objectContaining({ code, severity: "error" }));
    expect(reviewed.workspace).toEqual(current.workspace);
    expect(store.readBase("succession")).toEqual(base);
    store.close();
    const reopened = open(databasePath);
    expect(success(reopened.app, readRequest(current.workspace.version))).toEqual(reviewed);
    expect(reopened.store.readReview("succession")).toEqual(review);
    noNextVersion(reopened.app, reviewed);
  });

  it.each(["scope", "interval"] as const)("returns completed undetermined for explicit opposite claims with uncertain %s", (uncertainty) => {
    const { app, store } = open();
    let current = success(app, createRequest());
    const base = store.readBase("succession");
    const axis = base.world.definitions.find(entry => entry.body.key === "days")!.digest;
    const predicate = base.world.definitions.find(entry => entry.body.key === "allied_with")!.digest;
    const body: ClaimBodyV1 = {
      format: "wmm.claim/1", worldId: base.world.world.worldId, semanticProfileDigest: base.world.world.semanticProfileDigest,
      proposition: { kind: "atom", subjectId: "person:bran", predicateDefinitionDigest: predicate, value: { kind: "ref", id: "person:alys" } },
      polarity: "positive", scope: { account: { kind: "ref", id: "account:canonical" }, jurisdiction: { kind: "ref", id: "polity:valen" }, recognitionFrame: { kind: "ref", id: "frame:royal-court" } },
      applicability: { kind: "interval", axisDefinitionDigest: axis, start: { kind: "exact", position: "10" }, endExclusive: { kind: "exact", position: "20" } },
    };
    const opposite: ClaimBodyV1 = { ...body, polarity: "negative", ...(uncertainty === "scope"
      ? { scope: { ...body.scope, jurisdiction: { kind: "unresolved" } } }
      : { applicability: { kind: "interval", axisDefinitionDigest: axis, start: { kind: "boundedUnknown", lowerInclusive: "19", upperExclusive: "22" }, endExclusive: { kind: "exact", position: "30" } } }) };
    const assertions: AssertionRecordV1[] = [body, opposite].map(body => ({ format: "wmm.assertion-record/1", id: assertionId(body), body }));
    current = mutate(app, current, put("opposite-claims", assertions.map(assertion => ({ kind: "activate-assertion", assertion }))));
    current = mutate(app, current, { kind: "select", groupIds: ["opposite-claims"] });
    const reviewed = success(app, reviewRequest(current));
    const review = receipt(reviewed);
    expect(review).toMatchObject({ execution: "completed", validity: "undetermined" });
    expect(review.candidateSnapshotDigest).not.toBeNull();
    expect(review.checks).toContainEqual({ id: "explicit-opposition", status: "unresolved" });
    expect(review.diagnostics).toContainEqual({
      code: "OPPOSITION_UNRESOLVED", severity: "warning", groupIds: ["opposite-claims"], assertionIds: assertions.map(a => a.id).sort(),
      message: expect.stringContaining(uncertainty === "scope" ? "unresolved-scope" : "uncertain-applicability"),
    });
    expect(review.diagnostics.every(item => item.severity === "warning")).toBe(true);
    expect(review.diff.assertions).toEqual([...assertions].sort((a, b) => a.id.localeCompare(b.id)).map(assertion => ({ id: assertion.id, kind: "activated", body: assertion.body, groupIds: ["opposite-claims"] })));
    expect(reviewed.workspace).toEqual(current.workspace);
    expect(store.readReview("succession")).toEqual(review);
    expect(store.readBase("succession")).toEqual(base);
    noNextVersion(app, reviewed);
  });

  it("rejects a stale expected version before computing or persisting a receipt", () => {
    const { app, store } = open();
    const initial = success(app, createRequest());
    const current = mutate(app, initial, { kind: "select", groupIds: ["death", "council"] });
    const putReview = vi.spyOn(store, "putReview");
    failure(app, reviewRequest(initial), "STALE_WORKSPACE");
    expect(putReview).not.toHaveBeenCalled();
    expect(store.readReview("succession")).toBeUndefined();
    expect(success(app, readRequest())).toEqual(current);
    noNextVersion(app, current);
  });

  it("rejects the save-time race after computation rather than returning a current receipt for an older version", () => {
    const { app, store, databasePath } = open();
    const current = selected(app);
    let concurrent: WorkspaceViewV1 | undefined;
    const putReview = vi.fn<WorkspaceStore["putReview"]>((id, version, review) => {
      expect(review).toMatchObject({ execution: "completed", validity: "valid", binding: { workspaceVersion: version } });
      expect(store.readReview(id)).toBeUndefined();
      concurrent = mutate(app, current, { kind: "set-direction", text: "Concurrent author decision." });
      store.putReview(id, version, review);
    });
    const racingApp = new WorkspaceApplication(wrappedStore(store, { putReview }));
    failure(racingApp, reviewRequest(current), "STALE_WORKSPACE");
    expect(putReview).toHaveBeenCalledTimes(1);
    expect(concurrent).toBeDefined();
    expect(store.readReview("succession")).toBeUndefined();
    store.close();
    const reopened = open(databasePath);
    expect(success(reopened.app, readRequest())).toEqual(concurrent);
    expect(reopened.store.readReview("succession", current.workspace.version)).toBeUndefined();
    if (concurrent === undefined) throw new Error("Concurrent mutation was not injected");
    noNextVersion(reopened.app, concurrent);
  });

  it.each([false, true])("does not report green or advance a durable version when receipt persistence fails (prior receipt=%s)", (prior) => {
    const { app, store, databasePath } = open();
    let current = selected(app);
    if (prior) current = mutate(app, success(app, reviewRequest(current)), { kind: "set-direction", text: "Review this new direction." });
    const previousReceipt = store.readReview("succession");
    const putReview = vi.fn<WorkspaceStore["putReview"]>(() => { throw new WorkspaceStoreError("STORAGE_FAILURE", "Injected review save failure"); });
    const failingApp = new WorkspaceApplication(wrappedStore(store, { putReview }));
    failure(failingApp, reviewRequest(current), "STORAGE_FAILURE", 4);
    expect(putReview).toHaveBeenCalledTimes(1);
    expect(store.readReview("succession")).toEqual(previousReceipt);
    store.close();
    const reopened = open(databasePath);
    expect(success(reopened.app, readRequest())).toEqual(current);
    expect(reopened.store.readReview("succession", current.workspace.version)).toBeUndefined();
    expect(current.validation.status).toBe(prior ? "stale" : "not-run");
    noNextVersion(reopened.app, current);
  });

  it("returns BUDGET_EXCEEDED/incomplete with no receipt or semantic version for maxWorkUnits=1", () => {
    const { app, store, databasePath } = open();
    const current = selected(app);
    const putReview = vi.spyOn(store, "putReview");
    failure(app, reviewRequest(current, { maxWorkUnits: 1 }), "BUDGET_EXCEEDED", 4);
    expect(putReview).not.toHaveBeenCalled();
    expect(store.readReview("succession")).toBeUndefined();
    store.close();
    const reopened = open(databasePath);
    expect(success(reopened.app, readRequest())).toEqual(current);
    expect(reopened.store.readReview("succession")).toBeUndefined();
    noNextVersion(reopened.app, current);
  });

  it("checks stored receipt shape and SHA integrity before binding it, even if malformed data is rehashed", () => {
    const { app, store } = open();
    const current = selected(app);
    const reviewed = success(app, reviewRequest(current));
    const review = receipt(reviewed);
    const malformed = rehash({ ...review, checks: [] });
    expect(validateWorkspaceReviewReceipt(malformed).valid).toBe(false);
    for (const stored of [{ ...review, evaluationDigest: "0".repeat(64) }, malformed]) {
      const reader = new WorkspaceApplication(wrappedStore(store, { readReview: () => stored }));
      const rejected = success(reader, readRequest());
      expect(rejected.validation.status).toBe("stale");
      expect(rejected).not.toHaveProperty("review");
      expect(rejected.workspace).toEqual(current.workspace);
    }
    const mismatches: readonly Partial<WorkspaceReviewBindingV1>[] = [
      { workspaceId: "other" }, { workspaceVersion: current.workspace.version + 1 }, { worldId: "world:other" },
      { baseSnapshotDigest: "0".repeat(64) }, { semanticProfileDigest: "0".repeat(64) },
      { selectedGroups: [{ id: "death", version: 2 }] }, { operationsDigest: "0".repeat(64) }, { steeringDigest: "0".repeat(64) },
    ];
    for (const mismatch of mismatches) {
      const binding = { ...review.binding, ...mismatch };
      const stored = rehash({ ...review, binding, candidateDigest: workspaceCandidateDigest(binding) });
      expect(validateWorkspaceReviewReceipt(stored)).toEqual({ valid: true, errors: [] });
      const reader = new WorkspaceApplication(wrappedStore(store, { readReview: () => stored }));
      const stale = success(reader, readRequest());
      expect(stale.validation.status).toBe("stale");
      expect(stale.review).toEqual(stored);
    }
    const badCandidate = rehash({ ...review, candidateDigest: "0".repeat(64) });
    const reader = new WorkspaceApplication(wrappedStore(store, { readReview: () => badCandidate }));
    expect(success(reader, readRequest())).toMatchObject({ validation: { status: "stale" }, review: badCandidate });
    expect(success(app, readRequest())).toEqual(reviewed);
  });

  it("does not expose receipt import or accept client principal/approval authority on the review API", () => {
    const { app, store } = open();
    const current = selected(app);
    const request = reviewRequest(current);
    const computed = reviewWorkspace(current.workspace, store.readBase("succession")).review;
    const inputs: readonly unknown[] = [
      { ...request, principal: { role: "admin" } },
      { ...request, payload: { ...request.payload, principal: { role: "admin" } } },
      { ...request, payload: { ...request.payload, review: computed } },
      { ...request, payload: { ...request.payload, approval: "approved" } },
      { ...request, payload: { ...request.payload, limits: { principal: "admin" } } },
    ];
    for (const input of inputs) {
      expect(validateApiRequest(input).valid).toBe(false);
      const response = executeApiRequest(input, { workspaces: app });
      expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
      expect(response).toMatchObject({ requestId: request.requestId, operation: request.operation, outcome: "error", error: { code: "INVALID_REQUEST" } });
      expect(response).not.toHaveProperty("data");
      expect(operationExitCode(request.operation, response)).toBe(2);
    }
    expect(store.readReview("succession")).toBeUndefined();
    expect(success(app, readRequest())).toEqual(current);
    noNextVersion(app, current);
  });
});
