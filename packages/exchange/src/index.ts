export * from "./world-bundle.js";
export { buildAuthoringBundle } from "./authoring.js";
export * from "./dm-notes.js";
export * from "./entity-context.js";
export * from "./actor.js";

import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertionId,
  canonicalJsonBytes,
  semanticDefinitionDigest,
  semanticProfileDigest,
  sha256Hex,
  snapshotDigest,
} from "@wmm/canonical";
import { admitSemanticProfile } from "@wmm/core";
import {
  type ClaimBodyV1,
  type JsonValue,
  type SemanticDefinitionV1,
  type SemanticProfileV1,
  type SnapshotManifestV1,
  validateCoreContract,
} from "@wmm/wire-contracts";

interface SeedAssertionRecord {
  readonly id: string;
  readonly body: ClaimBodyV1;
}

interface SeedWorldIndex {
  readonly format: "wmm.world-fixture/1";
  readonly worldId: string;
  readonly semanticProfileDigest: string;
  readonly activeAssertionIds: readonly string[];
}

interface SeedVectorDocument {
  readonly vectors: readonly {
    readonly name: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly expectedId: string;
  }[];
}

export interface SeedFixtureDiagnostic {
  readonly code: "SEED_FIXTURE_INCOMPLETE";
  readonly severity: "warning";
  readonly message: string;
  readonly unresolvedRecordIds: readonly string[];
}

export interface LoadedSeedFixture {
  readonly format: "wmm.loaded-seed-fixture/1";
  readonly snapshotDigest: string;
  readonly manifest: SnapshotManifestV1;
  readonly world: SeedWorldIndex;
  readonly semanticProfile: {
    readonly digest: string;
    readonly body: SemanticProfileV1;
  };
  readonly definitions: readonly {
    readonly digest: string;
    readonly body: SemanticDefinitionV1;
  }[];
  readonly assertions: readonly SeedAssertionRecord[];
  readonly documents: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly text: string;
  }[];
  readonly diagnostics: readonly SeedFixtureDiagnostic[];
}

export interface SeedFixtureValidationReport {
  readonly status: "valid-seed-fixture";
  readonly snapshotDigest: string;
  readonly files: number;
  readonly definitions: number;
  readonly assertions: number;
  readonly documents: number;
  readonly diagnostics: readonly SeedFixtureDiagnostic[];
}

