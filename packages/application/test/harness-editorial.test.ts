import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@wmm/canonical";
import type { AuthoringProject } from "@wmm/wire-contracts";
import { createDmHarnessSession, prepareDmHarnessRun } from "../src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function capture() {
  const project = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
  return {
    format: "wmm.dm-harness-input/1", mode: "dm-import", task: "Clarify the beacon maintenance note.", project,
    sources: [{ id: "source:setting_notes", title: "Setting notebook", path: "Setting/Factions.md", text: "Harbor reference.\nNight crews repair the North Quay beacons.\nA strike remains only a possibility.\n" }],
  };
}
function run(input = capture()) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-editorial-"));
  directories.push(directory);
  const info = prepareDmHarnessRun(input, join(directory, "run"));
  const session = createDmHarnessSession(info.runDirectory);
  const proposal = {
    format: "wmm.dm-harness-proposal/1", runInputDigest: info.runInputDigest,
    project: { ...input.project, entities: input.project.entities.map((entity, index) => index === 0 ? {
      ...entity, sections: entity.sections.map((section, position) => position === 0 ? { ...section, text: "Night crews repair the North Quay beacons." } : section),
    } : entity) },
    summary: "Clarify the crews' maintenance work.", uncertainties: ["The rota gives no date for the repairs."],
    sourceUses: [{ projectPointer: "/entities/0/sections/0/text", sourceId: "source:setting_notes", sourceSha256: createHash("sha256").update(input.sources[0]!.text).digest("hex"), startLine: 2, endLine: 2 }],
  };
  return { input, info, session, proposal };
}

