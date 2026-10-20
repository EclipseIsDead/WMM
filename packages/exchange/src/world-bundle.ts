import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertionId,
  CanonicalizationError,
  canonicalJsonBytes,
  populationRosterDigest,
  semanticDefinitionDigest,
  semanticProfileDigest,
  sha256Hex,
  snapshotDigest,
  supportId,
} from "@wmm/canonical";
import {
  AdmissionError,
  admitSemanticProfile,
  bundledV1Semantics,
  validateWorldSemantics,
  WorldValidationError,
} from "@wmm/core";
import type {
  AssertionRecordV1,
  DescriptorRecordV1,
  InspectableRecordV1,
  JsonValue,
  RosterV1,
  SemanticDefinitionV1,
  SemanticProfileV1,
  SnapshotFileEntryV1,
  SnapshotRecordV1,
  SourceRecordV1,
  SupportRecordV1,
  WorldCatalogV1,
  WorldExportV1,
  WorldRecordV1,
  WorldValidationReportV1,
} from "@wmm/wire-contracts";
import { validateSemanticContract, validateWorldRecord } from "@wmm/wire-contracts";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DIRECTORIES = 1_000;
const MAX_DEPTH = 32;

export type WorldBundleErrorCode = "INVALID_WORLD" | "FILESYSTEM_ERROR" | "INTERNAL_ERROR";

/** Only INVALID_WORLD denotes rejected input; callers must not mask other failures as bad worlds. */
export class WorldBundleError extends Error {
  constructor(
    readonly code: WorldBundleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorldBundleError";
  }
}

function invalidWorld(message: string, cause?: unknown): WorldBundleError {
  return new WorldBundleError("INVALID_WORLD", message, { cause });
}

function exchangeBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WorldBundleError) throw error;
    if (
      error instanceof AdmissionError ||
      error instanceof WorldValidationError ||
      error instanceof CanonicalizationError ||
      // These validators are transitive core dependencies, not exchange dependencies.
      (error instanceof TypeError && (
        error.name === "DefinitionSemanticError" ||
        error.name === "TemporalInputError" ||
        error.message.startsWith("Invalid semantic definition shape:") ||
        error.message.startsWith("Invalid semantic profile shape:")
      ))
    ) {
      throw invalidWorld(error.message, error);
    }
    throw new WorldBundleError("INTERNAL_ERROR", "Unexpected world bundle loader failure", {
      cause: error,
    });
  }
}

