import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertionId } from "@wmm/canonical";
import type {
  ApiErrorCodeV1, ApiResponseV1, AssertionRecordV1, SnapshotRecordV1,
  WorkspaceActionV1, WorkspaceOperationV1, WorkspaceRequestV1, WorkspaceViewV1,
} from "@wmm/wire-contracts";
import { validateApiRequest, validateApiResponse } from "@wmm/wire-contracts";
// The application has no adapter dependency: the host supplies the built SQLite adapter.
import { SqliteWorkspaceStore } from "../../store-authoring-sqlite/dist/index.js";
import { executeApiRequest, operationExitCode, WorkspaceApplication } from "../src/index.js";

type CreateRequest = Extract<WorkspaceRequestV1, { operation: "workspace.create" }>;
type MutateRequest = Extract<WorkspaceRequestV1, { operation: "workspace.mutate" }>;
type ProposalInput = Extract<WorkspaceActionV1, { kind: "put-proposal" }>["proposal"];

const demoPath = fileURLToPath(new URL("../../../fixtures/v3/succession-world/", import.meta.url));
const worldPath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const directories: string[] = [];
const stores: SqliteWorkspaceStore[] = [];
let sourceHashes: readonly Record<string, string>[] = [];

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeHashes(root: string, relative = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, treeHashes(root, path));
    else if (entry.isFile()) files[path] = hash(readFileSync(join(root, path)));
    else throw new Error(`Unexpected non-file fixture entry: ${path}`);
  }
  return files;
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "wmm-application-workspaces-"));
  directories.push(path);
  return path;
}

function open(databasePath = join(directory(), "workspaces.sqlite")) {
  const store = new SqliteWorkspaceStore(databasePath);
  stores.push(store);
  return { databasePath, store, app: new WorkspaceApplication(store) };
}

function createRequest(payload: Partial<CreateRequest["payload"]> = {}): CreateRequest {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: "create-succession",
    operation: "workspace.create",
    payload: {
      workspaceId: "succession", bundlePath: demoPath, title: "The succession crisis",
      goal: "Review a succession without changing canon.", mode: "succession-demo",
      idempotencyKey: "create-1", ...payload,
    },
  };
}

function mutation(view: WorkspaceViewV1, action: WorkspaceActionV1, key = `mutation-${view.workspace.version}`): MutateRequest {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `request-${key}`,
    operation: "workspace.mutate",
    payload: { workspaceId: view.workspace.id, expectedVersion: view.workspace.version, idempotencyKey: key, action },
  };
}

function readRequest(workspaceId = "succession", atVersion?: number): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `read-${workspaceId}-${atVersion ?? "latest"}`,
    operation: "workspace.read", payload: { workspaceId, ...(atVersion === undefined ? {} : { atVersion }) },
  };
}

function send(app: WorkspaceApplication, request: WorkspaceRequestV1): ApiResponseV1 {
  const response = executeApiRequest(JSON.parse(JSON.stringify(request)), { workspaces: app });
  expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  expect(response).toMatchObject({
    format: "wmm.response/1", apiVersion: "wmm/1", requestId: request.requestId,
    operation: request.operation, execution: "completed", diagnostics: [],
  });
  return response;
}

function success(app: WorkspaceApplication, request: WorkspaceRequestV1): WorkspaceViewV1 {
  expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
  const response = send(app, request);
  expect(response.outcome, JSON.stringify(response)).toBe("success");
  if (response.outcome !== "success" || (
    response.operation !== "workspace.create" && response.operation !== "workspace.read" && response.operation !== "workspace.mutate"
  )) throw new Error("Expected a workspace result");
  expect(operationExitCode(request.operation, response)).toBe(0);
  expect(response.resolved).toEqual(response.data.workspace.base);
  expect(response.data).toMatchObject({
    format: "wmm.workspace-view/1", validation: { status: "not-run" }, approval: "unavailable", canon: "unchanged",
  });
  return response.data;
}

