import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import type { Atlas, EconomyView } from "../src/index.js";
import { validateApiContract, validateApiResponse, validateAtlas, validateAuthoringProject, validateEconomyView, validateWorkspaceEconomyView, validateWorkspaceMapView } from "../src/index.js";
import { mapResponse, mapView, referenceAtlas } from "./atlas-fixtures.js";
import { workspaceEconomyResponse, workspaceEconomyView } from "./workspace-economy-fixtures.js";

const economyAdmissions = [
  { name: "economy", validate: validateEconomyView, wrap: (economy: EconomyView) => economy, path: "" },
  { name: "workspace economy", validate: validateWorkspaceEconomyView, wrap: (economy: EconomyView) => ({ ...workspaceEconomyView(), economy }), path: "/economy" },
  { name: "API response", validate: validateApiResponse, wrap: (economy: EconomyView) => workspaceEconomyResponse({ ...workspaceEconomyView(), economy }), path: "/data/economy" },
  { name: "API contract", validate: validateApiContract, wrap: (economy: EconomyView) => workspaceEconomyResponse({ ...workspaceEconomyView(), economy }), path: "/data/economy" },
] as const;

const atlasAdmissions = [
  { name: "atlas", validate: validateAtlas, wrap: (atlas: Atlas) => atlas, path: "" },
  { name: "authoring project", validate: validateAuthoringProject, wrap: (atlas: Atlas) => ({ format: "wmm.authoring-project/1", worldId: atlas.worldId, title: "Synthetic atlas", sources: [], entities: [], facts: [], campaigns: [], atlases: [atlas] }), path: "/atlases/0" },
  { name: "workspace map", validate: validateWorkspaceMapView, wrap: (atlas: Atlas) => mapView(atlas), path: "/atlas" },
  { name: "map API response", validate: validateApiResponse, wrap: (atlas: Atlas) => mapResponse(mapView(atlas)), path: "/data/atlas" },
  { name: "map API contract", validate: validateApiContract, wrap: (atlas: Atlas) => mapResponse(mapView(atlas)), path: "/data/atlas" },
] as const;
const atlasArrayAdmissions = atlasAdmissions.flatMap((admission) =>
  (["physicalCoverage", "features"] as const).map((field) => ({ ...admission, field })),
);

function economyView(): EconomyView {
  return {
    ...workspaceEconomyView().economy,
    records: [{
      assertionId: `asrt:${"d".repeat(64)}`, subjectId: "place:grain",
      scope: { account: { kind: "ref", id: "account:setting" }, jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "notApplicable" } },
      value: {
        id: "opening", kind: "stock-observation", resourceId: "item:grain",
        quantity: { unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator: "3", denominator: "1" } } },
        description: "Synthetic opening report", reference: { kind: "unknown" },
        method: { kind: "unknown" }, boundary: { kind: "unknown" },
        coverage: { kind: "partial", description: "Only the declared store" }, citations: [],
        status: "observed", owner: { kind: "unknown" }, custodian: { kind: "unknown" },
        location: { kind: "unknown" }, availableUse: { kind: "unknown" },
      },
    }],
  };
}

function vertexAtlas(field: "physicalCoverage" | "features", count: number): Atlas {
  const atlas = referenceAtlas();
  const geometry = { kind: "polygon" as const, vertices: Array.from({ length: 256 }, () => [1, 1] as const) };
  return {
    ...atlas,
    physicalCoverage: field === "physicalCoverage" ? Array.from({ length: count }, () => ({ surface: "land" as const, geometry })) : [],
    features: field === "features" ? Array.from({ length: count }, (_, index) => ({ ...atlas.features[0]!, id: `feature-${index}`, geometry })) : [],
  };
}

