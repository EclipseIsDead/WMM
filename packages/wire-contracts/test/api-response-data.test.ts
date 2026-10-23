import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  AbsenceQueryResultV1,
  ApiOperationV1,
  ApiRequestV1,
  ApiResultByOperationV1,
  ClaimQueryResultV1,
  IntervalAbsenceResultV1,
  SemanticDefinitionV1,
  RosterV1,
  SemanticProfileV1,
  SnapshotRecordV1,
  WorldExportV1,
  WorldRecordV1,
} from "../src/index.js";
import { validateApiResponse } from "../src/index.js";
import { workspaceReviewedView, workspaceView } from "./workspace-fixtures.js";

const fixtureRoot = new URL("../../../fixtures/v1/complete-world/", import.meta.url);
function fixtureJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, fixtureRoot), "utf8")) as unknown;
}

const snapshot = fixtureJson("snapshot.json") as SnapshotRecordV1;
const records = snapshot.manifest.files
  .filter(({ path }) => path === "world.json" || path.startsWith("records/"))
  .map(({ path }) => fixtureJson(`payload/${path}`) as WorldRecordV1);
const world = records.find((record) => record.format === "wmm.world/1");
if (world === undefined) throw new Error("Missing world catalog fixture");
const semanticProfile = fixtureJson(
  `payload/types/${world.semanticProfileDigest}.json`,
) as SemanticProfileV1;
const definitions = semanticProfile.definitions.map((digest) => ({
  digest,
  body: fixtureJson(`payload/types/${digest}.json`) as SemanticDefinitionV1,
}));
const definition = definitions[0]?.body;
if (definition === undefined) throw new Error("Missing semantic definition fixture");

const exported: WorldExportV1 = {
  format: "wmm.world-export/1",
  snapshotDigest: snapshot.snapshotDigest,
  world,
  semanticProfile,
  definitions,
  rosters: snapshot.manifest.files.filter(({ path }) => path.startsWith("rosters/"))
    .map(({ path }) => ({ digest: path.slice(8, -5), body: fixtureJson(`payload/${path}`) as RosterV1 })),
  descriptors: records.filter((record) => record.format === "wmm.descriptor/1"),
  sources: records.filter((record) => record.format === "wmm.source/1"),
  assertions: records.filter((record) => record.format === "wmm.assertion-record/1"),
  supports: records.filter((record) => record.format === "wmm.support-record/1"),
  documents: snapshot.manifest.files.filter(({ mediaType }) => mediaType !== "application/json"),
};

