import {
  cpSync,
  mkdirSync,
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
  populationRosterDigest,
  sha256Hex,
  snapshotDigest,
} from "@wmm/canonical";
import { bundledV1Semantics, queryAbsence } from "@wmm/core";
import type { ApiRequestV1, JsonValue, RosterV1, SnapshotFileEntryV1 } from "@wmm/wire-contracts";
import { validateApiResponse } from "@wmm/wire-contracts";
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
      snapshotDigest: "1e910b5b346be8c4b269ca47eff0f003617f419d4361b8188a81320ed61d873c",
      files: 45,
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
    expect(canonicalJson(first as unknown as JsonValue)).toBe(
      canonicalJson(second as unknown as JsonValue),
    );
  });

  it("keeps roster artifacts explicit in loaded, inspected, and typed exported views", () => {
    const bundle = loadBundledV1WorldBundle(fixturePath);
    const roster = bundle.rosters[0]!;
    expect(bundle.rosters).toHaveLength(1);
    expect(roster.digest).toBe(populationRosterDigest(roster.body));
    expect(inspectWorldBundle(bundle, roster.digest)).toEqual(roster.body);
    const exported = exportWorldBundle(bundle);
    expect(exported.rosters).toEqual(bundle.rosters);
    expect(exported.documents.some((document) => document.path.startsWith("rosters/"))).toBe(false);
    for (const [operation, data] of [["record.inspect", roster.body], ["world.export", exported]] as const) {
      expect(validateApiResponse({
        format: "wmm.response/1", apiVersion: "wmm/1", requestId: "roster-view",
        operation, outcome: "success", execution: "completed", diagnostics: [],
        resolved: { worldId: bundle.world.worldId, snapshotDigest: bundle.snapshot.snapshotDigest }, data,
      }).valid).toBe(true);
    }
  });

  it("retains coverage claims with unavailable roster bytes without establishing proof", () => {
    const root = mkdtempSync(join(tmpdir(), "wmm-missing-roster-"));
    try {
      cpSync(fixturePath, root, { recursive: true });
      rmSync(join(root, "payload", "rosters"), { recursive: true });
      rebuildSnapshot(root);
      const bundle = loadBundledV1WorldBundle(root);
      expect(bundle.rosters).toEqual([]);
      const request = JSON.parse(readFileSync(new URL("../../../fixtures/v2/absence-request.json", import.meta.url), "utf8")) as Extract<ApiRequestV1, { operation: "absence.query" }>;
      const result = queryAbsence({ ...bundle, worldId: bundle.world.worldId,
        snapshotDigest: bundle.snapshot.snapshotDigest, activeAssertionIds: bundle.world.activeAssertionIds },
      request.payload.target, request.payload.scope, request.payload.temporal);
      expect(result.derivation.reason).toBe("coverage-roster-missing");
      expect(result.conclusion.bases).toEqual(["declared"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["unsorted", "duplicate", "unknown-member", "world-mismatch", "population-role", "digest-mismatch", "wrong-path", "noncanonical"] as const)(
    "rejects %s roster artifacts even after rebuilding manifest integrity", (corruption) => {
      const root = mkdtempSync(join(tmpdir(), "wmm-roster-integrity-"));
      try {
        cpSync(fixturePath, root, { recursive: true });
        const original = loadBundledV1WorldBundle(fixturePath).rosters[0]!;
        let roster: RosterV1 = original.body;
        if (corruption === "unsorted") roster = { ...roster, memberIds: [...roster.memberIds].reverse() };
        if (corruption === "duplicate") roster = { ...roster, memberIds: ["person:alys", "person:alys"] };
        if (corruption === "unknown-member") roster = { ...roster, memberIds: ["person:missing"] };
        if (corruption === "world-mismatch") roster = { ...roster, worldId: "world:other" };
        if (corruption === "population-role") roster = { ...roster, populationDefinitionDigest: bundledV1Semantics().definitionDigestsByKey["person"]! };
        const name = corruption === "wrong-path" ? "not-a-digest" : corruption === "digest-mismatch" ? "0".repeat(64) : populationRosterDigest(roster);
        rmSync(join(root, "payload", "rosters", `${original.digest}.json`));
        const path = join(root, "payload", "rosters", `${name}.json`);
        if (corruption === "noncanonical") writeFileSync(path, JSON.stringify(roster, null, 2));
        else writeCanonical(path, roster);
        rebuildSnapshot(root);
        expect(() => loadBundledV1WorldBundle(root)).toThrow(expect.objectContaining({ code: "INVALID_WORLD" }));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not derive trust from imported profile bytes", () => {
    expect(() =>
      loadWorldBundle(fixturePath, {
        trustedDefinitionDigests: new Set(),
        trustedProfileDigests: new Set(),
      }),
    ).toThrow(expect.objectContaining({
      name: "WorldBundleError",
      code: "INVALID_WORLD",
      message: expect.stringMatching(/not release-allowlisted/),
    }));
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
    expect(() => loadBundledV1WorldBundle(corrupted)).toThrow(expect.objectContaining({
          name: "WorldBundleError",
          code: "INVALID_WORLD",
          message: expect.stringMatching(/expected descriptorType/),
        }));
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

  it("rejects integrity-preserving future record families rather than omitting them from views", () => {
    const corrupted = mkdtempSync(join(tmpdir(), "wmm-world-future-record-"));
    try {
      cpSync(fixturePath, corrupted, { recursive: true });
      const directory = join(corrupted, "payload", "records", "future");
      mkdirSync(directory);
      writeCanonical(join(directory, "record.json"), { format: "wmm.future-record/1" });
      rebuildSnapshot(corrupted);
      expect(() => loadBundledV1WorldBundle(corrupted)).toThrow(expect.objectContaining({
        code: "INVALID_WORLD",
        message: expect.stringMatching(/Unsupported reserved record namespace/),
      }));
    } finally {
      rmSync(corrupted, { recursive: true, force: true });
    }
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
