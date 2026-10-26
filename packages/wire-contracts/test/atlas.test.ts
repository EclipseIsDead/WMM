import { describe, expect, expectTypeOf, it } from "vitest";

import type { ApiOperationV1, ApiRequestV1, ApiResultByOperationV1, WorkspaceMapReadRequest, WorkspaceMapView, WorkspaceRequestV1, WorkspaceViewV1 } from "../src/index.js";
import * as wire from "../src/index.js";
import { mapResponse, mapView, referenceAtlas } from "./atlas-fixtures.js";

const request = {
  format: "wmm.request/1", apiVersion: "wmm/1", requestId: "map-read",
  operation: "workspace.map.read", payload: { workspaceId: "workspace:reference", atlasId: "overview", geometryVersion: "trace-1", atVersion: 1 },
} as const;

describe("reference atlas wire contract", () => {
  it("admits a separate opt-in map read without changing legacy workspace request/results", () => {
    expect(wire.validateApiRequest(request)).toEqual({ valid: true, errors: [] });
    expect(wire.validateApiContract(request).valid).toBe(true);
    expectTypeOf<WorkspaceMapReadRequest["operation"]>().toExtend<ApiOperationV1>();
    expectTypeOf<Extract<ApiRequestV1, { operation: "workspace.map.read" }>>().toEqualTypeOf<WorkspaceMapReadRequest>();
    expectTypeOf<Extract<WorkspaceRequestV1, { operation: "workspace.map.read" }>>().toEqualTypeOf<never>();
    expectTypeOf<ApiResultByOperationV1["workspace.map.read"]>().toEqualTypeOf<WorkspaceMapView>();
    expectTypeOf<ApiResultByOperationV1["workspace.read"]>().toEqualTypeOf<WorkspaceViewV1>();
  });

  it("admits bounded atlas records and explicit base-only map views through the discriminated API", () => {
    expect(wire).toHaveProperty("validateAtlas");
    expect(wire.validateAtlas(referenceAtlas())).toEqual({ valid: true, errors: [] });
    expect(wire.validateWorkspaceMapView(mapView()).valid).toBe(true);
    expect(wire.validateWorkspaceMapView(mapView(null)).valid).toBe(true);
    expect(wire.validateApiResponse(mapResponse()).valid).toBe(true);
    expect(wire.validateApiContract(mapResponse()).valid).toBe(true);
    expect(wire.validateApiResponse({ ...mapResponse() as object, operation: "workspace.read" }).valid).toBe(false);
    expect(wire.atlasSchema).toMatchObject({ $id: "urn:wmm:atlas:v1" });
  });

  it("caps aggregate vertices and exact UTF-8 atlas size even inside API responses", () => {
    const atlas = referenceAtlas();
    const geometry = { kind: "polygon", vertices: Array.from({ length: 256 }, () => [1, 1]) };
    const atLimit = { ...atlas, features: [], physicalCoverage: Array.from({ length: 16 }, () => ({ surface: "land", geometry })) };
    expect(wire.validateAtlas(atLimit).valid).toBe(true); // Geometry semantics are a separate core boundary.
    const over = { ...atLimit, physicalCoverage: [...atLimit.physicalCoverage, atLimit.physicalCoverage[0]] };
    expect(wire.validateAtlas(over).valid).toBe(false);
    const bytes = { ...atlas, features: Array.from({ length: 64 }, (_, i) => ({ ...atlas.features[0]!, id: `feature-${i}`, locator: "🌊".repeat(4096) })) };
    expect(wire.validateAtlas(bytes).valid).toBe(false);
    expect(wire.validateApiResponse(mapResponse({ ...mapView(), atlas: bytes })).valid).toBe(false);
    expect(wire.MAX_ATLAS_BYTES).toBe(1_048_576);
    expect(wire.MAX_ATLASES_PER_WORLD).toBe(8);
  });

  it("requires atlas presence and its manifest digest together", () => {
    expect(wire.validateWorkspaceMapView({ ...mapView(), atlasDigest: null }).valid).toBe(false);
    expect(wire.validateWorkspaceMapView({ ...mapView(null), atlasDigest: "b".repeat(64) }).valid).toBe(false);
  });

  it("closes map requests against paths, projection controls, and unsupported authority", () => {
    expect(wire.validateApiRequest({ ...request, payload: { workspaceId: "workspace:reference" } }).valid).toBe(true);
    for (const field of ["bundlePath", "path", "scope", "temporal", "candidate", "viewport", "principal", "approval", "force"]) {
      expect(wire.validateApiRequest({ ...request, [field]: true }).valid, field).toBe(false);
      expect(wire.validateApiRequest({ ...request, payload: { ...request.payload, [field]: true } }).valid, field).toBe(false);
    }
    for (const payload of [{ ...request.payload, atlasId: "../map" }, { ...request.payload, geometryVersion: "Trace 1" }, { ...request.payload, atVersion: 0 }, { ...request.payload, atVersion: 1.5 }]) {
      expect(wire.validateApiRequest({ ...request, payload }).valid).toBe(false);
    }
  });

  it("rejects unsupported geometry, controls, noninteger coordinates, and implicit anchors", () => {
    const atlas = referenceAtlas();
    const feature = atlas.features[0]!;
    for (const input of [
      { ...atlas, controllerId: "faction:any" }, { ...atlas, id: "overview\n" }, { ...atlas, title: "Unsafe\u001b[1m" }, { ...atlas, title: "Unsafe\u202e" },
      { ...atlas, worldId: "world:atlas_test\n" }, { ...atlas, provenance: { ...atlas.provenance, sourceId: "source:map\n" } },
      { ...atlas, features: [{ ...feature, anchor: [1.5, 0] }] }, { ...atlas, features: [{ ...feature, anchor: [1_000_001, 0] }] },
      { ...atlas, features: [{ ...feature, label: "\ud800" }] }, { ...atlas, features: [{ ...feature, entityId: "place:harbor\n" }] },
      { ...atlas, features: [{ ...feature, geometry: { kind: "line", vertices: [[0, 0], [1, 1]] } }] },
      { ...atlas, features: [{ ...feature, geometry: { ...feature.geometry, holes: [] } }] },
      { ...atlas, features: [{ ...feature, anchor: undefined }] },
    ]) expect(wire.validateAtlas(input).valid).toBe(false);
    for (const change of [{ worldBasis: "candidate" }, { selectedProposalsIncluded: true }, { factProjection: "projected" }, { candidateView: "available" }, { scope: {} }]) {
      expect(wire.validateWorkspaceMapView({ ...mapView(), ...change }).valid).toBe(false);
    }
    let calls = 0;
    const getter = Object.defineProperty(atlas, "title", { enumerable: true, get: () => { calls += 1; return "unsafe"; } });
    expect(wire.validateAtlas(getter).valid).toBe(false);
    expect(wire.validateAtlas(new Proxy({}, { ownKeys: () => { calls += 1; return []; } })).valid).toBe(false);
    expect(calls).toBe(0);
  });
});
