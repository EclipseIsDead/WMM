import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "@wmm/canonical";
import type { AuthoringIndex, AuthoringProject, JsonValue, SnapshotRecordV1 } from "@wmm/wire-contracts";
import { describe, expect, it } from "vitest";

import { buildAuthoringBundle, entityContextFromBundle, loadReleaseWorldBundle } from "../src/index.js";

function withBundle(test: (directory: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-entity-context-"));
  try {
    const project: unknown = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8"));
    const directory = join(root, "bundle");
    buildAuthoringBundle(project, directory);
    test(directory);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("entity context bundle boundary", () => {
  it("reads exact verified narrative bytes without requiring generated Markdown views", () => withBundle((directory) => {
    const bundle = loadReleaseWorldBundle(directory);
    const packet = entityContextFromBundle(bundle, { entityId: "faction:lantern_guild", campaignId: "campaign:harbor_watch" });
    for (const section of packet.sections) {
      expect(new TextEncoder().encode(section.text)).toEqual(Uint8Array.from(bundle.documents.find((document) => document.path === section.path)!.bytes));
      expect(section.sha256).toBe(sha256Hex(new TextEncoder().encode(section.text)));
    }
  }));

  it.each([1, 2])("preserves leading U+FEFF text/hash correspondence through verified bundle loading (%i characters)", (count) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-entity-context-"));
    try {
      const project = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
      const text = `${"\uFEFF".repeat(count)}Original narrative`;
      const directory = join(root, "bundle");
      buildAuthoringBundle({ ...project, entities: [{ ...project.entities[0]!, sections: [{ ...project.entities[0]!.sections[0]!, text }] }, project.entities[1]!] }, directory);
      const bundle = loadReleaseWorldBundle(directory);
      const packet = entityContextFromBundle(bundle, { entityId: "faction:lantern_guild" });
      const section = packet.sections[0]!;
      const capturedBytes = Uint8Array.from(bundle.documents.find((document) => document.path === section.path)!.bytes);
      expect(capturedBytes).toEqual(new TextEncoder().encode(text));
      expect(section.sha256).toBe(sha256Hex(capturedBytes));
      expect(section.sha256).toBe(sha256Hex(new TextEncoder().encode(section.text)));
      expect(section.text).toBe(text);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects rehashed presentation metadata that no longer corresponds to captured authoring data", () => withBundle((directory) => {
    const path = join(directory, "payload/authoring/index.json");
    const index = JSON.parse(readFileSync(path, "utf8")) as AuthoringIndex;
    const changed = { ...index, notes: index.notes.map((note) => note.id === "faction:lantern_guild" ? { ...note, name: "Invented faction name" } : note) };
    writeFileSync(path, canonicalJsonBytes(changed as unknown as JsonValue));
    const snapshot = JSON.parse(readFileSync(join(directory, "snapshot.json"), "utf8")) as SnapshotRecordV1;
    const manifest = { ...snapshot.manifest, files: snapshot.manifest.files.map((entry) => {
      const bytes = readFileSync(join(directory, "payload", entry.path));
      return { ...entry, byteLength: String(bytes.length), sha256: sha256Hex(bytes) };
    }) };
    writeFileSync(join(directory, "snapshot.json"), canonicalJsonBytes({ ...snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } as unknown as JsonValue));
    const admitted = loadReleaseWorldBundle(directory);
    expect(() => entityContextFromBundle(admitted, { entityId: "faction:lantern_guild" })).toThrow(/differs from its compiled input/);
  }));

  it("refuses missing captured prose rather than substituting an empty narrative", () => withBundle((directory) => {
    const bundle = loadReleaseWorldBundle(directory);
    const withoutProse = { ...bundle, documents: bundle.documents.filter((document) => !document.path.startsWith("prose/")) };
    expect(() => entityContextFromBundle(withoutProse, { entityId: "faction:lantern_guild" })).toThrow(expect.objectContaining({ code: "INVALID_CONTEXT_INPUT" }));
  }));

  it("rejects malformed requests before evaluating captured authoring correspondence", () => withBundle((directory) => {
    const bundle = loadReleaseWorldBundle(directory);
    const missingInput = { ...bundle, documents: [] };
    expect(() => entityContextFromBundle(missingInput, { entityId: "Faction:bad" })).toThrow(expect.objectContaining({ code: "INVALID_CONTEXT_REQUEST" }));
  }));
});