const absenceFixtures = JSON.parse(readFileSync(
  new URL("../../../fixtures/v2/absence-query-cases.json", import.meta.url),
  "utf8",
)) as {
  readonly requests: readonly {
    readonly request: Extract<ApiRequestV1, { readonly operation: "absence.query" }>;
  }[];
};
const absenceRequest = absenceFixtures.requests[0]?.request;
if (absenceRequest === undefined) throw new Error("Missing absence request fixture");
const { target, scope, temporal } = absenceRequest.payload;
const claims: ClaimQueryResultV1 = {
  format: "wmm.claim-query-result/1",
  scope,
  temporal,
  definite: [],
  possible: [],
  unresolved: [],
  excluded: [],
  scopeCoverage: "exhaustive",
};
const absence: AbsenceQueryResultV1 = {
  format: "wmm.absence-query-result/1",
  target,
  scope,
  temporal,
  conclusion: { status: "absence-not-established", bases: [] },
  declaration: {
    status: "not-recorded",
    definiteAssertionIds: [],
    possibleAssertionIds: [],
    unresolvedAssertionIds: [],
  },
  witnesses: {
    status: "none-recorded",
    existentialAssertionIds: [],
    possibleExistentialAssertionIds: [],
    unresolvedExistentialAssertionIds: [],
    candidateIds: [],
    possibleCandidateIds: [],
    unresolvedCandidateIds: [],
  },
  derivation: {
    format: "wmm.absence-evaluation-receipt/1",
    algorithm: "bundled-absence-point-v3",
    inputSelection: {
      format: "wmm.absence-input-selection/1",
      worldId: world.worldId,
      snapshotDigest: snapshot.snapshotDigest,
      target,
      scope,
      temporal,

      membershipAssertionIds: [],
    },
    inputSelectionDigest: "a".repeat(64),
    evaluationDigest: "b".repeat(64),
    positiveCoverageAssertionIds: [],
    negativeCoverageAssertionIds: [],
    staleCoverageAssertionIds: [],
    coverageChecks: [],
    selectedCoverageAssertionId: null,
    premiseAssertionIds: [],
    eligibilityAssertionIds: [],
    candidates: [],
    status: "not-established",
    reason: "coverage-not-established",
  },
};
const interval: IntervalAbsenceResultV1 = {
  format: "wmm.interval-absence-result/1",
  algorithm: "bundled-absence-throughout-v1",
  worldId: world.worldId,
  snapshotDigest: snapshot.snapshotDigest,
  target,
  scope,
  temporal: {
    format: "wmm.temporal-query/1",
    mode: "throughout",
    axisDefinitionDigest: temporal.axisDefinitionDigest,
    start: temporal.position,
    endExclusive: "1006",
  },
  limits: { maxCells: 256, maxWorkUnits: 2_000_000 },
  execution: "completed",
  status: "not-established",
  reason: "cell-not-established",
  breakpoints: [temporal.position, "1006"],
  constancyDeclarations: [],
  partitionIssues: [],
  cells: [{
    start: temporal.position,
    endExclusive: "1006",
    representativePosition: temporal.position,
    evaluation: absence,
  }],
  evaluationDigest: "c".repeat(64),
};
const results = {
  "world.validate": {
    status: "valid",
    worldId: world.worldId,
    snapshotDigest: snapshot.snapshotDigest,
    files: snapshot.manifest.files.length,
    descriptors: exported.descriptors.length,
    sources: exported.sources.length,
    assertions: exported.assertions.length,
    activeAssertions: world.activeAssertionIds.length,
    supports: exported.supports.length,
    activeSupports: world.activeSupportIds.length,
  },
  "record.inspect": world,
  "world.export": exported,
  "claims.query": claims,
  "absence.query": absence,
  "absence.proveThroughout": interval,
  "workspace.create": workspaceView,
  "workspace.read": workspaceView,
  "workspace.review": workspaceReviewedView,
  "workspace.mutate": workspaceView,
} satisfies ApiResultByOperationV1;
const operations = Object.keys(results) as ApiOperationV1[];

function response(operation: ApiOperationV1, data: unknown): unknown {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId: "schema-test",
    operation,
    outcome: "success",
    execution: "completed",
    resolved: { worldId: snapshot.manifest.worldId, snapshotDigest: snapshot.snapshotDigest },
    data,
    diagnostics: [],
  };
}

function expectValid(operation: ApiOperationV1, data: unknown): void {
  expect(validateApiResponse(response(operation, data))).toEqual({ valid: true, errors: [] });
}
function expectInvalid(operation: ApiOperationV1, data: unknown): void {
  expect(validateApiResponse(response(operation, data)).valid).toBe(false);
}