function listPayloadFiles(root: string, directory = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Seed fixture contains a symlink: ${entry.name}`);
    if (stat.isDirectory()) {
      result.push(...listPayloadFiles(root, absolute));
    } else if (stat.isFile()) {
      result.push(relative(root, absolute).split(sep).join("/"));
    } else {
      throw new Error(`Seed fixture contains a non-regular entry: ${entry.name}`);
    }
  }
  return result.sort();
}

function parseCanonicalJson(bytes: Uint8Array, path: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const canonical = canonicalJsonBytes(parsed as JsonValue);
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    throw new Error(`JSON payload is not canonical or contains duplicate information: ${path}`);
  }
  return parsed;
}

function assertSeedWorld(input: unknown): asserts input is SeedWorldIndex {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Seed world index must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    value["format"] !== "wmm.world-fixture/1" ||
    typeof value["worldId"] !== "string" ||
    typeof value["semanticProfileDigest"] !== "string" ||
    !Array.isArray(value["activeAssertionIds"]) ||
    !value["activeAssertionIds"].every((id) => typeof id === "string")
  ) {
    throw new Error("Seed world index has an invalid shape");
  }
  const keys = Object.keys(value).sort();
  if (!isDeepStrictEqual(keys, ["activeAssertionIds", "format", "semanticProfileDigest", "worldId"])) {
    throw new Error("Seed world index contains unknown fields");
  }
  const active = value["activeAssertionIds"] as string[];
  for (let index = 1; index < active.length; index += 1) {
    if ((active[index - 1] ?? "") >= (active[index] ?? "")) {
      throw new Error("Active assertion IDs must be strictly sorted");
    }
  }
}

function assertSeedAssertion(input: unknown): asserts input is SeedAssertionRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Seed assertion record must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value["id"] !== "string" || value["body"] === undefined) {
    throw new Error("Seed assertion record requires id and body");
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), ["body", "id"])) {
    throw new Error("Seed assertion record contains unknown fields");
  }
  const validation = validateCoreContract(value["body"]);
  if (!validation.valid) {
    throw new Error(`Seed assertion body is invalid: ${JSON.stringify(validation.errors)}`);
  }
  const computed = assertionId(value["body"] as ClaimBodyV1);
  if (computed !== value["id"]) {
    throw new Error(`Seed assertion ID mismatch: ${value["id"]}`);
  }
}

function referencedRecordIds(body: ClaimBodyV1): string[] {
  const ids = new Set<string>();
  if (body.proposition.kind === "atom") {
    ids.add(body.proposition.subjectId);
    if (body.proposition.value.kind === "ref") ids.add(body.proposition.value.id);
  } else {
    ids.add(body.proposition.population.descriptorId);
    for (const value of Object.values(body.proposition.criterion.arguments)) {
      if (value.kind === "ref") ids.add(value.id);
    }
  }
  for (const scopeValue of Object.values(body.scope)) {
    if (scopeValue.kind === "ref") ids.add(scopeValue.id);
  }
  return [...ids].sort();
}

function manifestFromVectors(kitRoot: string): SnapshotManifestV1 {
  const vectors = JSON.parse(
    readFileSync(resolve(kitRoot, "golden-vectors.json"), "utf8"),
  ) as SeedVectorDocument;
  const vector = vectors.vectors.find((candidate) => candidate.name === "snapshot_lf");
  if (vector === undefined) throw new Error("snapshot_lf vector is missing");
  const validation = validateCoreContract(vector.payload);
  if (!validation.valid) throw new Error("snapshot_lf manifest does not satisfy the core schema");
  const manifest = vector.payload as SnapshotManifestV1;
  if (snapshotDigest(manifest) !== vector.expectedId) {
    throw new Error("snapshot_lf digest does not match its vector identity");
  }
  return manifest;
}

export function loadSeedFixture(kitPath: string): LoadedSeedFixture {
  const kitRoot = resolve(kitPath);
  const payloadRoot = resolve(kitRoot, "fixture-payload");
  const manifest = manifestFromVectors(kitRoot);
  const actualPaths = listPayloadFiles(payloadRoot);
  const declaredPaths = manifest.files.map((entry) => entry.path);
  if (!isDeepStrictEqual(actualPaths, declaredPaths)) {
    throw new Error("Seed fixture payload files differ from the snapshot manifest");
  }

  const parsedFiles = new Map<string, unknown>();
  const documents: { path: string; sha256: string; text: string }[] = [];
  for (const entry of manifest.files) {
    const absolute = resolve(payloadRoot, entry.path);
    if (!absolute.startsWith(`${payloadRoot}${sep}`)) {
      throw new Error(`Manifest path escapes payload root: ${entry.path}`);
    }
    const bytes = readFileSync(absolute);
    if (String(bytes.length) !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`Seed fixture bytes do not match manifest: ${entry.path}`);
    }
    if (entry.mediaType === "application/json") {
      parsedFiles.set(entry.path, parseCanonicalJson(bytes, entry.path));
    } else if (entry.mediaType === "text/markdown") {
      documents.push({
        path: entry.path,
        sha256: entry.sha256,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    }
  }

  const definitions: { digest: string; body: SemanticDefinitionV1 }[] = [];
  let semanticProfile: SemanticProfileV1 | undefined;
  for (const [path, value] of parsedFiles) {
    if (!path.startsWith("types/") || value === null || typeof value !== "object") continue;
    const format = (value as { format?: unknown }).format;
    if (format === "wmm.semantic-definition/1") {
      const body = value as SemanticDefinitionV1;
      const digest = semanticDefinitionDigest(body);
      if (path !== `types/${digest}.json`) throw new Error(`Definition path mismatch: ${path}`);
      definitions.push({ digest, body });
    } else if (format === "wmm.semantic-profile/1") {
      const body = value as SemanticProfileV1;
      const digest = semanticProfileDigest(body);
      if (path !== `types/${digest}.json`) throw new Error(`Profile path mismatch: ${path}`);
      if (semanticProfile !== undefined) throw new Error("Multiple seed semantic profiles found");
      semanticProfile = body;
    }
  }
  if (semanticProfile === undefined) throw new Error("Seed semantic profile is missing");
  const profileDigest = semanticProfileDigest(semanticProfile);
  admitSemanticProfile({
    profile: semanticProfile,
    definitions: definitions.map((entry) => entry.body),
    trustedDefinitionDigests: new Set(definitions.map((entry) => entry.digest)),
    trustedProfileDigests: new Set([profileDigest]),
    allowFixtureOnly: true,
  });

  const worldValue = parsedFiles.get("world.json");
  assertSeedWorld(worldValue);
  if (worldValue.semanticProfileDigest !== profileDigest) {
    throw new Error("Seed world references a different semantic profile");
  }

  const assertions: SeedAssertionRecord[] = [];
  for (const [path, value] of parsedFiles) {
    if (!path.startsWith("records/assertions/")) continue;
    assertSeedAssertion(value);
    if (value.body.worldId !== worldValue.worldId) {
      throw new Error(`Assertion belongs to another world: ${value.id}`);
    }
    if (value.body.semanticProfileDigest !== profileDigest) {
      throw new Error(`Assertion uses another semantic profile: ${value.id}`);
    }
    if (path !== `records/assertions/${value.id.slice("asrt:".length)}.json`) {
      throw new Error(`Assertion path mismatch: ${path}`);
    }
    assertions.push(value);
  }
  assertions.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const catalog = new Set(assertions.map((assertion) => assertion.id));
  for (const activeId of worldValue.activeAssertionIds) {
    if (!catalog.has(activeId)) throw new Error(`Active assertion is missing: ${activeId}`);
  }

  definitions.sort((left, right) =>
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
  );
  documents.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const unresolvedRecordIds = [
    ...new Set(assertions.flatMap((assertion) => referencedRecordIds(assertion.body))),
  ].sort();
  const diagnostics: SeedFixtureDiagnostic[] = [
    {
      code: "SEED_FIXTURE_INCOMPLETE",
      severity: "warning",
      message:
        "The v0.3 identity fixture omits descriptor and source records; reference integrity is intentionally unresolved.",
      unresolvedRecordIds,
    },
  ];

  return {
    format: "wmm.loaded-seed-fixture/1",
    snapshotDigest: snapshotDigest(manifest),
    manifest,
    world: worldValue,
    semanticProfile: { digest: profileDigest, body: semanticProfile },
    definitions,
    assertions,
    documents,
    diagnostics,
  };
}

export function validateSeedFixture(
  fixture: LoadedSeedFixture,
): SeedFixtureValidationReport {
  return {
    status: "valid-seed-fixture",
    snapshotDigest: fixture.snapshotDigest,
    files: fixture.manifest.files.length,
    definitions: fixture.definitions.length,
    assertions: fixture.assertions.length,
    documents: fixture.documents.length,
    diagnostics: fixture.diagnostics,
  };
}

export function inspectSeedFixture(
  fixture: LoadedSeedFixture,
  identifier: string,
): JsonValue | undefined {
  if (identifier === fixture.world.worldId) return fixture.world as unknown as JsonValue;
  const assertion = fixture.assertions.find((candidate) => candidate.id === identifier);
  if (assertion !== undefined) return assertion as unknown as JsonValue;
  if (identifier === fixture.semanticProfile.digest) {
    return fixture.semanticProfile as unknown as JsonValue;
  }
  const definition = fixture.definitions.find((candidate) => candidate.digest === identifier);
  if (definition !== undefined) return definition as unknown as JsonValue;
  if (identifier.startsWith("path:")) {
    const document = fixture.documents.find(
      (candidate) => candidate.path === identifier.slice("path:".length),
    );
    if (document !== undefined) return document as unknown as JsonValue;
  }
  return undefined;
}

export function exportSeedFixture(fixture: LoadedSeedFixture): JsonValue {
  return {
    format: "wmm.seed-world-export/1",
    snapshotDigest: fixture.snapshotDigest,
    world: fixture.world as unknown as JsonValue,
    semanticProfile: fixture.semanticProfile as unknown as JsonValue,
    definitions: fixture.definitions as unknown as JsonValue,
    assertions: fixture.assertions as unknown as JsonValue,
    documents: fixture.documents as unknown as JsonValue,
    diagnostics: fixture.diagnostics as unknown as JsonValue,
  };
}