function failure(app: WorkspaceApplication, request: WorkspaceRequestV1, code: ApiErrorCodeV1, message?: RegExp): void {
  const response = send(app, request);
  expect(response).toMatchObject({ outcome: "error", error: { code } });
  expect(response).not.toHaveProperty("data");
  expect(response).not.toHaveProperty("resolved");
  expect(operationExitCode(request.operation, response)).toBe(code === "INVALID_REQUEST" ? 2 : 3);
  if (message !== undefined && response.outcome === "error") expect(response.error.message).toMatch(message);
}

function read(app: WorkspaceApplication, atVersion?: number): WorkspaceViewV1 {
  return success(app, readRequest("succession", atVersion));
}

function mutate(app: WorkspaceApplication, view: WorkspaceViewV1, action: WorkspaceActionV1, key?: string): WorkspaceViewV1 {
  return success(app, mutation(view, action, key));
}

function group(view: WorkspaceViewV1, id: string) {
  const result = view.workspace.proposals.find((proposal) => proposal.id === id);
  if (result === undefined) throw new Error(`Missing proposal: ${id}`);
  return result;
}

function document(view: WorkspaceViewV1, path: string) {
  const result = view.documents.find((item) => item.path === path);
  if (result === undefined || result.sha256 === undefined) throw new Error(`Missing base document/hash: ${path}`);
  return { ...result, sha256: result.sha256 };
}

function write(path = "prose/developments/authored.md", text = "# An authored alternative\n", beforeSha256: string | null = null): WorkspaceOperationV1 {
  return { kind: "write-prose", path, text, beforeSha256 };
}

function put(id: string, operations: readonly WorkspaceOperationV1[], extra: Partial<ProposalInput> = {}): WorkspaceActionV1 {
  return {
    kind: "put-proposal",
    proposal: { id, title: `Review ${id}`, author: "Human", rationale: "An explicit authored operation.", dependencies: [], exclusions: [], operations, ...extra },
  };
}

function signed(body: AssertionRecordV1["body"]): AssertionRecordV1 {
  return { format: "wmm.assertion-record/1", id: assertionId(body), body };
}

function activeAssertion(store: SqliteWorkspaceStore): AssertionRecordV1 {
  const base = store.readBase("succession");
  const result = base.world.assertions.find((assertion) => base.world.world.activeAssertionIds.includes(assertion.id)
    && assertion.body.applicability.kind === "invariant" && assertion.body.proposition.kind === "atom");
  if (result === undefined) throw new Error("Fixture needs an active invariant atom");
  return result;
}

