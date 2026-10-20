import { readFileSync } from "node:fs";

import {
  assertionId,
  canonicalJsonBytes,
  populationRosterDigest,
  sha256Hex,
  snapshotDigest,
} from "@wmm/canonical";
import type {
  ApiRequestV1,
  AssertionRecordV1,
  ClaimBodyV1,
  DescriptorRecordV1,
  SemanticDefinitionV1,
  RosterV1,
  SnapshotRecordV1,
  SourceRecordV1,
  SupportRecordV1,
  WorldCatalogV1,
} from "@wmm/wire-contracts";
import { validateWorldSemantics } from "../src/world-validation.js";

export type AbsenceRequest = Extract<ApiRequestV1, { readonly operation: "absence.query" }>;
const root = new URL("../../../fixtures/v1/complete-world/", import.meta.url);
const parse = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
export const originalSnapshot = parse<SnapshotRecordV1>("snapshot.json");
const world = parse<WorldCatalogV1>("payload/world.json");
const originalAssertions = world.assertionIds.map((id) =>
  parse<AssertionRecordV1>(`payload/records/assertions/${id.slice(5)}.json`),
);
const descriptors = world.descriptorIds.map((id) =>
  parse<DescriptorRecordV1>(`payload/records/descriptors/${id.replace(":", "/")}.json`),
);
const originalRosters = originalSnapshot.manifest.files
  .filter((entry) => entry.path.startsWith("rosters/"))
  .map((entry) => parse<RosterV1>(`payload/${entry.path}`));
const sources = world.sourceIds.map((id) =>
  parse<SourceRecordV1>(`payload/records/sources/${id.slice(7)}.json`),
);
const supports = world.supportIds.map((id) =>
  parse<SupportRecordV1>(`payload/records/supports/${id.slice(4)}.json`),
);
export const definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>> = Object.fromEntries(
  originalSnapshot.manifest.files
    .filter((entry) => entry.path.startsWith("types/"))
    .map((entry) => [entry.path.slice(6, -5), parse<SemanticDefinitionV1>(`payload/${entry.path}`)] as const)
    .filter((entry) => entry[1].format === "wmm.semantic-definition/1"),
);
export const request = JSON.parse(readFileSync(
  new URL("../../../fixtures/v2/absence-request.json", import.meta.url), "utf8",
)) as AbsenceRequest;

export function operation(assertion: AssertionRecordV1): string | undefined {
  const proposition = assertion.body.proposition;
  return proposition.kind === "atom"
    ? definitionsByDigest[proposition.predicateDefinitionDigest]?.operation : undefined;
}

export function findAssertion(
  predicate: (assertion: AssertionRecordV1) => boolean,
): AssertionRecordV1 {
  const assertion = originalAssertions.find(predicate);
  if (assertion === undefined) throw new Error("Missing assertion fixture");
  return assertion;
}

export function record(body: ClaimBodyV1): AssertionRecordV1 {
  return { format: "wmm.assertion-record/1", id: assertionId(body), body };
}

export function buildSnapshot(options: {
  readonly deactivate?: readonly string[];
  readonly activate?: readonly AssertionRecordV1[];
  readonly descriptors?: readonly DescriptorRecordV1[];
  readonly rosters?: readonly RosterV1[];
  readonly activeSupportIds?: readonly string[];
} = {}) {
  const assertions = [...new Map([
    ...originalAssertions,
    ...(options.activate ?? []),
  ].map((assertion) => [assertion.id, assertion])).values()];
  const allDescriptors = [...descriptors, ...(options.descriptors ?? [])];
  const rosters = (options.rosters ?? originalRosters)
    .map((body) => ({ digest: populationRosterDigest(body), body }))
    .sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
  const deactivated = new Set(options.deactivate ?? []);
  const catalog: WorldCatalogV1 = {
    ...world,
    activeSupportIds: [...(options.activeSupportIds ?? world.activeSupportIds)].sort(),
    descriptorIds: allDescriptors.map((descriptor) => descriptor.id).sort(),
    assertionIds: assertions.map((assertion) => assertion.id).sort(),
    activeAssertionIds: [...new Set([
      ...world.activeAssertionIds,
      ...(options.activate ?? []).map((assertion) => assertion.id),
    ])].filter((id) => !deactivated.has(id)).sort(),
  };
  validateWorldSemantics({
    world: catalog, definitionsByDigest, descriptors: allDescriptors,
    sources, assertions, supports, rosters,
  });

  // Rebuild identities for every changed payload, rather than mutating records
  // under the fixture's original snapshot identity.
  const files = new Map(originalSnapshot.manifest.files
    .filter((entry) => !entry.path.startsWith("rosters/"))
    .map((entry) => [entry.path, entry]));
  function setJson(path: string, value: unknown): void {
    const bytes = canonicalJsonBytes(value as Parameters<typeof canonicalJsonBytes>[0]);
    files.set(path, {
      path, mediaType: "application/json", byteLength: String(bytes.length), sha256: sha256Hex(bytes),
    });
  }
  setJson("world.json", catalog);
  for (const { digest, body } of rosters) setJson(`rosters/${digest}.json`, body);
  for (const assertion of assertions) setJson(`records/assertions/${assertion.id.slice(5)}.json`, assertion);
  for (const descriptor of allDescriptors) setJson(`records/descriptors/${descriptor.id.replace(":", "/")}.json`, descriptor);
  const manifest = {
    ...originalSnapshot.manifest,
    files: [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  return {
    worldId: world.worldId,
    snapshotDigest: snapshotDigest(manifest),
    activeAssertionIds: catalog.activeAssertionIds,
    assertions,
    descriptors: allDescriptors,
    rosters,
    definitionsByDigest,
  };
}
