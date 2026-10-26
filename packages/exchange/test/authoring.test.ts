import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "@wmm/canonical";
import type { AuthoringIndex, AuthoringProject, JsonValue, SnapshotRecordV1 } from "@wmm/wire-contracts";
import { queryActiveClaims, authoringScope, authoringSemantics } from "@wmm/core";
import { buildAuthoringBundle, loadBundledV1WorldBundle, loadReleaseWorldBundle, renderDmNotes, writeDmNotes } from "../src/index.js";
import { writeNewAuthoringDirectory } from "../src/authoring.js";

function project(): unknown {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as unknown;
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function replaceIndex(root: string, index: AuthoringIndex): void {
  writeFileSync(join(root, "payload/authoring/index.json"), canonicalJsonBytes(index as unknown as JsonValue));
  const snapshot = JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8")) as SnapshotRecordV1;
  const manifest = { ...snapshot.manifest, files: snapshot.manifest.files.map((entry) => {
    const bytes = readFileSync(join(root, "payload", entry.path));
    return { ...entry, byteLength: String(bytes.length), sha256: sha256Hex(bytes) };
  }) };
  writeFileSync(join(root, "snapshot.json"), canonicalJsonBytes({ ...snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } as unknown as JsonValue));
}

describe("authored bundle and DM notes", () => {
  it("loads through the release loader and renders linked notes from a reloaded snapshot", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-"));
    try {
      const bundle = buildAuthoringBundle(project(), join(root, "bundle"));
      const loaded = loadReleaseWorldBundle(join(root, "bundle"));
      expect(loaded.snapshot.snapshotDigest).toBe(bundle.snapshot.snapshotDigest);
      const notes = renderDmNotes(loaded);
      expect(notes).toEqual(renderDmNotes(loaded));
      const text = notes.files.find((file) => file.path === "faction/lantern_guild.md")!.text;
      expect(text).toContain("# Lantern Guild");
      expect(text).toContain("[[place/north_quay|North Quay]]");
      expect(text).toContain("Possibility — not an established event");
      expect(text).toContain("Setting/Factions.md");
      const track = notes.files.find((file) => file.path === "track/guild_unrest.md")!.text;
      expect(track).toContain("**Current: 2** (range 0–6)");
      expect(track).toContain("Authored entry order; not dated historical validation");
      writeDmNotes(notes, join(root, "notes"));
      expect(readFileSync(join(root, "notes", "faction", "lantern_guild.md"), "utf8")).toBe(text);
      const setting = queryActiveClaims({ ...loaded, ...loaded.world }, authoringScope({ kind: "setting" }), {
        format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: authoringSemantics().definitionDigestsByKey["days"]!, position: "0",
      });
      expect(setting.definite).toHaveLength(1);
      expect(loaded.assertions.find((record) => record.id === setting.definite[0]!.assertionId)!.body.proposition).toMatchObject({ subjectId: "faction:lantern_guild" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("builds byte-identical artifacts in two destinations without modifying the fixture", () => withRoot((root) => {
    const first = buildAuthoringBundle(project(), join(root, "first"));
    const second = buildAuthoringBundle(project(), join(root, "second"));
    expect(first.snapshot).toEqual(second.snapshot);
    for (const entry of first.snapshot.manifest.files) expect(readFileSync(join(root, "first/payload", entry.path))).toEqual(readFileSync(join(root, "second/payload", entry.path)));
    expect(renderDmNotes(first)).toEqual(renderDmNotes(second));
    expect(() => loadBundledV1WorldBundle(join(root, "first"))).toThrow(/release-allowlisted/);
  }));

  it("builds and reloads at the inclusive directory-count limit, rejecting the next directory before writes", () => withRoot((root) => {
    const input = (entityCount: number) => ({
      format: "wmm.authoring-project/1", worldId: "world:directory_limit", title: "Directory bound", sources: [], facts: [], campaigns: [],
      entities: Array.from({ length: entityCount }, (_, position) => ({
        id: `person:p${position}`, name: `Person ${position}`, sections: [{
          id: "overview", heading: "Overview", category: "lore", context: { kind: "setting" }, text: "Short narrative", references: [], citations: [],
        }],
      })),
    });
    const directory = join(root, "boundary");
    const bundle = buildAuthoringBundle(input(989), directory);
    expect(1 + readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory()).length).toBe(1000);
    expect(loadReleaseWorldBundle(directory).snapshot).toEqual(bundle.snapshot);
    expect(() => buildAuthoringBundle(input(990), join(root, "not-created/overflow"))).toThrow(/directory/i);
    expect(existsSync(join(root, "not-created"))).toBe(false);
  }));

  it("keeps campaign states separate for the same faction with no implicit setting inheritance", () => withRoot((root) => {
    const original = project() as AuthoringProject;
    const other = { ...original.campaigns[0]!, id: "campaign:other", name: "Another Campaign", tracks: [{ ...original.campaigns[0]!.tracks[0]!, id: "track:other_unrest", entries: [{ value: 5, note: "Separate playthrough", citations: [] }] }] };
    const bundle = buildAuthoringBundle({ ...original, campaigns: [...original.campaigns, other] }, join(root, "bundle"));
    const temporal = { format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: authoringSemantics().definitionDigestsByKey["days"]!, position: "0" } as const;
    const snapshot = { ...bundle, ...bundle.world };
    const query = queryActiveClaims(snapshot, authoringScope({ kind: "campaign", campaignId: "campaign:other" }), temporal);
    expect(query.definite).toHaveLength(4);
    expect(query.definite.every((item) => bundle.assertions.find((record) => record.id === item.assertionId)!.body.proposition.kind === "atom")).toBe(true);
    expect(query.excluded.length).toBeGreaterThan(0);
    const notes = renderDmNotes(bundle);
    expect(notes.files.find((file) => file.path === "track/other_unrest.md")!.text).toContain("**Current: 5**");
    expect(notes.files.find((file) => file.path === "track/guild_unrest.md")!.text).toContain("**Current: 2**");
  }));

  it("changes structured track state without silently changing the setting relationship", () => withRoot((root) => {
    const original = project() as AuthoringProject;
    const changed = { ...original, campaigns: [{ ...original.campaigns[0]!, tracks: [{ ...original.campaigns[0]!.tracks[0]!, entries: [...original.campaigns[0]!.tracks[0]!.entries, { value: 3, note: "Authored test update, not an inferred consequence", citations: [] }] }] }] };
    const first = buildAuthoringBundle(original, join(root, "first"));
    const second = buildAuthoringBundle(changed, join(root, "second"));
    expect(first.snapshot.snapshotDigest).not.toBe(second.snapshot.snapshotDigest);
    const settingIds = (bundle: typeof first) => bundle.assertions.filter((record) => record.body.scope.account.kind === "ref" && record.body.scope.account.id === "account:setting").map((record) => record.id);
    expect(settingIds(first)).toEqual(settingIds(second));
    expect(renderDmNotes(second).files.find((file) => file.path === "track/guild_unrest.md")!.text).toContain("**Current: 3**");
    expect(renderDmNotes(first).files.find((file) => file.path === "track/guild_unrest.md")!.text).toContain("**Current: 2**");
  }));

  it("rejects a rehashed but stale or dangling presentation index", () => withRoot((root) => {
    const directory = join(root, "bundle");
    buildAuthoringBundle(project(), directory);
    const index = JSON.parse(readFileSync(join(directory, "payload/authoring/index.json"), "utf8")) as AuthoringIndex;
    const edited = { ...index, notes: index.notes.map((note) => ({ ...note, sections: note.sections.map((section) => ({ ...section, references: ["place:absent"] })) })) };
    replaceIndex(directory, edited);
    const loaded = loadReleaseWorldBundle(directory); // General world validation is not presentation validation.
    expect(() => renderDmNotes(loaded)).toThrow(/differs from its compiled input/);
  }));

  it("never overwrites an existing bundle or note destination, including empty directories", () => withRoot((root) => {
    const bundle = buildAuthoringBundle(project(), join(root, "bundle"));
    const originalSnapshot = readFileSync(join(root, "bundle/snapshot.json"));
    expect(() => buildAuthoringBundle(project(), join(root, "bundle"))).toThrow(/already exists/);
    expect(readFileSync(join(root, "bundle/snapshot.json"))).toEqual(originalSnapshot);
    mkdirSync(join(root, "empty"));
    expect(() => writeDmNotes(renderDmNotes(bundle), join(root, "empty"))).toThrow(/already exists/);
    expect(() => buildAuthoringBundle({}, join(root, "bad"))).toThrow(/Invalid authoring project/);
    expect(existsSync(join(root, "bad"))).toBe(false);
  }));

  it("rejects symlinked destinations and unsafe generated paths without writing through them", () => withRoot((root) => {
    const bundle = buildAuthoringBundle(project(), join(root, "bundle"));
    const notes = renderDmNotes(bundle);
    mkdirSync(join(root, "external"));
    symlinkSync(join(root, "external"), join(root, "link"));
    expect(() => writeDmNotes(notes, join(root, "link/notes"))).toThrow(/real directories/);
    expect(() => writeDmNotes(notes, join(root, "link"))).toThrow(/real directories/);
    expect(() => writeDmNotes({ ...notes, files: [{ path: "../escape.md", text: "bad" }] }, join(root, "unsafe"))).toThrow(/Unsafe/);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
    expect(existsSync(join(root, "unsafe"))).toBe(false);
    expect(existsSync(join(root, "external/notes"))).toBe(false);
  }));

  it.each(["build", "notes", "shared"] as const)("rejects %s outputs inside existing bundles, including path aliases, before creating any directories", (writer) => withRoot((root) => {
    const directory = join(root, "bundle");
    const bundle = buildAuthoringBundle(project(), directory);
    const notes = renderDmNotes(bundle);
    symlinkSync(directory, join(root, "bundle-alias"));
    symlinkSync(join(directory, "payload"), join(root, "payload-alias"));
    const before = readdirSync(directory, { recursive: true }).sort();
    const snapshot = readFileSync(join(directory, "snapshot.json"));
    const destinations = [
      join(directory, "output"),
      join(directory, "payload/output"),
      join(directory, "payload/not-created/deep/output"),
      `${directory}/payload/../output`,
      relative(process.cwd(), join(directory, "output")),
      join(root, "bundle-alias/output"),
      join(root, "payload-alias/not-created/output"),
    ];
    for (const destination of destinations) {
      expect(() => {
        if (writer === "build") buildAuthoringBundle(project(), destination);
        else if (writer === "notes") writeDmNotes(notes, destination);
        else writeNewAuthoringDirectory(destination, [{ path: "output.md", bytes: new TextEncoder().encode("No writes") }]);
      }, destination).toThrow(/inside.*world bundle|real directories/);
      expect(readdirSync(directory, { recursive: true }).sort()).toEqual(before);
      expect(readFileSync(join(directory, "snapshot.json"))).toEqual(snapshot);
    }
    expect(loadReleaseWorldBundle(directory).snapshot).toEqual(bundle.snapshot);
  }));
});
