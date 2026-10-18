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
  supportId,
} from "@wmm/canonical";
import {
  admitSemanticProfile,
  bundledV1Semantics,
  validateWorldSemantics,
} from "@wmm/core";
import type {
  AssertionRecordV1,
  DescriptorRecordV1,
  JsonValue,
  SemanticDefinitionV1,
  SemanticProfileV1,
  SnapshotFileEntryV1,
  SnapshotRecordV1,
  SourceRecordV1,
  SupportRecordV1,
  WorldCatalogV1,
  WorldRecordV1,
} from "@wmm/wire-contracts";
import { validateWorldRecord } from "@wmm/wire-contracts";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface WorldBundleTrust {
  readonly trustedDefinitionDigests: ReadonlySet<string>;
  readonly trustedProfileDigests: ReadonlySet<string>;
}

export interface LoadedWorldBundle {
  readonly format: "wmm.loaded-world/1";
  readonly snapshot: SnapshotRecordV1;
  readonly world: WorldCatalogV1;
  readonly semanticProfile: SemanticProfileV1;
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
  readonly descriptors: readonly DescriptorRecordV1[];
  readonly sources: readonly SourceRecordV1[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly supports: readonly SupportRecordV1[];
  readonly documents: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly bytes: Uint8Array;
  }[];
}

