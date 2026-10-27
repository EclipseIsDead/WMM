import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, semanticProfileDigest, sha256Hex, snapshotDigest } from "@wmm/canonical";
import { economySemantics, verifyCapturedWorkspaceBase } from "@wmm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthoringBundle, readEconomyView } from "@wmm/exchange";
import type { ApiResponseV1, AuthoringIndex, AuthoringProject, JsonValue, WorkspaceBaseV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import { validateApiResponse } from "@wmm/wire-contracts";
import { SqliteWorkspaceStore } from "../../store-authoring-sqlite/dist/index.js";
import { changedBundle, writeChangedBundle } from "../../exchange/test/helpers/economy-bundle.js";
import { capture, persistCapture } from "./helpers/economy-capture.js";
import * as application from "../src/index.js";

const roots: string[] = [];
const stores: SqliteWorkspaceStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const value = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-app-")); roots.push(value); return value; }
function grain(): AuthoringProject { return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url), "utf8")) as AuthoringProject; }
function request(operation: string, payload: unknown) { return { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "fixed-economy-request", operation, payload }; }
function runtime(directory?: string) {
  const base = root();
  const bundlePath = directory ?? join(base, "bundle");
  if (directory === undefined) buildAuthoringBundle(grain(), bundlePath);
  const databasePath = join(base, "authoring.sqlite");
  const store = new SqliteWorkspaceStore(databasePath); stores.push(store);
  const app = new application.WorkspaceApplication(store);
  const call = (operation: string, payload: unknown): ApiResponseV1 => application.executeApiRequest(request(operation, payload), { workspaces: app });
  const created = call("workspace.create", { workspaceId: "grain", bundlePath, title: "Grain", goal: "Read only", mode: "world", idempotencyKey: "create" });
  expect(created, JSON.stringify(created)).toMatchObject({ outcome: "success" });
  return { base, bundlePath, databasePath, store, app, call };
}
function persisted(db: DatabaseSync) {
  return Object.fromEntries(["workspace_bases", "workspace_versions", "workspace_outcomes", "workspace_reviews", "workspace_outcome_reviews"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("application Economy reads", () => {
  it("exports a real direct-snapshot read using the verified economic projection", () => {
    const directory = join(root(), "bundle");
    const loaded = buildAuthoringBundle(grain(), directory);
    expect(application.readSnapshotEconomy(directory)).toEqual(readEconomyView(loaded));
  });

  it("routes a real SQLite captured-base Economy read with exact operation and identities", () => {
    const { bundlePath, store, app, call } = runtime();
    const state = store.read("grain");
    const response = call("workspace.economy.read", { workspaceId: "grain" });
    expect(response, JSON.stringify(response)).toMatchObject({
      outcome: "success", execution: "completed", operation: "workspace.economy.read", resolved: state.base,
      data: { format: "wmm.workspace-economy-view/1", workspaceId: "grain", workspaceVersion: state.version, base: state.base,
        worldBasis: "base", selectedProposalsIncluded: false, candidateView: "unavailable", economy: application.readSnapshotEconomy(bundlePath) },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    if (response.outcome !== "success" || response.operation !== "workspace.economy.read") throw new Error("Expected economic result");
    expect(app.readEconomy({ workspaceId: "grain" })).toEqual(response.data);
    expect(response.data.economy).toMatchObject({
      worldId: state.base.worldId, snapshotDigest: state.base.snapshotDigest, semanticProfileDigest: economySemantics().profileDigest,
      inputDigest: sha256Hex(canonicalJsonBytes(grain() as unknown as JsonValue)), perspective: "dm", accounting: "not-run", scenarios: "not-run",
    });
    expect(response.data.economy.records.map((record) => record.value.kind).sort()).toEqual(["delivery-commitment", "planned-requirement", "stock-observation"]);
    expect(response.data.economy.sources).toEqual(grain().sources);
  });

  it("survives source removal and SQLite reopen without writes, review access, or selected-candidate projection", () => {
    const { bundlePath, databasePath, store, call } = runtime();
    const expected = application.readSnapshotEconomy(bundlePath);
    expect(call("workspace.mutate", { workspaceId: "grain", expectedVersion: 1, idempotencyKey: "proposal", action: { kind: "put-proposal", proposal: {
      id: "shipment-arrived", title: "Propose an arrival", author: "Synthetic author", rationale: "An authored proposal, not stock", dependencies: [], exclusions: [],
      operations: [{ kind: "write-prose", path: "prose/proposed-arrival.md", text: "The promised shipment has arrived (proposal only).", beforeSha256: null }],
    } } }).outcome).toBe("success");
    expect(call("workspace.mutate", { workspaceId: "grain", expectedVersion: 2, idempotencyKey: "select", action: { kind: "decide", groupId: "shipment-arrived", decision: "selected" } }).outcome).toBe("success");
    const reviewed = call("workspace.review", { workspaceId: "grain", expectedVersion: 3 });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ outcome: "success" });
    const before = store.read("grain"), receipt = store.readReview("grain"), baseBefore = store.readBase("grain");
    expect(receipt).toBeDefined();
    const historical = [1, 2, 3].map((version) => store.read("grain", version));
    const beforeResponse = call("workspace.economy.read", { workspaceId: "grain" });
    store.close();
    rmSync(bundlePath, { recursive: true });
    const reopened = new SqliteWorkspaceStore(databasePath); stores.push(reopened);
    const app = new application.WorkspaceApplication(reopened);
    const monitor = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
    try {
      const rows = persisted(monitor), dataVersion = monitor.prepare("PRAGMA data_version").get();
      const create = vi.spyOn(reopened, "create"), mutate = vi.spyOn(reopened, "mutate"), putReview = vi.spyOn(reopened, "putReview");
      const readReview = vi.spyOn(reopened, "readReview"), outcomeReview = vi.spyOn(reopened, "readOutcomeReview"), execute = vi.spyOn(app, "execute");
      const read = (payload: unknown) => application.executeApiRequest(request("workspace.economy.read", payload), { workspaces: app });
      const response = read({ workspaceId: "grain" });
      expect(response).toEqual(beforeResponse);
      expect(response).toMatchObject({ outcome: "success", data: { workspaceVersion: 3, selectedProposalsIncluded: false, candidateView: "unavailable", economy: expected } });
      for (const version of [1, 2, 3]) {
        const atVersion = read({ workspaceId: "grain", atVersion: version });
        expect(atVersion).toMatchObject({ outcome: "success", data: { workspaceVersion: version, economy: expected } });
        expect(validateApiResponse(atVersion).valid).toBe(true);
      }
      expect(read({ workspaceId: "grain", atVersion: 4 })).toMatchObject({ outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });
      for (const spy of [create, mutate, putReview, readReview, outcomeReview, execute]) expect(spy).not.toHaveBeenCalled();
      expect(persisted(monitor)).toEqual(rows);
      expect(monitor.prepare("PRAGMA data_version").get()).toEqual(dataVersion);
      expect(reopened.read("grain")).toEqual(before);
      expect([1, 2, 3].map((version) => reopened.read("grain", version))).toEqual(historical);
      expect(reopened.readReview("grain")).toEqual(receipt);
      expect(reopened.readBase("grain")).toEqual(baseBefore);
      expect(() => application.readSnapshotEconomy(bundlePath)).toThrow(expect.objectContaining({ code: "FILESYSTEM_ERROR" }));
    } finally { monitor.close(); }
  });

  it("fails stale when a store returns a different version than the explicit request", () => {
    const { store, call } = runtime();
    const state = store.read("grain");
    vi.spyOn(store, "read").mockReturnValue({ ...state, version: 2 });
    const response = call("workspace.economy.read", { workspaceId: "grain", atVersion: 1 });
    expect(response).toMatchObject({ outcome: "error", execution: "completed", operation: "workspace.economy.read", error: { code: "STALE_WORKSPACE" } });
    expect(validateApiResponse(response).valid).toBe(true);
  });

  it.each(["worldId", "snapshotDigest"] as const)("binds the captured base to the workspace's pinned %s", (field) => {
    const { store, call } = runtime();
    const state = store.read("grain");
    vi.spyOn(store, "read").mockReturnValue({ ...state, base: { ...state.base, [field]: field === "worldId" ? "world:other" : "f".repeat(64) } });
    expect(call("workspace.economy.read", { workspaceId: "grain" })).toMatchObject({ outcome: "error", error: { code: "INVALID_WORLD", message: expect.stringMatching(/world or snapshot/) } });
  });

  it("does not inspect proposal contents, candidate state or review association to read the base", () => {
    const { store, call } = runtime();
    const state = store.read("grain");
    let accesses = 0;
    Object.defineProperty(state, "proposals", { enumerable: true, get: () => { accesses += 1; throw new Error("Candidate should not be read"); } });
    vi.spyOn(store, "read").mockReturnValue(state);
    const readReview = vi.spyOn(store, "readReview"), readOutcomeReview = vi.spyOn(store, "readOutcomeReview");
    expect(call("workspace.economy.read", { workspaceId: "grain" })).toMatchObject({ outcome: "success" });
    expect(accesses).toBe(0);
    expect(readReview).not.toHaveBeenCalled();
    expect(readOutcomeReview).not.toHaveBeenCalled();
  });

  it("validates read requests before storage and handles missing host/workspace without mutation", () => {
    const { store, call } = runtime();
    const read = vi.spyOn(store, "read"), readBase = vi.spyOn(store, "readBase");
    for (const payload of [{ workspaceId: "grain", candidate: true }, { workspaceId: "grain", bundlePath: "never-opened" }, { workspaceId: "grain", atVersion: 0 }]) {
      expect(call("workspace.economy.read", payload)).toMatchObject({ outcome: "error", error: { code: "INVALID_REQUEST" } });
    }
    expect(read).not.toHaveBeenCalled(); expect(readBase).not.toHaveBeenCalled();
    expect(application.executeApiRequest(request("workspace.economy.read", { workspaceId: "grain" }))).toMatchObject({ outcome: "error", error: { code: "UNSUPPORTED_FEATURE" } });
    expect(call("workspace.economy.read", { workspaceId: "missing" })).toMatchObject({ outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });
  });

  it("rejects a store result for a different workspace identity", () => {
    const { store, call } = runtime();
    const state = store.read("grain");
    vi.spyOn(store, "read").mockReturnValue({ ...state, id: "other" });
    const response = call("workspace.economy.read", { workspaceId: "grain" });
    expect(response).toMatchObject({ outcome: "error", execution: "completed", error: { code: "STORAGE_FAILURE" } });
  });

  it("rejects a coherently rehashed economic literal read back from actual SQLite", () => {
    const compiled = changedBundle(grain(), (body) => {
      const p = body.proposition;
      if (p.kind !== "atom" || p.value.kind !== "literal") return body;
      const value = p.value.data as Record<string, JsonValue>;
      return { ...body, proposition: { ...p, value: { ...p.value, data: { ...value, quantity: { unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator: "2", denominator: "4" } } } } } } };
    });
    const { store, call } = runtime();
    const base = capture(compiled);
    const state = persistCapture(store, base);
    expect(store.readBase(state.id)).toEqual(base);
    const response = call("workspace.economy.read", { workspaceId: state.id });
    expect(response).toMatchObject({ outcome: "error", execution: "completed", error: { code: "INVALID_WORLD", message: expect.stringMatching(/reduced/) } });
    expect(validateApiResponse(response).valid).toBe(true);
  });

  it("pins the release economic profile, never the coherently hashed profile supplied by the capture", () => {
    const released = economySemantics();
    const profile = { ...released.profile, version: "2" };
    const digest = semanticProfileDigest(profile);
    const changed = changedBundle(grain(), (body) => ({ ...body, semanticProfileDigest: digest }), (path, value) => path === "world.json" ? { ...value as WorldCatalogV1, semanticProfileDigest: digest } : value);
    const payload = [...changed.payload.filter((file) => file.path !== `types/${released.profileDigest}.json`), { path: `types/${digest}.json`, mediaType: "application/json" as const, bytes: canonicalJsonBytes(profile as unknown as JsonValue) }].sort((a, b) => a.path < b.path ? -1 : 1);
    const manifest = { ...changed.snapshot.manifest, files: payload.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: sha256Hex(file.bytes), byteLength: String(file.bytes.length) })) };
    const base = capture({ payload, snapshot: { ...changed.snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } });
    const { store, call } = runtime();
    const state = persistCapture(store, base);
    // This verifies grammar/retained identity under an explicit test pin; it is not release authority.
    expect(verifyCapturedWorkspaceBase(base, { ...state.base, semanticProfileDigest: digest })).toEqual(base);
    expect(call("workspace.economy.read", { workspaceId: state.id })).toMatchObject({ outcome: "error", error: { code: "INVALID_WORLD", message: expect.stringMatching(/host-pinned profile/) } });
  });

  it.each([
    ["assertions", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, assertions: base.world.assertions.slice(1) } })],
    ["supports", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, supports: base.world.supports.slice(1) } })],
    ["sources", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, sources: base.world.sources.slice(1) } })],
    ["descriptors", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, descriptors: base.world.descriptors.slice(1) } })],
    ["definitions", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, definitions: base.world.definitions.slice(1) } })],
    ["profile", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, semanticProfile: { ...base.world.semanticProfile, version: "2" } } })],
    ["captured project", (base: WorkspaceBaseV1) => ({ ...base, documents: base.documents.filter((document) => document.path !== "authoring/project.json") })],
    ["presentation bytes", (base: WorkspaceBaseV1) => ({ ...base, documents: base.documents.map((document) => document.path === "authoring/index.json" ? { ...document, base64: Buffer.from("{}").toString("base64") } : document) })],
    ["document metadata", (base: WorkspaceBaseV1) => ({ ...base, world: { ...base.world, documents: base.world.documents.map((document) => ({ ...document, byteLength: "0" })) } })],
    ["snapshot", (base: WorkspaceBaseV1) => ({ ...base, snapshot: { ...base.snapshot, snapshotDigest: "f".repeat(64) }, world: { ...base.world, snapshotDigest: "f".repeat(64) } })],
  ] as const)("rejects malformed retained %s instead of trusting SQLite decoding", (_label, change) => {
    const { store, call } = runtime();
    const original = store.readBase("grain");
    const base = change(structuredClone(original));
    const state = persistCapture(store, base);
    expect(store.readBase(state.id)).toEqual(base);
    const response = call("workspace.economy.read", { workspaceId: state.id });
    expect(response).toMatchObject({ outcome: "error", execution: "completed", error: { code: "INVALID_WORLD" } });
    expect(validateApiResponse(response).valid).toBe(true);
    expect(store.readBase("grain")).toEqual(original);
  });

  it.each(["old authoring", "non-authoring"] as const)("refuses %s captured profiles rather than claiming a complete empty Economy", (kind) => {
    let directory: string;
    if (kind === "old authoring") {
      const { economy: _economy, ...old } = grain();
      directory = join(root(), "legacy"); buildAuthoringBundle(old, directory);
    } else directory = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
    const { store, call } = runtime(directory);
    const before = store.read("grain");
    expect(() => application.readSnapshotEconomy(directory)).toThrow(expect.objectContaining({ code: "INVALID_WORLD" }));
    expect(call("workspace.economy.read", { workspaceId: "grain" })).toMatchObject({ outcome: "error", execution: "completed", error: { code: "INVALID_WORLD", message: expect.stringMatching(/profile/i) } });
    expect(store.read("grain")).toEqual(before);
  });

  it("preserves the existing captured-base work ceiling and returns an incomplete budget error, never a partial view", () => {
    const input = grain();
    const record = input.economy!.records[0]!;
    const directory = join(root(), "large");
    buildAuthoringBundle({ ...input, economy: { format: "wmm.authoring-economy/1", records: Array.from({ length: 64 }, (_, index) => ({ ...record, id: `report-${index}` })) } }, directory);
    const { store, call } = runtime(directory);
    expect(application.readSnapshotEconomy(directory).records).toHaveLength(64);
    const before = store.read("grain");
    const response = call("workspace.economy.read", { workspaceId: "grain" });
    expect(response).toMatchObject({ outcome: "error", execution: "incomplete", error: { code: "BUDGET_EXCEEDED" } });
    expect(validateApiResponse(response).valid).toBe(true);
    expect(store.read("grain")).toEqual(before);
  });

  it("reports coherent-rehashed presentation forgery as INVALID_WORLD, not an internal error", () => {
    const directory = join(root(), "bundle");
    const compiled = changedBundle(grain(), undefined, (path, value) => {
      if (path !== "authoring/index.json") return value;
      const index = value as AuthoringIndex;
      return { ...index, notes: index.notes.map((note) => ({ ...note, name: "Forged label" })) };
    });
    writeChangedBundle(compiled, directory);
    const { store, call } = runtime(directory);
    expect(store.read("grain").base.snapshotDigest).toBe(compiled.snapshot.snapshotDigest);
    const response = call("workspace.economy.read", { workspaceId: "grain" });
    expect(response).toMatchObject({ outcome: "error", execution: "completed", operation: "workspace.economy.read", error: { code: "INVALID_WORLD", message: expect.stringMatching(/compiled input|correspondence/) } });
    expect(validateApiResponse(response).valid).toBe(true);
    expect(() => application.readSnapshotEconomy(directory)).toThrow(expect.objectContaining({ code: "INVALID_WORLD" }));
  });
});