function filesystem<T>(operation: string, path: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof Error && "code" in error && "errno" in error) {
      if (error.code === "ELOOP") throw invalidWorld(`Bundle contains a symlink: ${path}`, error);
      throw new WorldBundleError("FILESYSTEM_ERROR", `Cannot ${operation}: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

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
  readonly rosters: readonly { readonly digest: string; readonly body: RosterV1 }[];
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

export type WorldBundleValidationReport = WorldValidationReportV1;

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface BundleFile {
  readonly absolute: string;
  readonly stat: BigIntStats;
}

function statEntry(path: string): BigIntStats {
  const stat = filesystem("stat bundle entry", path, () => lstatSync(path, { bigint: true }));
  if (stat.isSymbolicLink()) throw invalidWorld(`Bundle contains a symlink: ${path}`);
  return stat;
}

function assertUnchanged(before: BigIntStats, after: BigIntStats, path: string): void {
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw invalidWorld(`Bundle entry changed while loading: ${path}`);
  }
}

function assertFileSize(size: bigint, path: string): void {
  if (size < 0n || size > BigInt(MAX_FILE_BYTES)) {
    throw invalidWorld(`Bundle file exceeds the file-size limit (10 MiB): ${path}`);
  }
}

/**
 * O_NOFOLLOW protects the final file component, and inode/metadata checks detect ordinary
 * replacement and mutation. Node has no openat: path-based directory opens and ancestor
 * checks are NOT atomic confinement against concurrent parent rename/symlink swaps.
 * Load from a private, stable directory when another process could mutate bundle parents.
 */
class BoundedBundleIO {
  readonly directories = new Map<string, BigIntStats>();
  totalBytes = 0;
  private entries = 0;

  observeDirectory(path: string, stat = statEntry(path)): void {
    if (!stat.isDirectory()) throw invalidWorld(`Bundle directory has an invalid filesystem type: ${path}`);
    this.directories.set(path, stat);
    if (this.directories.size > MAX_DIRECTORIES) {
      throw invalidWorld("Bundle exceeds the directory-count limit");
    }
  }

  assertParents(path: string): void {
    for (let parent = dirname(path); this.directories.has(parent); parent = dirname(parent)) {
      assertUnchanged(this.directories.get(parent)!, statEntry(parent), parent);
      if (dirname(parent) === parent) break;
    }
  }

  forEachEntry(path: string, visit: (name: string) => void): void {
    this.assertParents(path);
    assertUnchanged(this.directories.get(path)!, statEntry(path), path);
    // Stream entries rather than allocating an unbounded readdir array (including empty dirs).
    const directory = filesystem("open bundle directory", path, () => opendirSync(path, { bufferSize: 32 }));
    try {
      for (;;) {
        const entry = filesystem("read bundle directory", path, () => directory.readSync());
        if (entry === null) break;
        this.entries += 1;
        if (this.entries > MAX_ENTRIES) throw invalidWorld("Bundle exceeds the entry-count limit");
        visit(entry.name);
      }
      assertUnchanged(this.directories.get(path)!, statEntry(path), path);
      this.assertParents(path);
    } finally {
      filesystem("close bundle directory", path, () => directory.closeSync());
    }
  }

  read(file: BundleFile): Uint8Array {
    const { absolute, stat: observed } = file;
    this.assertParents(absolute);
    const before = statEntry(absolute);
    assertUnchanged(observed, before, absolute);
    if (!before.isFile()) throw invalidWorld(`Bundle contains a non-regular entry: ${absolute}`);
    const fd = filesystem("open bundle file", absolute, () => openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ));
    try {
      const opened = filesystem("stat open bundle file", absolute, () => fstatSync(fd, { bigint: true }));
      if (!opened.isFile()) throw invalidWorld(`Bundle contains a non-regular entry: ${absolute}`);
      assertFileSize(opened.size, absolute);
      assertUnchanged(before, opened, absolute);
      const size = Number(opened.size);
      if (this.totalBytes + size > MAX_TOTAL_BYTES) {
        throw invalidWorld("Bundle exceeds the total-size limit (100 MiB, including snapshot.json)");
      }
      // Allocate only after checking the actual open inode, never the manifest's declaration.
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = filesystem("read bundle file", absolute, () => readSync(
          fd, bytes, offset, size - offset, offset,
        ));
        if (count === 0) throw invalidWorld(`Bundle file was truncated while loading: ${absolute}`);
        offset += count;
      }
      // Reads are capped at the observed size even if the inode grows; the final stat rejects growth.
      assertUnchanged(opened, filesystem("stat open bundle file", absolute, () => fstatSync(fd, { bigint: true })), absolute);
      assertUnchanged(opened, statEntry(absolute), absolute);
      this.assertParents(absolute);
      this.totalBytes += bytes.length;
      return bytes;
    } finally {
      filesystem("close bundle file", absolute, () => closeSync(fd));
    }
  }
}

function listRegularFiles(io: BoundedBundleIO, root: string): Map<string, BundleFile> {
  const files = new Map<string, BundleFile>();
  let actualTotalBytes = io.totalBytes;
  function visit(directory: string, prefix: string, depth: number): void {
    io.forEachEntry(directory, (name) => {
      const absolute = resolve(directory, name);
      const path = `${prefix}${name}`;
      const stat = statEntry(absolute);
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) throw invalidWorld("Bundle exceeds the directory-depth limit");
        io.observeDirectory(absolute, stat);
        visit(absolute, `${path}/`, depth + 1);
      } else if (stat.isFile()) {
        assertFileSize(stat.size, path);
        actualTotalBytes += Number(stat.size);
        if (actualTotalBytes > MAX_TOTAL_BYTES) {
          throw invalidWorld("Bundle exceeds the total-size limit (100 MiB, including snapshot.json)");
        }
        files.set(path, { absolute, stat });
        if (files.size > MAX_FILES) throw invalidWorld("Bundle exceeds the file-count limit");
      } else {
        throw invalidWorld(`Bundle contains a non-regular entry: ${path}`);
      }
    });
  }
  visit(root, "", 0);
  return files;
}

function assertManifestCardinality(input: unknown): void {
  if (input === null || typeof input !== "object" || !("manifest" in input)) return;
  const manifest = input.manifest;
  if (manifest === null || typeof manifest !== "object" || !("files" in manifest)) return;
  if (Array.isArray(manifest.files) && manifest.files.length > MAX_FILES) {
    throw invalidWorld("Snapshot manifest exceeds the file-count limit (10000)");
  }
}

function parseCanonicalJson(
  bytes: Uint8Array,
  path: string,
  check?: (input: unknown) => void,
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw invalidWorld(`Invalid UTF-8 JSON: ${path}`, error);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidWorld(`Invalid JSON: ${path}`, error);
    throw error;
  }
  check?.(parsed);
  const canonical = canonicalJsonBytes(parsed as JsonValue);
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    throw invalidWorld(`JSON is not canonical or contains duplicate information: ${path}`);
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
    throw invalidWorld(`Invalid world record ${path}: ${JSON.stringify(validation.errors)}`);
  }
  if ((input as WorldRecordV1).format !== format) {
    throw invalidWorld(`Unexpected world record format at ${path}`);
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
    throw invalidWorld(`${category} paths do not match the world catalog`);
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
  if (value === undefined) throw invalidWorld(`Required world record is missing: ${path}`);
  assertWorldRecord<T>(value, format, path);
  return value;
}

function verifyRoot(io: BoundedBundleIO, bundleRoot: string): {
  snapshot: BundleFile;
  payloadRoot: string;
} {
  io.observeDirectory(bundleRoot);
  const entries: string[] = [];
  io.forEachEntry(bundleRoot, (name) => {
    entries.push(name);
    if (entries.length > 2) throw invalidWorld("Bundle root must contain exactly payload/ and snapshot.json");
  });
  if (!isDeepStrictEqual(entries.sort(asciiCompare), ["payload", "snapshot.json"])) {
    throw invalidWorld("Bundle root must contain exactly payload/ and snapshot.json");
  }
  const absolute = resolve(bundleRoot, "snapshot.json");
  const payloadRoot = resolve(bundleRoot, "payload");
  const stat = statEntry(absolute);
  if (!stat.isFile()) throw invalidWorld("Bundle root entries have invalid filesystem types");
  io.observeDirectory(payloadRoot);
  return { snapshot: { absolute, stat }, payloadRoot };
}

export function loadWorldBundle(
  bundlePath: string,
  trust: WorldBundleTrust,
): LoadedWorldBundle {
  return exchangeBoundary(() => loadWorldBundleUnchecked(bundlePath, trust));
}

function loadWorldBundleUnchecked(
  bundlePath: string,
  trust: WorldBundleTrust,
): LoadedWorldBundle {
  const bundleRoot = resolve(bundlePath);
  const io = new BoundedBundleIO();
  const { snapshot, payloadRoot } = verifyRoot(io, bundleRoot);
  const snapshotBytes = io.read(snapshot);
  const snapshotValue = parseCanonicalJson(snapshotBytes, "snapshot.json", assertManifestCardinality);
  assertWorldRecord<SnapshotRecordV1>(
    snapshotValue,
    "wmm.snapshot-record/1",
    "snapshot.json",
  );
  if (snapshotDigest(snapshotValue.manifest) !== snapshotValue.snapshotDigest) {
    throw invalidWorld("Snapshot wrapper digest does not match its manifest");
  }

  const manifest = snapshotValue.manifest;
  const declaredPaths = manifest.files.map((entry) => entry.path);
  const actualFiles = listRegularFiles(io, payloadRoot);
  const actualPaths = [...actualFiles.keys()].sort(asciiCompare);
  if (!isDeepStrictEqual(actualPaths, declaredPaths)) {
    throw invalidWorld("Payload file set differs from the snapshot manifest");
  }
  for (const path of recordPaths(actualPaths, "records/")) {
    if (!/^records\/(descriptors|sources|assertions|supports)\//.test(path)) {
      throw invalidWorld(`Unsupported reserved record namespace: ${path}`);
    }
  }
  const foldedPaths = new Set<string>();
  let totalBytes = snapshotBytes.length;
  for (const entry of manifest.files) {
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) throw invalidWorld(`Case-folding path collision: ${entry.path}`);
    foldedPaths.add(folded);
    const byteLength = Number(entry.byteLength);
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_FILE_BYTES) {
      throw invalidWorld(`Manifest entry exceeds the file-size limit: ${entry.path}`);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw invalidWorld("Bundle exceeds the total-size limit");
  }

  const parsedFiles = new Map<string, unknown>();
  const bytesByPath = new Map<string, Uint8Array>();
  const manifestByPath = new Map<string, SnapshotFileEntryV1>();
  for (const entry of manifest.files) {
    const absolute = resolve(payloadRoot, entry.path);
    if (!absolute.startsWith(`${payloadRoot}${sep}`)) {
      throw invalidWorld(`Manifest path escapes payload root: ${entry.path}`);
    }
    const observed = actualFiles.get(entry.path);
    if (observed === undefined) throw invalidWorld(`Payload file is missing: ${entry.path}`);
    const bytes = io.read(observed);
    if (String(bytes.length) !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
      throw invalidWorld(`Payload bytes do not match the manifest: ${entry.path}`);
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
    throw invalidWorld("Manifest and world catalog use different world IDs");
  }

  const profilePath = `types/${world.semanticProfileDigest}.json`;
  const profileValue = parsedFiles.get(profilePath);
  if (profileValue === undefined) throw invalidWorld("World semantic profile is missing");
  const profile = profileValue as SemanticProfileV1;
  if (semanticProfileDigest(profile) !== world.semanticProfileDigest) {
    throw invalidWorld("World semantic profile digest mismatch");
  }

  // Admission performs the complete semantic schema validation; guard this traversal first.
  if (
    profile === null || typeof profile !== "object" || !Array.isArray(profile.definitions) ||
    !profile.definitions.every((digest: unknown) => typeof digest === "string")
  ) {
    throw invalidWorld("World semantic profile has invalid definitions");
  }
  const definitions: SemanticDefinitionV1[] = [];
  for (const digest of profile.definitions) {
    const path = `types/${digest}.json`;
    const value = parsedFiles.get(path);
    if (value === undefined) throw invalidWorld(`Semantic definition is missing: ${digest}`);
    const definition = value as SemanticDefinitionV1;
    if (semanticDefinitionDigest(definition) !== digest) {
      throw invalidWorld(`Semantic definition digest mismatch: ${digest}`);
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
    if (record.id !== id) throw invalidWorld(`Descriptor wrapper/path ID mismatch: ${id}`);
    return record;
  });
  const sources = world.sourceIds.map((id) => {
    const record = loadRecord<SourceRecordV1>(
      parsedFiles,
      sourcePath(id),
      "wmm.source/1",
    );
    if (record.id !== id) throw invalidWorld(`Source wrapper/path ID mismatch: ${id}`);
    if (record.content.availability === "bundled") {
      const entry = manifestByPath.get(record.content.path);
      if (entry === undefined || entry.sha256 !== record.content.sha256) {
        throw invalidWorld(`Bundled source content is missing or mismatched: ${id}`);
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
      throw invalidWorld(`Assertion identity mismatch: ${id}`);
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
      throw invalidWorld(`Support identity mismatch: ${id}`);
    }
    return record;
  });

  const rosters = recordPaths(actualPaths, "rosters/").map((path) => {
    if (!/^rosters\/[0-9a-f]{64}\.json$/.test(path)) throw invalidWorld(`Invalid roster artifact path: ${path}`);
    const value = parsedFiles.get(path);
    if (!validateSemanticContract(value).valid || (value as { readonly format?: unknown } | undefined)?.format !== "wmm.roster/1") {
      throw invalidWorld(`Invalid canonical JSON roster artifact: ${path}`);
    }
    const body = value as RosterV1;
    const digest = path.slice("rosters/".length, -".json".length);
    if (populationRosterDigest(body) !== digest) throw invalidWorld(`Roster artifact digest mismatch: ${path}`);
    return { digest, body };
  });

  validateWorldSemantics({
    world,
    rosters,
    definitionsByDigest: admitted.definitionsByDigest,
    descriptors,
    sources,
    assertions,
    supports,
  });

  // Recheck earlier entries too: a later read or semantic validation may have overlapped mutation.
  for (const [path, stat] of io.directories) assertUnchanged(stat, statEntry(path), path);
  for (const file of [snapshot, ...actualFiles.values()]) {
    assertUnchanged(file.stat, statEntry(file.absolute), file.absolute);
  }

  const semanticAndRecordPaths = new Set([
    "world.json",
    ...recordPaths(actualPaths, "types/"),
    ...recordPaths(actualPaths, "records/"),
    ...recordPaths(actualPaths, "rosters/"),
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
    rosters,
    descriptors,
    sources,
    assertions,
    supports,
    documents,
  };
}

export function loadBundledV1WorldBundle(bundlePath: string): LoadedWorldBundle {
  return exchangeBoundary(() => {
    const semantics = bundledV1Semantics();
    return loadWorldBundle(bundlePath, {
      trustedDefinitionDigests: semantics.trustedDefinitionDigests,
      trustedProfileDigests: semantics.trustedProfileDigests,
    });
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
): InspectableRecordV1 | undefined {
  if (identifier === bundle.world.worldId) return bundle.world;
  const descriptor = bundle.descriptors.find((record) => record.id === identifier);
  if (descriptor !== undefined) return descriptor;
  const source = bundle.sources.find((record) => record.id === identifier);
  if (source !== undefined) return source;
  const assertion = bundle.assertions.find((record) => record.id === identifier);
  if (assertion !== undefined) return assertion;
  const support = bundle.supports.find((record) => record.id === identifier);
  if (support !== undefined) return support;
  const roster = bundle.rosters.find((record) => record.digest === identifier);
  if (roster !== undefined) return roster.body;
  if (identifier === bundle.world.semanticProfileDigest) return bundle.semanticProfile;
  return bundle.definitionsByDigest[identifier];
}

export function exportWorldBundle(bundle: LoadedWorldBundle): WorldExportV1 {
  return {
    format: "wmm.world-export/1",
    snapshotDigest: bundle.snapshot.snapshotDigest,
    world: bundle.world,
    semanticProfile: bundle.semanticProfile,
    definitions: Object.entries(bundle.definitionsByDigest)
      .sort(([left], [right]) => asciiCompare(left, right))
      .map(([digest, body]) => ({ digest, body })),
    rosters: bundle.rosters,
    descriptors: bundle.descriptors,
    sources: bundle.sources,
    assertions: bundle.assertions,
    supports: bundle.supports,
    documents: bundle.documents.map((document) => ({
      path: document.path,
      mediaType: document.mediaType,
      sha256: document.sha256,
      byteLength: String(document.bytes.length),
    })),
  };
}