describe("detached plain-data wire admission", () => {
  it.each(economyAdmissions)("$name admits indexed records without reading an inherited toJSON getter", ({ validate, wrap }) => {
    const view = economyView();
    expect(validate(wrap(view))).toEqual({ valid: true, errors: [] });
    const before = JSON.stringify(view);
    const records = [...view.records];
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      toJSON: { get: () => { calls += 1; throw new Error("Inherited toJSON getter executed"); } },
    }) as object;
    Object.setPrototypeOf(records, prototype);
    Object.freeze(records);
    const input = Object.freeze({ ...view, records });
    const descriptors = Object.getOwnPropertyDescriptors(records);

    expect(validate(wrap(input))).toEqual({ valid: true, errors: [] });
    expect(calls).toBe(0);
    expect(input.records).toBe(records);
    expect(Object.getPrototypeOf(records)).toBe(prototype);
    expect(records[0]).toBe(view.records[0]);
    expect(Object.getOwnPropertyDescriptors(records)).toEqual(descriptors);
    expect(JSON.stringify(structuredClone(input))).toBe(before);
  });

  it.each(economyAdmissions)("$name counts oversized indexed records instead of an inherited toJSON result", ({ validate, wrap, path }) => {
    const view = economyView();
    const record = view.records[0]!;
    const largeRecord = { ...record, value: { ...record.value, description: "x".repeat(60_000) } };
    expect(validate(wrap({ ...view, records: [largeRecord] }))).toEqual({ valid: true, errors: [] });
    const records = Array.from({ length: 20 }, (_, index) => ({
      ...largeRecord, assertionId: `asrt:${String(index).padStart(64, "0")}`,
      value: { ...largeRecord.value, id: `opening-${index}` },
    }));
    const input = { ...view, records };
    const before = JSON.stringify(input);
    expect(Buffer.byteLength(before, "utf8")).toBeGreaterThan(1_048_576);
    expect(validateEconomyView(input).errors.map((error) => error.keyword)).toEqual(["maxJsonBytes"]);
    const expected = validate(wrap(input));
    expect(expected.valid).toBe(false);
    expect(expected.errors).toContainEqual(expect.objectContaining({ keyword: "maxJsonBytes", instancePath: path }));
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      toJSON: { value: () => { calls += 1; return []; } },
    }) as object;
    Object.setPrototypeOf(records, prototype);

    expect(validate(wrap(input))).toEqual(expected);
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(records)).toBe(prototype);
    expect(records.length).toBe(20);
    expect(JSON.stringify(structuredClone(input))).toBe(before);
  });

  it.each(economyAdmissions)("$name counts oversized limitations instead of an inherited toJSON result", ({ validate, wrap, path }) => {
    const view = workspaceEconomyView().economy;
    const text = "x".repeat(65_536);
    expect(validate(wrap({ ...view, limitations: [text] }))).toEqual({ valid: true, errors: [] });
    const limitations = Array.from({ length: 20 }, () => text);
    const input = { ...view, limitations };
    const before = JSON.stringify(input);
    expect(Buffer.byteLength(before, "utf8")).toBeGreaterThan(1_048_576);
    expect(validateEconomyView(input).errors.map((error) => error.keyword)).toEqual(["maxJsonBytes"]);
    const expected = validate(wrap(input));
    expect(expected.valid).toBe(false);
    expect(expected.errors).toContainEqual(expect.objectContaining({ keyword: "maxJsonBytes", instancePath: path }));
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      toJSON: { value: () => { calls += 1; return []; } },
    }) as object;
    Object.setPrototypeOf(limitations, prototype);

    expect(validate(wrap(input))).toEqual(expected);
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(limitations)).toBe(prototype);
    expect(JSON.stringify(structuredClone(input))).toBe(before);
  });

  it.each(atlasArrayAdmissions)("$name admits indexed $field without reading an inherited iterator getter", ({ validate, wrap, field }) => {
    const atlas = referenceAtlas();
    expect(validate(wrap(atlas))).toEqual({ valid: true, errors: [] });
    const before = JSON.stringify(atlas);
    const records = atlas[field];
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      [Symbol.iterator]: { get: () => { calls += 1; throw new Error("Inherited iterator getter executed"); } },
    }) as object;
    Object.setPrototypeOf(records, prototype);

    expect(validate(wrap(atlas))).toEqual({ valid: true, errors: [] });
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(records)).toBe(prototype);
    expect(JSON.stringify(structuredClone(atlas))).toBe(before);
  });

  it.each(atlasArrayAdmissions)("$name counts $field vertices instead of an inherited empty iterator", ({ validate, wrap, field, path }) => {
    // Shape/resource admission only: the existing geometry semantics are unchanged.
    expect(validate(wrap(vertexAtlas(field, 16)))).toEqual({ valid: true, errors: [] });
    const atlas = vertexAtlas(field, 17);
    expect(validateAtlas(atlas).errors.map((error) => error.keyword)).toEqual(["maxAtlasVertices"]);
    const expected = validate(wrap(atlas));
    expect(expected.valid).toBe(false);
    expect(expected.errors).toContainEqual(expect.objectContaining({ keyword: "maxAtlasVertices", instancePath: path }));
    const before = JSON.stringify(atlas);
    const records = atlas[field];
    let calls = 0;
    const prototype = Object.create(Array.prototype, {
      [Symbol.iterator]: { value: () => { calls += 1; return [][Symbol.iterator](); } },
    }) as object;
    Object.setPrototypeOf(records, prototype);

    expect(validate(wrap(atlas))).toEqual(expected);
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(records)).toBe(prototype);
    expect(records.length).toBe(17);
    expect(JSON.stringify(structuredClone(atlas))).toBe(before);
  });
});