beforeEach(() => { sourceHashes = [treeHashes(demoPath), treeHashes(worldPath)]; });
afterEach(() => {
  try {
    expect(treeHashes(demoPath)).toEqual(sourceHashes[0]);
    expect(treeHashes(worldPath)).toEqual(sourceHashes[1]);
  } finally {
    for (const store of stores.splice(0).reverse()) store.close();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

describe("durable workspace application API", () => {
  it("performs the six-step human succession review and recovers every exact version after reopen", () => {
    const { app, store, databasePath } = open();
    const snapshot = JSON.parse(readFileSync(join(demoPath, "snapshot.json"), "utf8")) as SnapshotRecordV1;
    expect(snapshot.manifest.files).toHaveLength(47);
    expect(Object.keys(treeHashes(join(demoPath, "payload")))).toHaveLength(47);

    const initial = success(app, createRequest());
    const versions = [initial];
    expect(initial.workspace).toMatchObject({
      version: 1, mode: "succession-demo", history: [],
      base: { worldId: snapshot.manifest.worldId, snapshotDigest: snapshot.snapshotDigest },
    });
    expect(initial.workspace.proposals.map(({ id, decision, version }) => ({ id, decision, version }))).toEqual(
      ["death", "council", "coup", "intervention"].map((id) => ({ id, decision: "undecided", version: 1 })),
    );
    expect(initial.selection.requested).toEqual([]);
    expect(initial.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "person:alys" }),
      expect.objectContaining({ id: "source:authorial-stipulation" }),
    ]));
    expect(initial.documents.map((item) => item.path).sort()).toEqual(["prose/neutrality.md", "prose/succession.md", "prose/valen.md"]);
    for (const item of initial.documents) {
      const bytes = readFileSync(join(demoPath, "payload", item.path));
      expect(item).toEqual({ path: item.path, sha256: hash(bytes), text: bytes.toString("utf8"), truncated: false });
    }
    const neutrality = document(initial, "prose/neutrality.md");
    expect(initial.workspace.pins).toEqual([
      { id: "neutrality", kind: "document", path: neutrality.path, sha256: neutrality.sha256, active: true },
    ]);
    const capturedBase = store.readBase("succession");
    expect(capturedBase.snapshot).toEqual(snapshot);
    expect(capturedBase.documents.map((item) => Buffer.from(item.base64, "base64"))).toEqual(
      initial.documents.map((item) => readFileSync(join(demoPath, "payload", item.path))),
    );

    const title = "Negotiate a dynastic regency 👑";
    const rationale = "The council governs for the young heir.\n\nKeep the dynasty; use diplomacy. 中立";
    const actions = [
      { kind: "select", groupIds: ["council", "death"] },
      { kind: "decide", groupId: "coup", decision: "rejected", reason: "No military seizure; preserve civilian continuity." },
      { kind: "add-regency", title, rationale },
      { kind: "select", groupIds: ["council", "death", "regency"] },
      { kind: "set-direction", text: "Keep the dynasty and neighboring neutrality. Prefer diplomacy; do not infer any further developments." },
    ] as const satisfies readonly WorkspaceActionV1[];
    let current = initial;
    for (const action of actions) {
      const before = current;
      current = mutate(app, current, action);
      versions.push(current);
      expect(current.workspace.version).toBe(before.workspace.version + 1);
      expect(current.workspace.history).toEqual(actions.slice(0, versions.length - 1).map((action, index) => ({ version: index + 2, action })));
      expect(current.workspace.base).toEqual(initial.workspace.base);
      expect(current.workspace.pins).toEqual(initial.workspace.pins);
      expect(current.documents).toEqual(initial.documents);
      expect(current.selection.diagnostics).toEqual([]);
      if (action.kind === "add-regency") {
        expect(group(current, "regency")).toMatchObject({
          title, rationale, version: 1, decision: "undecided", rejectionReason: null,
          dependencies: ["council", "death"], exclusions: ["coup"],
          operations: [write("prose/developments/regency.md", `# ${title}\n\n${rationale}\n`)],
        });
        expect(current.selection.requested).toEqual(["council", "death"]);
        expect(current.changes.find((change) => change.groupId === "regency")).toMatchObject({
          representation: "explicit-prose", proposed: [expect.stringContaining(rationale)],
        });
      }
      if (action.kind === "set-direction") {
        expect(current.workspace.proposals).toEqual(before.workspace.proposals);
        expect(current.workspace.direction).toBe(action.text);
      }
    }
    expect(current.workspace.version).toBe(6);
    expect(current.workspace.history.map((entry) => entry.version)).toEqual([2, 3, 4, 5, 6]);
    expect(current.workspace.proposals.every((proposal) => proposal.version === 1)).toBe(true);
    expect(current.selection).toEqual({
      requested: ["council", "death", "regency"], required: ["council", "death", "regency"],
      missing: [], rejectedRequired: [], diagnostics: [],
    });
    expect(group(current, "coup")).toMatchObject({ decision: "rejected", rejectionReason: actions[1].reason });
    expect(group(current, "intervention").decision).toBe("undecided");
    expect(store.readBase("succession")).toEqual(capturedBase);

    store.close();
    const reopened = open(databasePath);
    expect(read(reopened.app)).toEqual(current);
    expect(reopened.store.readBase("succession")).toEqual(capturedBase);
    for (const view of versions) expect(read(reopened.app, view.workspace.version)).toEqual(view);
    expect(read(reopened.app)).toEqual(current);
  });

  it.each(["moved", "mutated", "deleted"] as const)("resumes and retries create from its captured base after the source is %s", (change) => {
    const root = directory();
    const source = join(root, "source");
    cpSync(demoPath, source, { recursive: true });
    const { app, store, databasePath } = open(join(root, "draft.sqlite"));
    const request = createRequest({ bundlePath: source });
    const initial = success(app, request);
    const base = store.readBase("succession");
    const advanced = mutate(app, initial, { kind: "set-direction", text: "Saved before losing access to the source." });
    store.close();
    if (change === "moved") renameSync(source, join(root, "moved-source"));
    else if (change === "deleted") rmSync(source, { recursive: true });
    else {
      writeFileSync(join(source, "snapshot.json"), "not a world bundle anymore\n");
      writeFileSync(join(source, "payload/prose/neutrality.md"), "The source now says something else.\n");
      rmSync(join(source, "payload/prose/succession.md"));
    }
    const changedSource = existsSync(source) ? treeHashes(source) : null;
    const reopened = open(databasePath);
    expect(read(reopened.app)).toEqual(advanced);
    expect(read(reopened.app, 1)).toEqual(initial);
    expect(reopened.store.readBase("succession")).toEqual(base);
    expect(success(reopened.app, { ...request, requestId: "retry-create-after-source-loss" })).toEqual(initial);
    expect(read(reopened.app)).toEqual(advanced);

    const succession = document(initial, "prose/succession.md");
    const resumed = mutate(reopened.app, advanced, put("resumed", [
      write(succession.path, "# A draft written without loading the source\n", succession.sha256),
    ]));
    expect(resumed.changes.find((item) => item.groupId === "resumed")?.before).toEqual([`${succession.path}\n${succession.text}`]);
    expect(resumed.documents).toEqual(initial.documents);
    expect(reopened.store.readBase("succession")).toEqual(base);
    expect(existsSync(source) ? treeHashes(source) : null).toEqual(changedSource);
    failure(reopened.app, { ...request, requestId: "changed-create", payload: { ...request.payload, title: "A different intent" } }, "IDEMPOTENCY_CONFLICT");
    expect(read(reopened.app)).toEqual(resumed);
  });

  it("starts a standard v1 world empty, with no demo proposals, pins or regency injection", () => {
    const { app } = open();
    const initial = success(app, createRequest({ bundlePath: worldPath, mode: "world" }));
    expect(initial.workspace).toMatchObject({ mode: "world", version: 1, proposals: [], pins: [], direction: "", history: [] });
    expect(initial).toMatchObject({ changes: [], prerequisites: [], selection: { requested: [], required: [], missing: [], diagnostics: [] } });
    expect(initial.documents.map((item) => item.path)).toEqual(["prose/valen.md"]);
    expect(initial.records).toContainEqual(expect.objectContaining({ id: "person:alys" }));
    const request = mutation(initial, { kind: "add-regency", title: "A regency", rationale: "Not a demo." }, "failed-template");
    failure(app, request, "INVALID_WORKSPACE_ACTION", /only available in succession-demo/);
    expect(read(app)).toEqual(initial);
    failure(app, readRequest("succession", 2), "WORKSPACE_NOT_FOUND");
    const retried = success(app, { ...request, payload: { ...request.payload, action: { kind: "set-direction", text: "Author my own world." } } });
    expect(retried.workspace.history).toEqual([{ version: 2, action: { kind: "set-direction", text: "Author my own world." } }]);
    expect(retried.workspace.proposals).toEqual([]);
  });

  it("rolls back an inadmissible demo create and leaves its workspace ID and idempotency key reusable", () => {
    const { app } = open();
    const request = createRequest({ bundlePath: worldPath });
    failure(app, request, "INVALID_WORKSPACE_ACTION", /requires its worked-demo bundle/);
    failure(app, readRequest(), "WORKSPACE_NOT_FOUND");
    const created = success(app, { ...request, payload: { ...request.payload, bundlePath: demoPath } });
    expect(created.workspace).toMatchObject({ version: 1, history: [] });
  });

  it("rejects a stale writer on a second connection without recording state, history or a retry outcome", () => {
    const first = open();
    const initial = success(first.app, createRequest());
    const second = open(first.databasePath);
    const stale = read(second.app);
    const current = mutate(first.app, initial, { kind: "select", groupIds: ["death"] });
    const request = mutation(stale, { kind: "set-direction", text: "Must not overwrite the newer review." }, "stale-retry");
    failure(second.app, request, "STALE_WORKSPACE", /version 2|at version 2/);
    expect(read(first.app)).toEqual(current);
    expect(read(second.app)).toEqual(current);
    failure(second.app, readRequest("succession", 3), "WORKSPACE_NOT_FOUND");
    const retried = success(second.app, { ...request, payload: { ...request.payload, expectedVersion: 2 } });
    expect(retried.workspace.history).toEqual([
      ...current.workspace.history, { version: 3, action: request.payload.action },
    ]);
    expect(retried.selection.requested).toEqual(["death"]);
  });

  it("durably replays the original mutation view before stale checks, but rejects changed intent", () => {
    const first = open();
    const create = createRequest();
    const initial = success(first.app, create);
    const original = mutation(initial, { kind: "select", groupIds: ["death", "council", "death"] }, "original-selection");
    const selected = success(first.app, original);
    expect(selected.workspace.history).toEqual([{ version: 2, action: { kind: "select", groupIds: ["council", "death"] } }]);
    const advanced = mutate(first.app, selected, { kind: "decide", groupId: "coup", decision: "rejected", reason: "No coup." });
    first.store.close();
    const { app } = open(first.databasePath);
    expect(success(app, { ...original, requestId: "a-new-correlation-id" })).toEqual(selected);
    expect(success(app, { ...original, requestId: "normalized-equivalent", payload: { ...original.payload, action: { kind: "select", groupIds: ["council", "death"] } } })).toEqual(selected);
    expect(success(app, { ...create, requestId: "retry-original-create" })).toEqual(initial);
    failure(app, { ...original, payload: { ...original.payload, action: { kind: "select", groupIds: ["death"] } } }, "IDEMPOTENCY_CONFLICT");
    failure(app, { ...original, payload: { ...original.payload, expectedVersion: 2 } }, "IDEMPOTENCY_CONFLICT");
    failure(app, { ...create, payload: { ...create.payload, goal: "Changed creation intent." } }, "IDEMPOTENCY_CONFLICT");
    failure(app, { ...create, payload: { ...create.payload, bundlePath: worldPath } }, "IDEMPOTENCY_CONFLICT");
    failure(app, { ...create, payload: { ...create.payload, idempotencyKey: "another-create" } }, "WORKSPACE_EXISTS");
    failure(app, mutation(advanced, { kind: "set-direction", text: "Cannot reuse a create key for a mutation." }, create.payload.idempotencyKey), "IDEMPOTENCY_CONFLICT");
    expect(read(app)).toEqual(advanced);
    expect(read(app, 2)).toEqual(selected);
    failure(app, readRequest("succession", 4), "WORKSPACE_NOT_FOUND");
  });

  it("shows transitive and rejected prerequisites without silently selecting or restoring them", () => {
    const { app } = open();
    let current = success(app, createRequest());
    current = mutate(app, current, { kind: "add-regency", title: "A civilian regency", rationale: "An author-chosen alternative." });
    current = mutate(app, current, { kind: "select", groupIds: ["regency"] });
    expect(current.selection).toMatchObject({ requested: ["regency"], required: ["council", "death", "regency"], missing: ["council", "death"], rejectedRequired: [] });
    expect(current.selection.diagnostics).toEqual([
      expect.objectContaining({ code: "MISSING_PREREQUISITE", groupIds: ["council", "death"] }),
    ]);
    expect(group(current, "council").decision).toBe("undecided");
    expect(group(current, "death").decision).toBe("undecided");
    const reason = "Keep the sovereign alive while exploring alternatives.";
    current = mutate(app, current, { kind: "decide", groupId: "death", decision: "rejected", reason });
    current = mutate(app, current, { kind: "select", groupIds: ["regency"] });
    expect(current.selection).toMatchObject({ requested: ["regency"], missing: ["council", "death"], rejectedRequired: ["death"] });
    expect(current.prerequisites).toContainEqual({ groupId: "regency", required: ["council", "death"], missing: ["council", "death"], rejected: ["death"] });
    expect(group(current, "death")).toMatchObject({ decision: "rejected", rejectionReason: reason });
    failure(app, mutation(current, { kind: "select", groupIds: ["council", "death", "regency"] }, "implicit-restore"), "INVALID_WORKSPACE_ACTION", /Restore rejected/);
    failure(app, mutation(current, { kind: "decide", groupId: "death", decision: "selected" }, "direct-restore"), "INVALID_WORKSPACE_ACTION", /Restore a rejected/);
    expect(read(app)).toEqual(current);
    current = mutate(app, current, { kind: "decide", groupId: "death", decision: "undecided" });
    expect(group(current, "death")).toMatchObject({ decision: "undecided", rejectionReason: reason });
    expect(current.selection.requested).toEqual(["regency"]);
    current = mutate(app, current, { kind: "select", groupIds: ["council", "death", "regency"] });
    expect(current.selection).toMatchObject({ requested: ["council", "death", "regency"], missing: [], rejectedRequired: [], diagnostics: [] });
    expect(group(current, "death").rejectionReason).toBe(reason);
  });
});

