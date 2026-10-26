import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "@wmm/canonical";
import type { Atlas, AuthoringProject, JsonValue, SnapshotRecordV1 } from "@wmm/wire-contracts";
import { buildAuthoringBundle, loadReleaseWorldBundle } from "../src/index.js";

function project(): AuthoringProject {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/atlas-project.json", import.meta.url), "utf8")) as AuthoringProject;
}
function replaceAtlas(root: string, atlas: Atlas): void {
  const path = "maps/reference_demo.json";
  const bytes = canonicalJsonBytes(atlas as unknown as JsonValue);
  writeFileSync(join(root, "payload", path), bytes);
  const snapshot = JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8")) as SnapshotRecordV1;
  const manifest = { ...snapshot.manifest, files: snapshot.manifest.files.map((entry) => entry.path === path ? { ...entry, byteLength: String(bytes.length), sha256: sha256Hex(bytes) } : entry) };
  writeFileSync(join(root, "snapshot.json"), canonicalJsonBytes({ ...snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } as unknown as JsonValue));
}

describe("recognized reference atlas assets", () => {
  it.each([
    ["ID/path mismatch", (atlas: Atlas) => ({ ...atlas, id: "other_sheet" })],
    ["world mismatch", (atlas: Atlas) => ({ ...atlas, worldId: "world:other" })],
    ["unknown source", (atlas: Atlas) => ({ ...atlas, provenance: { ...atlas.provenance, sourceId: "source:missing" } })],
  ] as const)("rejects coherently rehashed %s", (_name, change) => {
    const root = mkdtempSync(join(tmpdir(), "wmm-atlas-loader-"));
    try {
      const directory = join(root, "bundle"), input = project();
      buildAuthoringBundle(input, directory);
      replaceAtlas(directory, change(input.atlases![0]!));
      expect(() => loadReleaseWorldBundle(directory)).toThrow(/atlas/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects a rehashed map whose geographic entity is actually a faction", () => {
    const root = mkdtempSync(join(tmpdir(), "wmm-atlas-loader-"));
    try {
      const directory = join(root, "bundle"), input = project();
      buildAuthoringBundle(input, directory);
      const atlas = input.atlases![0]!;
      replaceAtlas(directory, { ...atlas, features: [{ ...atlas.features[0]!, entityId: "faction:auren_crown" }, ...atlas.features.slice(1)] });
      expect(() => loadReleaseWorldBundle(directory)).toThrow(/atlas|place/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