function without(value: object, key: string): object {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

describe("operation-specific API response data", () => {
  it.each(operations)("accepts %s data only for operations with its result contract", (operation) => {
    expectValid(operation, results[operation]);
    for (const other of operations) {
      if (operation.startsWith("workspace.") && other.startsWith("workspace.")) {
        expectValid(other, results[operation]);
      } else if (other !== operation) {
        expectInvalid(other, results[operation]);
      }
    }
  });

  it.each(operations)("rejects null, scalar, array, and arbitrary %s data", (operation) => {
    for (const data of [null, false, 1, "data", [], {}, { arbitrary: true }]) {
      expectInvalid(operation, data);
    }
  });

  it("requires a complete, closed validation report with nonnegative integer counts", () => {
    const report = results["world.validate"];
    for (const key of Object.keys(report)) {
      expectInvalid("world.validate", without(report, key));
    }
    expectInvalid("world.validate", { ...report, extra: true });
    expectInvalid("world.validate", { ...report, status: "invalid" });
    expectInvalid("world.validate", { ...report, snapshotDigest: "bad-digest" });
    for (const key of [
      "files", "descriptors", "sources", "assertions", "activeAssertions", "supports", "activeSupports",
    ]) {
      for (const value of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        expectInvalid("world.validate", { ...report, [key]: value });
      }
    }
  });

  it("inspects every world record kind and closed semantic definition/profile shapes", () => {
    for (const record of [...records, snapshot, semanticProfile, ...definitions.map(({ body }) => body), ...exported.rosters.map(({ body }) => body)]) {
      expectValid("record.inspect", record);
      expectInvalid("record.inspect", { ...record, extra: true });
    }
    expectValid("record.inspect", {
      ...definition,
      operation: "population-coverage-basis-v1",
    });
    for (const key of ["format", "key", "kind", "operation", "version", "dependencies"]) {
      expectInvalid("record.inspect", without(definition, key));
    }
    for (const patch of [
      { key: "Invalid key" },
      { kind: "unknown" },
      { operation: "unknown-v1" },
      { version: "01" },
      { dependencies: ["bad-digest"] },
      { dependencies: ["a".repeat(64), "a".repeat(64)] },
      { fixtureOnly: "true" },
    ]) {
      expectInvalid("record.inspect", { ...definition, ...patch });
    }
    for (const key of ["format", "version", "definitions", "numericProfile", "propositionGrammar"]) {
      expectInvalid("record.inspect", without(semanticProfile, key));
    }
    for (const patch of [
      { version: "01" },
      { definitions: [] },
      { definitions: ["bad-digest"] },
      { definitions: ["a".repeat(64), "a".repeat(64)] },
      { numericProfile: "float-v1" },
      { propositionGrammar: "unknown-v1" },
      { fixtureOnly: "true" },
    ]) {
      expectInvalid("record.inspect", { ...semanticProfile, ...patch });
    }
  });

  it("requires a closed export with correctly typed records and metadata-only documents", () => {
    for (const key of Object.keys(exported)) {
      expectInvalid("world.export", without(exported, key));
    }
    expectInvalid("world.export", { ...exported, extra: true });
    for (const key of ["descriptors", "sources", "assertions", "supports", "rosters"]) {
      expectInvalid("world.export", { ...exported, [key]: [world] });
    }
    expectInvalid("world.export", { ...exported, world: semanticProfile });
    expectInvalid("world.export", { ...exported, semanticProfile: definition });
    expectInvalid("world.export", {
      ...exported, definitions: [{ digest: "bad-digest", body: definition }],
    });
    expectInvalid("world.export", {
      ...exported, definitions: [{ digest: "a".repeat(64), body: { ...definition, extra: true } }],
    });
    expectInvalid("world.export", {
      ...exported, definitions: [{ digest: "a".repeat(64), body: definition, extra: true }],
    });
    const document = {
      path: "documents/example.md",
      mediaType: "text/markdown",
      sha256: "a".repeat(64),
      byteLength: "0",
    };
    expectValid("world.export", { ...exported, documents: [document] });
    for (const patch of [
      { path: "../example.md" },
      { mediaType: "unknown" },
      { sha256: "bad-digest" },
      { byteLength: 0 },
      { byteLength: "01" },
      { bytes: [1, 2, 3] },
    ]) {
      expectInvalid("world.export", { ...exported, documents: [{ ...document, ...patch }] });
    }
  });

  it("uses the full claims and absence result schemas, including nested constraints", () => {
    expectInvalid("claims.query", { ...claims, scopeCoverage: "partial" });
    expectInvalid("claims.query", { ...claims, definite: [{ assertionId: "bad-id" }] });
    expectInvalid("claims.query", { ...claims, extra: true });
    expectInvalid("absence.query", { ...absence, extra: true });
    expectInvalid("absence.query", {
      ...absence, conclusion: { status: "absence-derived", bases: [] },
    });
    expectInvalid("absence.query", {
      ...absence,
      derivation: { ...absence.derivation, status: "established", reason: "unsupported-semantics" },
    });
  });
});