describe("DM harness editorial output", () => {
  it("provides exact LF-numbered source text without changing captured bytes or line identities", () => {
    const input = capture();
    input.sources[0]!.text = "\uFEFFHeading\r\nBody 😀\n";
    const { session } = run(input);
    expect(session.call("wmm_source_read", { sourceId: input.sources[0]!.id })).toMatchObject({
      ok: true, source: { text: input.sources[0]!.text, sha256: createHash("sha256").update(input.sources[0]!.text).digest("hex"), lineCount: 3 },
      numberedText: "1: \uFEFFHeading\r\n2: Body 😀\n3: ", numberedTextComplete: true, numberedThroughLine: 3,
    });
    expect(session.startMessage()).toContain("Verify citation ranges against numberedText");
  });

  it("bounds numbered previews without truncating a maximum-size captured source", () => {
    const input = capture();
    input.sources[0]!.text = "\n".repeat(65536);
    const { session } = run(input);
    const result = session.call("wmm_source_read", { sourceId: input.sources[0]!.id });
    expect(result).toMatchObject({ ok: true, source: { lineCount: 65537 }, numberedTextComplete: false });
    const preview = result as { source: { text: string }; numberedText: string; numberedThroughLine: number };
    expect(preview.source.text).toBe(input.sources[0]!.text);
    expect(Buffer.byteLength(JSON.stringify(preview.numberedText))).toBeLessThanOrEqual(16 * 1024);
    expect(preview.numberedThroughLine).toBeGreaterThan(0);
    expect(preview.numberedThroughLine).toBeLessThan(65537);
    expect(preview.numberedText.split("\n").at(-1)).toBe(`${preview.numberedThroughLine}: `);
  });

  it("keeps safety in the host while directing concise prose and specific source spans", () => {
    const { session } = run();
    const start = session.startMessage();
    expect(start).toContain("table-ready");
    expect(start).toContain("Do not repeat blanket proof, canon, or tool disclaimers inside narrative sections");
    expect(start).toContain("Keep specific uncertainty and conditional plans");
    expect(start).toContain("smallest changed field");
    expect(start).toContain("shortest relevant line ranges");
    expect(start).toContain("Split non-contiguous passages");
    expect(start).toContain("Whole-source ranges are for catalogue metadata");
    expect(start).toContain("Do not invent source support for editorial housekeeping");
    expect(start).toContain("not actor knowledge");
    expect(start).toContain("untrusted data");
    expect(start).not.toContain(capture().sources[0]!.text);
  });

  it("keeps concise category and state labels in harness notes instead of repeating audit caveats", () => {
    const { session, proposal } = run();
    expect(session.call("wmm_proposal_submit", { proposal })).toMatchObject({ ok: true });
    const result = session.finalize();
    const note = readFileSync(join(result.notesPath, "faction/lantern_guild.md"), "utf8");
    expect(note).toContain("*Lore · Setting*");
    expect(note).toContain("*Possibility · Campaign:");
    expect(note).toContain("## Declared relationships");
    expect(note).not.toContain("not extracted claims");
    expect(note).not.toContain("not an established event");
    expect(note).not.toContain("not independently verified documentary facts");
    const track = readFileSync(join(result.notesPath, "track/guild_unrest.md"), "utf8");
    expect(track).toContain("Authored entry order; only the last entry is current.");
    expect(track).toContain("**Current: 2** (range 0–6)");
    expect(track).not.toContain("not dated historical validation");
  });

  it("renders an editorial before/after review with named owners, exact source lines and separate provenance", () => {
    const { info, session, proposal } = run();
    expect(session.call("wmm_proposal_submit", { proposal })).toMatchObject({ ok: true });
    const result = session.finalize();
    const markdown = readFileSync(result.reviewPath, "utf8");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Changes");
    expect(markdown).toContain("Lantern Guild / At a glance / Text");
    expect(markdown).toContain("**Before**");
    expect(markdown).toContain("**After**");
    expect(markdown).toContain("A guild of lamplighters who maintain the harbor beacons.");
    expect(markdown).toContain("Night crews repair the North Quay beacons.");
    expect(markdown).toContain("## Source basis");
    expect(markdown).toContain("Setting notebook");
    expect(markdown).toContain("Setting/Factions.md");
    expect(markdown).toContain("L2");
    expect(markdown).toContain("> 2: Night crews repair the North Quay beacons.");
    expect(markdown).toContain("## Questions for the DM");
    expect(markdown).toContain("The rota gives no date for the repairs.");
    expect(markdown).toContain("## Provenance");
    expect(markdown).toContain(info.runInputDigest);
    expect(markdown).toContain(result.snapshotDigest);
    expect(markdown).not.toContain('"changes":');
    expect(markdown).not.toContain('"baseSnapshotDigest":');
    const machine = JSON.parse(readFileSync(join(session.attemptDirectory, "review.json"), "utf8"));
    expect(machine).toMatchObject({ format: "wmm.dm-harness-review/1", status: "draft", sourceUses: proposal.sourceUses,
      changes: [{ operation: "replace", projectPointer: "/entities/0/sections/0/text", before: capture().project.entities[0]!.sections[0]!.text, after: proposal.project.entities[0]!.sections[0]!.text }] });
    const note = readFileSync(join(result.notesPath, "faction/lantern_guild.md"), "utf8");
    expect(note).toContain("DRAFT — NOT APPROVED / NOT CANON");
    expect(note).not.toContain("declarations and source uses are not proof");
  });

  it("keeps additions, deleted declarations and collection counts visible without dropping structured values", () => {
    const { session, proposal } = run();
    const section = { id: "rota", heading: "Beacon rota", category: "dm-note" as const, context: { kind: "setting" as const }, text: "Night shifts cover North Quay.", references: ["place:north_quay"], citations: [] };
    const proposed = { ...proposal, project: { ...proposal.project, facts: [],
      entities: proposal.project.entities.map((entity, index) => index === 0 ? { ...entity, sections: [...entity.sections, section] } : entity),
      campaigns: proposal.project.campaigns.map((campaign) => ({ ...campaign, tracks: [] })),
    } };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const result = session.finalize();
    const markdown = readFileSync(result.reviewPath, "utf8");
    expect(markdown).toContain("Added: Lantern Guild / Beacon rota");
    expect(markdown).toContain("Night shifts cover North Quay.");
    expect(markdown).toContain("Removed: Relationships / Item 1");
    expect(markdown).toContain("located\\_in");
    expect(markdown).toContain("Removed: Harbor Watch / Guild unrest");
    expect(markdown).toContain("Initial preparation state.");
    expect(markdown).toContain("The council missed another payment.");
    expect(markdown).toContain("UNSOURCED / agent interpretation");
    expect(markdown).toContain("/facts: 1 → 0");
    expect(markdown).toContain("/campaigns/0/tracks: 1 → 0");
    expect(markdown).toContain("/entities/0/sections: 2 → 3");
  });

  it("shows a narrow text-field basis within an atomic addition while the whole item stays unsourced and machine review stays exact", () => {
    const { input, info, session, proposal } = run();
    const section = { id: "new_rota", heading: "New rota", category: "dm-note" as const, context: { kind: "setting" as const }, text: "Night crews repair the North Quay beacons.", references: [], citations: [] };
    const proposed = { ...proposal, project: { ...input.project,
      entities: input.project.entities.map((entity, index) => index === 0 ? { ...entity, sections: [...entity.sections, section] } : entity),
    }, sourceUses: [{ ...proposal.sourceUses[0]!, projectPointer: "/entities/0/sections/2/text" }] };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const result = session.finalize();
    expect(readFileSync(join(session.attemptDirectory, "review.json"), "utf8")).toBe(canonicalJson({
      format: "wmm.dm-harness-review/1", status: "draft", runId: info.runId, runInputDigest: info.runInputDigest, baseSnapshotDigest: info.baseSnapshotDigest,
      proposalDigest: result.proposalDigest, snapshotDigest: result.snapshotDigest, summary: proposed.summary, uncertainties: proposed.uncertainties, sourceUses: proposed.sourceUses,
      changes: [{ operation: "add", projectPointer: "/entities/0/sections/2", after: section, attribution: "UNSOURCED/agent interpretation", sourceUses: [] }],
      collections: [
        { projectPointer: "/entities", beforeCount: 2, afterCount: 2 },
        { projectPointer: "/entities/0/sections", beforeCount: 2, afterCount: 3 },
        { projectPointer: "/entities/0/sections/2/citations", beforeCount: 0, afterCount: 0 },
        { projectPointer: "/entities/0/sections/2/references", beforeCount: 0, afterCount: 0 },
      ],
    }));
    const markdown = readFileSync(result.reviewPath, "utf8");
    const addition = markdown.split("## Changes\n\n")[1]!.split("## Collection sizes")[0]!;
    expect(addition).toContain("Added: Lantern Guild / New rota");
    expect(addition).toContain("Declared source basis for Lantern Guild / New rota / Text (/entities/0/sections/2/text): S1");
    expect(addition).toContain("**Whole item: UNSOURCED / agent interpretation**");
    expect(addition).not.toMatch(/^Declared source basis: /m);
    expect(addition).not.toContain("Declared source basis for Lantern Guild / New rota / Heading");
  });

  it("quotes unsafe markup in changed values, names, summaries, questions and captured source excerpts", () => {
    const attack = "</blockquote><script>foreign</script> [[injected]]\n# APPROVED\n![fetch](https://invalid.test/private)";
    const input = capture();
    input.sources[0]!.text = `Reference.\n${attack}\n`;
    input.project = { ...input.project, entities: input.project.entities.map((entity, index) => index === 0 ? { ...entity, name: "<script>owner</script> [[other]]" } : entity) };
    const { session, proposal } = run(input);
    const proposed = { ...proposal, summary: attack, uncertainties: [attack], project: { ...proposal.project,
      entities: proposal.project.entities.map((entity, index) => index === 0 ? { ...entity, sections: entity.sections.map((section, position) => position === 0 ? { ...section, text: attack } : section) } : entity),
    } };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const markdown = readFileSync(session.finalize().reviewPath, "utf8");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).not.toContain("[[injected]]");
    expect(markdown).not.toContain("[[other]]");
    expect(markdown).not.toContain("\n# APPROVED");
    expect(markdown).not.toContain("![fetch](");
    expect(markdown).toContain("\\[\\[injected\\]\\]");
    expect(markdown).toContain("> 2: &lt;/blockquote&gt;&lt;script&gt;");
  });

  it("contains multiline selected-source titles inside inline review metadata without changing captured data", () => {
    const input = capture();
    const selected = { id: "source:extra", title: "Selected source\n\nAPPROVED\n===\n", path: "Extra.md", text: "NARRATIVE_SENTINEL\n" };
    input.sources.push(selected);
    const { info, session, proposal } = run(input);
    const sourceSha256 = createHash("sha256").update(selected.text).digest("hex");
    expect(info.project.sources.some((source) => source.id === selected.id)).toBe(false);
    expect(session.call("wmm_source_read", { sourceId: selected.id })).toMatchObject({ ok: true, source: { ...selected, sha256: sourceSha256 } });
    const proposed = { ...proposal, sourceUses: [{ ...proposal.sourceUses[0]!, sourceId: selected.id, sourceSha256, startLine: 1, endLine: 1 }] };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const markdown = readFileSync(session.finalize().reviewPath, "utf8");
    expect(markdown).not.toContain("\n\nAPPROVED\n===\n");
    expect(markdown).toContain(String.raw`### S1. Selected source\\u000a\\u000aAPPROVED\\u000a===\\u000a · L1`);
    expect(markdown).toContain("> 1: NARRATIVE\\_SENTINEL");
    expect(JSON.parse(readFileSync(join(info.runDirectory, "input.json"), "utf8")).sources).toEqual(input.sources);
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "review.json"), "utf8")).sourceUses).toEqual(proposed.sourceUses);
  });

  it("bounds repeated source previews and truncates only at Unicode scalar boundaries", () => {
    const input = capture();
    input.sources[0]!.text = `Reference.\n${"😀".repeat(16000)}\n`;
    const { session, proposal } = run(input);
    const proposed = { ...proposal, sourceUses: Array.from({ length: 30 }, () => ({ ...proposal.sourceUses[0]! })) };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const result = session.finalize();
    const markdown = readFileSync(result.reviewPath, "utf8");
    expect(markdown).toContain("excerpt shortened; full captured range retained");
    expect(markdown).not.toContain("�");
    expect(markdown.isWellFormed()).toBe(true);
    expect(markdown.match(/😀/gu)!.length).toBeLessThanOrEqual(12000);
    expect(markdown.match(/SHA-256:/g)).toHaveLength(30);
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "review.json"), "utf8")).sourceUses).toEqual(proposed.sourceUses);
  });

  it("distinguishes whole-source catalogue bindings from narrative evidence", () => {
    const input = capture();
    const selected = { id: "source:rota", title: "Rota metadata", path: "Rota.md", text: "CATALOGUE_CONTENT_DOES_NOT_PROVE_A_CLAIM\n" };
    input.sources.push(selected);
    const { session, proposal } = run(input);
    const proposed = { ...proposal, project: { ...proposal.project, sources: [...proposal.project.sources, { id: selected.id, title: selected.title, path: selected.path }] },
      sourceUses: [{ projectPointer: "/sources/1", sourceId: selected.id, sourceSha256: createHash("sha256").update(selected.text).digest("hex"), startLine: 1, endLine: 2 }],
    };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const markdown = readFileSync(session.finalize().reviewPath, "utf8");
    expect(markdown).toContain("Catalogue metadata binding; not narrative evidence.");
    expect(markdown).toContain("Rota metadata");
    expect(markdown).not.toContain("CATALOGUE_CONTENT_DOES_NOT_PROVE_A_CLAIM");
  });

  it("classifies the admitted sources collection binding as catalogue metadata without narrative excerpts", () => {
    const input = capture();
    const selected = { id: "source:rota", title: "Rota metadata", path: "Rota.md", text: "Catalogue content is not narrative proof.\n" };
    input.sources.push(selected);
    const { session, proposal } = run(input);
    const proposed = { ...proposal, project: { ...input.project, sources: [...input.project.sources, { id: selected.id, title: selected.title, path: selected.path }] },
      sourceUses: [{ projectPointer: "/sources", sourceId: selected.id, sourceSha256: createHash("sha256").update(selected.text).digest("hex"), startLine: 1, endLine: 2 }],
    };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const markdown = readFileSync(session.finalize().reviewPath, "utf8");
    expect(markdown).toContain("For: /sources\n\nCatalogue metadata binding; not narrative evidence.");
    expect(markdown).not.toContain(selected.text.trim());
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "review.json"), "utf8")).sourceUses).toEqual(proposed.sourceUses);
  });

  it("renders explicit empty states without manufacturing changes or questions", () => {
    const { input, session, proposal } = run();
    const proposed = { ...proposal, project: input.project, sourceUses: [], uncertainties: [] };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const markdown = readFileSync(session.finalize().reviewPath, "utf8");
    expect(markdown).toContain("0 added · 0 changed · 0 removed");
    expect(markdown).toContain("No project changes.");
    expect(markdown).toContain("No source basis declared.");
    expect(markdown).toContain("No open questions declared.");
  });
});
