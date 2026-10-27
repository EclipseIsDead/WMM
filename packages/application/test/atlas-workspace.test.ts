import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateApiResponse } from "@wmm/wire-contracts";
import type { AuthoringProject } from "@wmm/wire-contracts";
import { buildAuthoringBundle } from "@wmm/exchange";
import { SqliteWorkspaceStore } from "../../store-authoring-sqlite/dist/index.js";
import { executeApiRequest, WorkspaceApplication } from "../src/index.js";
import { readWorkspaceAtlas } from "../src/atlas.js";

const roots: string[] = [];
const stores: SqliteWorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function runtime() {
  const root = mkdtempSync(join(tmpdir(), "wmm-atlas-app-")); roots.push(root);
  const store = new SqliteWorkspaceStore(join(root, "authoring.sqlite")); stores.push(store);
  return { root, store, services: { workspaces: new WorkspaceApplication(store) } };
}

describe("captured-base reference atlas API", () => {
  it("reads exact captured atlas bytes after source loss, excluding selected proposals and preserving review/history", () => {
    const { root, store, services } = runtime();
    const input = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/atlas-project.json", import.meta.url), "utf8")) as AuthoringProject;
    const directory = join(root, "bundle"); buildAuthoringBundle(input, directory);
    const call = (operation: string, payload: unknown) => executeApiRequest({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "fixed-atlas-request", operation, payload }, services);
    expect(call("workspace.create", { workspaceId: "atlas", bundlePath: directory, title: "Reference atlas", goal: "Read only", mode: "world", idempotencyKey: "create" }).outcome).toBe("success");
    expect(call("workspace.mutate", { workspaceId: "atlas", expectedVersion: 1, idempotencyKey: "draft", action: { kind: "put-proposal", proposal: {
      id: "transfer", title: "Transfer the city", author: "Synthetic author", rationale: "An explicit proposed transfer, not a geographic fact", dependencies: [], exclusions: [],
      operations: [{ kind: "write-prose", path: "prose/proposed-transfer.md", text: "A proposed transfer of city control.", beforeSha256: null }],
    } } }).outcome).toBe("success");
    expect(call("workspace.mutate", { workspaceId: "atlas", expectedVersion: 2, idempotencyKey: "select", action: { kind: "decide", groupId: "transfer", decision: "selected" } }).outcome).toBe("success");
    expect(call("workspace.review", { workspaceId: "atlas", expectedVersion: 3 }).outcome).toBe("success");
    const before = store.read("atlas"), review = store.readReview("atlas");
    const response = call("workspace.map.read", { workspaceId: "atlas", atlasId: "reference_demo", geometryVersion: "reference_v1" });
    expect(response).toMatchObject({ outcome: "success", resolved: before.base, data: {
      workspaceVersion: 3, worldBasis: "base", selectedProposalsIncluded: false, factProjection: "not-run", candidateView: "unavailable", atlas: input.atlases![0],
    } });
    expect(validateApiResponse(response).valid).toBe(true);
    const snapshot = readFileSync(join(directory, "snapshot.json"));
    renameSync(directory, join(root, "moved-source"));
    expect(call("workspace.map.read", { workspaceId: "atlas", atlasId: "reference_demo", geometryVersion: "reference_v1" })).toEqual(response);
    expect(readFileSync(join(root, "moved-source/snapshot.json"))).toEqual(snapshot);
    expect(call("workspace.map.read", { workspaceId: "atlas", atVersion: 1 })).toMatchObject({ outcome: "success", data: { workspaceVersion: 1, atlas: input.atlases![0] } });
    expect(store.read("atlas")).toEqual(before);
    expect(store.readReview("atlas")).toEqual(review);
    const base = store.readBase("atlas");
    expect(() => readWorkspaceAtlas(before, { ...base, documents: base.documents.map((document) => document.path.startsWith("maps/") ? { ...document, base64: Buffer.from("{}").toString("base64") } : document) }, { workspaceId: "atlas" })).toThrow(/pinned manifest/);
    for (const payload of [{ workspaceId: "atlas", atlasId: "missing" }, { workspaceId: "atlas", geometryVersion: "not_the_reference" }]) {
      expect(call("workspace.map.read", payload)).toMatchObject({ outcome: "error", execution: "completed", error: { code: "UNKNOWN_RECORD" } });
    }
    for (const payload of [{ workspaceId: "atlas", candidate: true }, { workspaceId: "atlas", bundlePath: directory }, { workspaceId: "atlas", temporal: {} }]) {
      expect(call("workspace.map.read", payload)).toMatchObject({ outcome: "error", error: { code: "INVALID_REQUEST" } });
    }
    expect(store.read("atlas")).toEqual(before);
    expect(store.readReview("atlas")).toEqual(review);
  });

  it("reports an honest empty atlas for a legacy captured world without changing its workspace", () => {
    const { store, services } = runtime();
    const created = executeApiRequest({
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "atlas-create", operation: "workspace.create",
      payload: { workspaceId: "atlas", bundlePath: fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url)), title: "Atlas test", goal: "Inspect only", mode: "world", idempotencyKey: "create-atlas" },
    }, services);
    expect(created.outcome).toBe("success");
    const before = store.read("atlas");
    const response = executeApiRequest({
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "atlas-read", operation: "workspace.map.read", payload: { workspaceId: "atlas" },
    }, services);
    expect(response, JSON.stringify(response)).toMatchObject({
      outcome: "success", operation: "workspace.map.read", execution: "completed", resolved: before.base,
      data: { format: "wmm.workspace-map-view/1", workspaceId: "atlas", workspaceVersion: before.version, base: before.base,
        worldBasis: "base", selectedProposalsIncluded: false, factProjection: "not-run", candidateView: "unavailable", atlas: null, atlasDigest: null, availableAtlases: [] },
    });
    expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
    expect(store.read("atlas")).toEqual(before);
    expect(store.readReview("atlas")).toBeUndefined();
  });
});
