import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
  snapshotDigest,
} from "@wmm/canonical";
import { bundledV1Semantics } from "@wmm/core";
import type { SnapshotFileEntryV1 } from "@wmm/wire-contracts";
import {
  exportWorldBundle,
  inspectWorldBundle,
  loadBundledV1WorldBundle,
  loadWorldBundle,
  validateWorldBundle,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);

function listPayloadFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listPayloadFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
  }
  return files.sort();
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonicalJsonBytes(value as never));
}

function rebuildSnapshot(root: string): void {
  const payloadRoot = join(root, "payload");
  const world = JSON.parse(readFileSync(join(payloadRoot, "world.json"), "utf8")) as {
    worldId: string;
  };
  const files = listPayloadFiles(payloadRoot).map((path) => {
    const bytes = readFileSync(join(payloadRoot, path));
    const mediaType: SnapshotFileEntryV1["mediaType"] = path.endsWith(".json")
      ? "application/json"
      : path.endsWith(".md")
        ? "text/markdown"
        : "application/octet-stream";
    return {
      path,
      mediaType,
      byteLength: String(bytes.length),
      sha256: sha256Hex(bytes),
    };
  });
  const manifest = {
    format: "wmm.snapshot-manifest/1" as const,
    worldId: world.worldId,
    files,
  };
  writeCanonical(join(root, "snapshot.json"), {
    format: "wmm.snapshot-record/1",
    snapshotDigest: snapshotDigest(manifest),
    manifest,
  });
}

describe("production V1 world bundle", () => {
  it("loads with complete identity, semantic, and reference validation", () => {
    const bundle = loadBundledV1WorldBundle(fixturePath);
    expect(validateWorldBundle(bundle)).toEqual({
      status: "valid",
      worldId: "world:valen_v1",
      snapshotDigest: "e46d4269225984e5baf982024dff8e33497bda96d7553edb7b61bb2b09866747",
      files: 42,
      descriptors: 7,
      sources: 1,
      assertions: 8,
      activeAssertions: 8,
      supports: 8,
      activeSupports: 8,
    });
  });

  it("inspects every production record family", () => {
    const bundle = loadBundledV1WorldBundle(fixturePath);
    expect(inspectWorldBundle(bundle, "person:alys")).toMatchObject({
      format: "wmm.descriptor/1",
      id: "person:alys",
    });
    expect(inspectWorldBundle(bundle, "source:authorial-stipulation")).toMatchObject({
      format: "wmm.source/1",
    });
    expect(inspectWorldBundle(bundle, bundle.world.assertionIds[0] ?? "")).toMatchObject({
      format: "wmm.assertion-record/1",
    });
    expect(inspectWorldBundle(bundle, bundle.world.supportIds[0] ?? "")).toMatchObject({
      format: "wmm.support-record/1",
    });
    expect(inspectWorldBundle(bundle, "missing:record")).toBeUndefined();
  });

  it("exports a deterministic canonical JSON view", () => {
    const first = exportWorldBundle(loadBundledV1WorldBundle(fixturePath));
    const second = exportWorldBundle(loadBundledV1WorldBundle(fixturePath));
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("does not derive trust from imported profile bytes", () => {
    expect(() =>
      loadWorldBundle(fixturePath, {
        trustedDefinitionDigests: new Set(),
        trustedProfileDigests: new Set(),
      }),
    ).toThrow(/not release-allowlisted/);
  });

  it("rejects integrity-preserving semantic role corruption", () => {
    const corrupted = mkdtempSync(join(tmpdir(), "wmm-world-role-"));
    cpSync(fixturePath, corrupted, { recursive: true });
    const descriptorPath = join(
      corrupted,
      "payload",
      "records",
      "descriptors",
      "person",
      "alys.json",
    );
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Record<
      string,
      unknown
    >;
    descriptor["birthTypeDefinitionDigest"] =
      bundledV1Semantics().definitionDigestsByKey["allied_with"];
    writeCanonical(descriptorPath, descriptor);
    rebuildSnapshot(corrupted);
    expect(() => loadBundledV1WorldBundle(corrupted)).toThrow(/expected descriptorType/);
  });

  it("rejects integrity-preserving dangling historical references", () => {
    const corrupted = mkdtempSync(join(tmpdir(), "wmm-world-reference-"));
    cpSync(fixturePath, corrupted, { recursive: true });
    const worldPath = join(corrupted, "payload", "world.json");
    const world = JSON.parse(readFileSync(worldPath, "utf8")) as {
      descriptorIds: string[];
    };
    world.descriptorIds = world.descriptorIds.filter((id) => id !== "person:bran");
    writeCanonical(worldPath, world);
    rmSync(
      join(corrupted, "payload", "records", "descriptors", "person", "bran.json"),
    );
    rebuildSnapshot(corrupted);
    expect(() => loadBundledV1WorldBundle(corrupted)).toThrow(
      /Descriptor is unavailable: person:bran/,
    );
  });

  it("rejects root additions and payload tampering", () => {
    const rootAddition = mkdtempSync(join(tmpdir(), "wmm-world-root-"));
    cpSync(fixturePath, rootAddition, { recursive: true });
    writeFileSync(join(rootAddition, "unexpected.txt"), "unexpected", "utf8");
    expect(() => loadBundledV1WorldBundle(rootAddition)).toThrow(/exactly payload/);

    const tampered = mkdtempSync(join(tmpdir(), "wmm-world-tampered-"));
    cpSync(fixturePath, tampered, { recursive: true });
    writeFileSync(join(tampered, "payload", "prose", "valen.md"), "changed", "utf8");
    expect(() => loadBundledV1WorldBundle(tampered)).toThrow(/do not match the manifest/);
  });
});