export interface WorldBundleValidationReport {
  readonly status: "valid";
  readonly worldId: string;
  readonly snapshotDigest: string;
  readonly files: number;
  readonly descriptors: number;
  readonly sources: number;
  readonly assertions: number;
  readonly activeAssertions: number;
  readonly supports: number;
  readonly activeSupports: number;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function listRegularFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Bundle contains a symlink: ${entry.name}`);
    if (stat.isDirectory()) {
      files.push(...listRegularFiles(root, absolute));
    } else if (stat.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    } else {
      throw new Error(`Bundle contains a non-regular entry: ${entry.name}`);
    }
    if (files.length > MAX_FILES) throw new Error("Bundle exceeds the file-count limit");
  }
  return files.sort(asciiCompare);
}

function parseCanonicalJson(bytes: Uint8Array, path: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const canonical = canonicalJsonBytes(parsed as JsonValue);
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    throw new Error(`JSON is not canonical or contains duplicate information: ${path}`);
  }
  return parsed;
}

function assertWorldRecord<T extends WorldRecordV1>(
  input: unknown,
  format: T["format"],
  path: string,
): asserts input is T {
  const validation = validateWorldRecord(input);
  if (!validation.valid) {
    throw new Error(`Invalid world record ${path}: ${JSON.stringify(validation.errors)}`);
  }
  if ((input as WorldRecordV1).format !== format) {
    throw new Error(`Unexpected world record format at ${path}`);
  }
}

function descriptorPath(id: string): string {
  const separator = id.indexOf(":");
  return `records/descriptors/${id.slice(0, separator)}/${id.slice(separator + 1)}.json`;
}

function sourcePath(id: string): string {
  return `records/sources/${id.slice("source:".length)}.json`;
}

function assertionPath(id: string): string {
  return `records/assertions/${id.slice("asrt:".length)}.json`;
}

function supportPath(id: string): string {
  return `records/supports/${id.slice("sup:".length)}.json`;
}

function assertExactPaths(
  actual: readonly string[],
  expected: readonly string[],
  category: string,
): void {
  const sortedExpected = [...expected].sort(asciiCompare);
  if (!isDeepStrictEqual(actual, sortedExpected)) {
    throw new Error(`${category} paths do not match the world catalog`);
  }
}

function recordPaths(paths: readonly string[], prefix: string): string[] {
  return paths.filter((path) => path.startsWith(prefix));
}

function loadRecord<T extends WorldRecordV1>(
  parsedFiles: ReadonlyMap<string, unknown>,
  path: string,
  format: T["format"],
): T {
  const value = parsedFiles.get(path);
  if (value === undefined) throw new Error(`Required world record is missing: ${path}`);
  assertWorldRecord<T>(value, format, path);
  return value;
}

function verifyRoot(bundleRoot: string): { snapshotPath: string; payloadRoot: string } {
  const entries = readdirSync(bundleRoot).sort(asciiCompare);
  if (!isDeepStrictEqual(entries, ["payload", "snapshot.json"])) {
    throw new Error("Bundle root must contain exactly payload/ and snapshot.json");
  }
  const snapshotPath = resolve(bundleRoot, "snapshot.json");
  const payloadRoot = resolve(bundleRoot, "payload");
  if (!lstatSync(snapshotPath).isFile() || !lstatSync(payloadRoot).isDirectory()) {
    throw new Error("Bundle root entries have invalid filesystem types");
  }
  return { snapshotPath, payloadRoot };
}

export function loadWorldBundle(
  bundlePath: string,
  trust: WorldBundleTrust,
): LoadedWorldBundle {
  const bundleRoot = resolve(bundlePath);
  const { snapshotPath, payloadRoot } = verifyRoot(bundleRoot);
  const snapshotBytes = readFileSync(snapshotPath);
  if (snapshotBytes.length > MAX_FILE_BYTES) throw new Error("snapshot.json is too large");
  const snapshotValue = parseCanonicalJson(snapshotBytes, "snapshot.json");
  assertWorldRecord<SnapshotRecordV1>(
    snapshotValue,
    "wmm.snapshot-record/1",
    "snapshot.json",
  );
  if (snapshotDigest(snapshotValue.manifest) !== snapshotValue.snapshotDigest) {
    throw new Error("Snapshot wrapper digest does not match its manifest");
  }

  const manifest = snapshotValue.manifest;
  const declaredPaths = manifest.files.map((entry) => entry.path);
  const actualPaths = listRegularFiles(payloadRoot);
  if (!isDeepStrictEqual(actualPaths, declaredPaths)) {
    throw new Error("Payload file set differs from the snapshot manifest");
  }
  const foldedPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) throw new Error(`Case-folding path collision: ${entry.path}`);
    foldedPaths.add(folded);
    const byteLength = Number(entry.byteLength);
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_FILE_BYTES) {
      throw new Error(`Manifest entry exceeds the file-size limit: ${entry.path}`);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Bundle exceeds the total-size limit");
  }

  const parsedFiles = new Map<string, unknown>();
  const bytesByPath = new Map<string, Uint8Array>();
  const manifestByPath = new Map<string, SnapshotFileEntryV1>();
  for (const entry of manifest.files) {
    const absolute = resolve(payloadRoot, entry.path);
    if (!absolute.startsWith(`${payloadRoot}${sep}`)) {
      throw new Error(`Manifest path escapes payload root: ${entry.path}`);
    }
    const bytes = readFileSync(absolute);
    if (String(bytes.length) !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`Payload bytes do not match the manifest: ${entry.path}`);
    }
    bytesByPath.set(entry.path, bytes);
    manifestByPath.set(entry.path, entry);
    if (entry.mediaType === "application/json") {
      parsedFiles.set(entry.path, parseCanonicalJson(bytes, entry.path));
    }
  }

  const world = loadRecord<WorldCatalogV1>(
    parsedFiles,
    "world.json",
    "wmm.world/1",
  );
  if (manifest.worldId !== world.worldId) {
    throw new Error("Manifest and world catalog use different world IDs");
  }

  const profilePath = `types/${world.semanticProfileDigest}.json`;
  const profileValue = parsedFiles.get(profilePath);
  if (profileValue === undefined) throw new Error("World semantic profile is missing");
  const profile = profileValue as SemanticProfileV1;
  if (semanticProfileDigest(profile) !== world.semanticProfileDigest) {
    throw new Error("World semantic profile digest mismatch");
  }

  const definitions: SemanticDefinitionV1[] = [];
  for (const digest of profile.definitions) {
    const path = `types/${digest}.json`;
    const value = parsedFiles.get(path);
    if (value === undefined) throw new Error(`Semantic definition is missing: ${digest}`);
    const definition = value as SemanticDefinitionV1;
    if (semanticDefinitionDigest(definition) !== digest) {
      throw new Error(`Semantic definition digest mismatch: ${digest}`);
    }
    definitions.push(definition);
  }
  assertExactPaths(
    recordPaths(actualPaths, "types/"),
    [profilePath, ...profile.definitions.map((digest) => `types/${digest}.json`)],
    "Semantic type",
  );
  const admitted = admitSemanticProfile({
    profile,
    definitions,
    trustedDefinitionDigests: trust.trustedDefinitionDigests,
    trustedProfileDigests: trust.trustedProfileDigests,
  });

  assertExactPaths(
    recordPaths(actualPaths, "records/descriptors/"),
    world.descriptorIds.map(descriptorPath),
    "Descriptor",
  );
  assertExactPaths(
    recordPaths(actualPaths, "records/sources/"),
    world.sourceIds.map(sourcePath),
    "Source",
  );
  assertExactPaths(
    recordPaths(actualPaths, "records/assertions/"),
    world.assertionIds.map(assertionPath),
    "Assertion",
  );
  assertExactPaths(
    recordPaths(actualPaths, "records/supports/"),
    world.supportIds.map(supportPath),
    "Support",
  );

  const descriptors = world.descriptorIds.map((id) => {
    const record = loadRecord<DescriptorRecordV1>(
      parsedFiles,
      descriptorPath(id),
      "wmm.descriptor/1",
    );
    if (record.id !== id) throw new Error(`Descriptor wrapper/path ID mismatch: ${id}`);
    return record;
  });
  const sources = world.sourceIds.map((id) => {
    const record = loadRecord<SourceRecordV1>(
      parsedFiles,
      sourcePath(id),
      "wmm.source/1",
    );
    if (record.id !== id) throw new Error(`Source wrapper/path ID mismatch: ${id}`);
    if (record.content.availability === "bundled") {
      const entry = manifestByPath.get(record.content.path);
      if (entry === undefined || entry.sha256 !== record.content.sha256) {
        throw new Error(`Bundled source content is missing or mismatched: ${id}`);
      }
    }
    return record;
  });
  const assertions = world.assertionIds.map((id) => {
    const record = loadRecord<AssertionRecordV1>(
      parsedFiles,
      assertionPath(id),
      "wmm.assertion-record/1",
    );
    if (record.id !== id || assertionId(record.body) !== id) {
      throw new Error(`Assertion identity mismatch: ${id}`);
    }
    return record;
  });
  const supports = world.supportIds.map((id) => {
    const record = loadRecord<SupportRecordV1>(
      parsedFiles,
      supportPath(id),
      "wmm.support-record/1",
    );
    if (record.id !== id || supportId(record.body) !== id) {
      throw new Error(`Support identity mismatch: ${id}`);
    }
    return record;
  });

  validateWorldSemantics({
    world,
    definitionsByDigest: admitted.definitionsByDigest,
    descriptors,
    sources,
    assertions,
    supports,
  });

  const semanticAndRecordPaths = new Set([
    "world.json",
    ...recordPaths(actualPaths, "types/"),
    ...recordPaths(actualPaths, "records/"),
  ]);
  const documents = manifest.files
    .filter((entry) => !semanticAndRecordPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      mediaType: entry.mediaType,
      sha256: entry.sha256,
      bytes: bytesByPath.get(entry.path) ?? new Uint8Array(),
    }));

  return {
    format: "wmm.loaded-world/1",
    snapshot: snapshotValue,
    world,
    semanticProfile: profile,
    definitionsByDigest: admitted.definitionsByDigest,
    descriptors,
    sources,
    assertions,
    supports,
    documents,
  };
}

export function loadBundledV1WorldBundle(bundlePath: string): LoadedWorldBundle {
  const semantics = bundledV1Semantics();
  return loadWorldBundle(bundlePath, {
    trustedDefinitionDigests: semantics.trustedDefinitionDigests,
    trustedProfileDigests: semantics.trustedProfileDigests,
  });
}

export function validateWorldBundle(
  bundle: LoadedWorldBundle,
): WorldBundleValidationReport {
  return {
    status: "valid",
    worldId: bundle.world.worldId,
    snapshotDigest: bundle.snapshot.snapshotDigest,
    files: bundle.snapshot.manifest.files.length,
    descriptors: bundle.descriptors.length,
    sources: bundle.sources.length,
    assertions: bundle.assertions.length,
    activeAssertions: bundle.world.activeAssertionIds.length,
    supports: bundle.supports.length,
    activeSupports: bundle.world.activeSupportIds.length,
  };
}

export function inspectWorldBundle(
  bundle: LoadedWorldBundle,
  identifier: string,
): JsonValue | undefined {
  if (identifier === bundle.world.worldId) return bundle.world as unknown as JsonValue;
  const descriptor = bundle.descriptors.find((record) => record.id === identifier);
  if (descriptor !== undefined) return descriptor as unknown as JsonValue;
  const source = bundle.sources.find((record) => record.id === identifier);
  if (source !== undefined) return source as unknown as JsonValue;
  const assertion = bundle.assertions.find((record) => record.id === identifier);
  if (assertion !== undefined) return assertion as unknown as JsonValue;
  const support = bundle.supports.find((record) => record.id === identifier);
  if (support !== undefined) return support as unknown as JsonValue;
  if (identifier === bundle.world.semanticProfileDigest) {
    return bundle.semanticProfile as unknown as JsonValue;
  }
  const definition = bundle.definitionsByDigest[identifier];
  if (definition !== undefined) return definition as unknown as JsonValue;
  return undefined;
}

export function exportWorldBundle(bundle: LoadedWorldBundle): JsonValue {
  return {
    format: "wmm.world-export/1",
    snapshotDigest: bundle.snapshot.snapshotDigest,
    world: bundle.world as unknown as JsonValue,
    semanticProfile: bundle.semanticProfile as unknown as JsonValue,
    definitions: Object.entries(bundle.definitionsByDigest)
      .sort(([left], [right]) => asciiCompare(left, right))
      .map(([digest, body]) => ({ digest, body })) as unknown as JsonValue,
    descriptors: bundle.descriptors as unknown as JsonValue,
    sources: bundle.sources as unknown as JsonValue,
    assertions: bundle.assertions as unknown as JsonValue,
    supports: bundle.supports as unknown as JsonValue,
    documents: bundle.documents.map((document) => ({
      path: document.path,
      mediaType: document.mediaType,
      sha256: document.sha256,
      byteLength: String(document.bytes.length),
    })) as unknown as JsonValue,
  };
}