describe("base-bound workspace operation admission", () => {
  it.each([
    ["../neutrality.md", "INVALID_REQUEST"],
    ["prose/../neutrality.md", "INVALID_REQUEST"],
    ["/prose/neutrality.md", "INVALID_REQUEST"],
    ["prose\\neutrality.md", "INVALID_REQUEST"],
    ["world.json", "INVALID_WORKSPACE_ACTION"],
    ["records/notes.md", "INVALID_WORKSPACE_ACTION"],
    ["assets/notes.md", "INVALID_WORKSPACE_ACTION"],
    ["prose/neutrality.json", "INVALID_WORKSPACE_ACTION"],
    ["prose/Neutrality.md", "INVALID_WORKSPACE_ACTION"],
    ["prose/neutrality.md/nested.md", "INVALID_WORKSPACE_ACTION"],
  ] as const)("rejects unsafe or unauthorized prose path %s without saving anything", (path, code) => {
    const { app } = open();
    const initial = success(app, createRequest());
    const request = mutation(initial, put("unsafe-path", [write(path)]));
    expect(validateApiRequest(request).valid).toBe(code !== "INVALID_REQUEST");
    failure(app, request, code, code === "INVALID_REQUEST" ? /schema/ : /Prose|case|collides/);
    expect(read(app)).toEqual(initial);
    failure(app, readRequest("succession", 2), "WORKSPACE_NOT_FOUND");
  });

  it.each(["missing existing hash", "wrong existing hash", "new path with existing hash"] as const)("rejects %s rather than guessing document authority", (test) => {
    const { app } = open();
    const initial = success(app, createRequest());
    const neutrality = document(initial, "prose/neutrality.md");
    const operation = test === "new path with existing hash" ? write("prose/new.md", "New prose", neutrality.sha256)
      : write(neutrality.path, "Replacement", test === "missing existing hash" ? null : "0".repeat(64));
    const request = mutation(initial, put("bad-base-binding", [operation]));
    expect(validateApiRequest(request).valid).toBe(true);
    failure(app, request, "INVALID_WORKSPACE_ACTION", /exact pinned-base document/);
    expect(read(app)).toEqual(initial);
  });

  it.each(["empty operations", "duplicate document writes"] as const)("rejects %s atomically", (test) => {
    const { app } = open();
    const initial = success(app, createRequest());
    const operations = test === "empty operations" ? [] : [write("prose/New.md"), write("prose/new.md")];
    failure(app, mutation(initial, put("invalid-operations", operations)), "INVALID_WORKSPACE_ACTION", /at least one explicit operation|write a document twice/);
    expect(read(app)).toEqual(initial);
  });

  it.each(["identity", "world", "profile", "unknown subject", "unknown predicate"] as const)("rejects assertion %s errors after wire admission without writing a version", (test) => {
    const { app, store } = open();
    const initial = success(app, createRequest());
    const original = activeAssertion(store);
    let assertion: AssertionRecordV1;
    if (test === "identity") assertion = { ...original, body: { ...original.body, polarity: original.body.polarity === "positive" ? "negative" : "positive" } };
    else if (test === "world") assertion = signed({ ...original.body, worldId: "world:another" });
    else if (test === "profile") assertion = signed({ ...original.body, semanticProfileDigest: "0".repeat(64) });
    else {
      const atom = original.body.proposition;
      if (atom.kind !== "atom") throw new Error("Expected an atom");
      assertion = signed({ ...original.body, proposition: test === "unknown subject"
        ? { ...atom, subjectId: "person:missing" } : { ...atom, predicateDefinitionDigest: "0".repeat(64) } });
    }
    const request = mutation(initial, put("bad-assertion", [{ kind: "activate-assertion", assertion }]));
    expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
    failure(app, request, "INVALID_WORKSPACE_ACTION", /Assertion identity|Assertion admission failed/);
    expect(read(app)).toEqual(initial);
    failure(app, readRequest("succession", 2), "WORKSPACE_NOT_FOUND");
  });

  it("rolls back a proposal containing a valid operation followed by an invalid one, without consuming its key", () => {
    const { app, store, databasePath } = open();
    const initial = success(app, createRequest());
    const base = store.readBase("succession");
    const request = mutation(initial, put("atomic-proposal", [
      write("prose/developments/first.md", "This must not be partially saved."),
      { kind: "deactivate-assertion", assertionId: `asrt:${"0".repeat(64)}` },
    ]), "atomic-retry");
    expect(validateApiRequest(request).valid).toBe(true);
    failure(app, request, "INVALID_WORKSPACE_ACTION", /Only active pinned-base assertions/);
    expect(read(app)).toEqual(initial);
    expect(store.readBase("succession")).toEqual(base);
    store.close();
    const reopened = open(databasePath);
    expect(read(reopened.app)).toEqual(initial);
    failure(reopened.app, readRequest("succession", 2), "WORKSPACE_NOT_FOUND");
    const corrected = { ...request, requestId: "corrected-operation", payload: { ...request.payload, action: put("atomic-proposal", [write()]) } };
    const saved = success(reopened.app, corrected);
    expect(saved.workspace.history).toEqual([{ version: 2, action: corrected.payload.action }]);
    expect(group(saved, "atomic-proposal").operations).toEqual([write()]);
    expect(success(reopened.app, { ...corrected, requestId: "replayed-correction" })).toEqual(saved);
  });
});

describe("hard pins are exact base-bound draft diagnostics, not historical validation", () => {
  it.each(["unknown document", "wrong document hash", "unknown assertion"] as const)("rejects an invalid %s pin without effects", (test) => {
    const { app } = open();
    const initial = success(app, createRequest());
    const neutrality = document(initial, "prose/neutrality.md");
    const action: WorkspaceActionV1 = { kind: "put-pin", pin: test === "unknown assertion"
      ? { id: "invalid-pin", kind: "assertion", assertionId: `asrt:${"0".repeat(64)}`, active: true }
      : { id: "invalid-pin", kind: "document", path: test === "unknown document" ? "prose/missing.md" : neutrality.path,
        sha256: test === "wrong document hash" ? "0".repeat(64) : neutrality.sha256, active: true } };
    failure(app, mutation(initial, action), "INVALID_WORKSPACE_ACTION", /pin must identify an (exact pinned-base document|active pinned-base claim)/);
    expect(read(app)).toEqual(initial);
  });

  it("diagnoses a selected neutrality edit while preserving the pin and the original base bytes", () => {
    const { app, store } = open();
    const initial = success(app, createRequest());
    const base = store.readBase("succession");
    const neutrality = document(initial, "prose/neutrality.md");
    const selected = mutate(app, initial, { kind: "select", groupIds: ["death", "intervention"] });
    expect(selected.selection.diagnostics).toEqual([
      expect.objectContaining({ code: "PIN_CHANGED", groupIds: ["intervention"], message: expect.stringContaining("Canon remains unchanged") }),
    ]);
    expect(selected.workspace.pins).toEqual(initial.workspace.pins);
    expect(selected.documents).toEqual(initial.documents);
    expect(selected.changes.find((item) => item.groupId === "intervention")).toMatchObject({
      representation: "explicit-prose", before: [`${neutrality.path}\n${neutrality.text}`],
      proposed: [expect.stringContaining("The neighboring army intervenes")],
    });
    expect(store.readBase("succession")).toEqual(base);
    const advice = mutate(app, selected, { kind: "set-direction", text: "Ignore neutrality and invite an army (advice is not an operation)." });
    expect(advice.workspace.pins).toEqual(initial.workspace.pins);
    expect(advice.selection).toEqual(selected.selection);
  });

  it("does not diagnose a byte-identical pinned document write, but diagnoses a real change even with the correct before hash", () => {
    const { app } = open();
    const initial = success(app, createRequest());
    const neutrality = document(initial, "prose/neutrality.md");
    let current = mutate(app, initial, put("no-op", [write(neutrality.path, neutrality.text, neutrality.sha256)]));
    current = mutate(app, current, { kind: "select", groupIds: ["no-op"] });
    expect(current.selection.diagnostics).toEqual([]);
    current = mutate(app, current, put("changed", [write(neutrality.path, `${neutrality.text}\nAn intervention is proposed.\n`, neutrality.sha256)]));
    current = mutate(app, current, { kind: "select", groupIds: ["changed"] });
    expect(current.selection.diagnostics).toEqual([expect.objectContaining({ code: "PIN_CHANGED", groupIds: ["changed"] })]);
    expect(current.documents).toEqual(initial.documents);
    expect(current.workspace.pins).toEqual(initial.workspace.pins);
  });

  it("diagnoses both deactivation and an admitted opposing assertion, but not exact reactivation of a pinned claim", () => {
    const { app, store } = open();
    const initial = success(app, createRequest({ bundlePath: worldPath, mode: "world" }));
    const base = store.readBase("succession");
    const assertion = activeAssertion(store);
    const pin = { id: "protected-claim", kind: "assertion", assertionId: assertion.id, active: true } as const;
    let current = mutate(app, initial, { kind: "put-pin", pin });
    current = mutate(app, current, put("same-claim", [{ kind: "activate-assertion", assertion }]));
    current = mutate(app, current, { kind: "select", groupIds: ["same-claim"] });
    expect(current.selection.diagnostics).toEqual([]);
    current = mutate(app, current, put("remove-claim", [{ kind: "deactivate-assertion", assertionId: assertion.id }]));
    current = mutate(app, current, { kind: "select", groupIds: ["remove-claim"] });
    expect(current.selection.diagnostics).toEqual([expect.objectContaining({ code: "PIN_CHANGED", groupIds: ["remove-claim"] })]);
    const opposite = signed({ ...assertion.body, polarity: assertion.body.polarity === "positive" ? "negative" : "positive" });
    expect(opposite.id).not.toBe(assertion.id);
    current = mutate(app, current, put("opposite-claim", [{ kind: "activate-assertion", assertion: opposite }]));
    current = mutate(app, current, { kind: "select", groupIds: ["opposite-claim"] });
    expect(current.selection.diagnostics).toEqual([expect.objectContaining({ code: "PIN_CHANGED", groupIds: ["opposite-claim"] })]);
    expect(current.changes.find((item) => item.groupId === "opposite-claim")).toMatchObject({
      representation: "explicit-claims", before: [expect.stringContaining("opposite is not thereby established")],
      proposed: [expect.stringContaining("explicitly not")],
    });
    expect(current.workspace.pins).toEqual([pin]);
    expect(current.documents).toEqual(initial.documents);
    expect(store.readBase("succession")).toEqual(base);
    current = mutate(app, current, { kind: "put-pin", pin: { ...pin, active: false } });
    expect(current.selection.diagnostics).toEqual([]);
    expect(current.selection.requested).toEqual(["opposite-claim"]);
  });
});
