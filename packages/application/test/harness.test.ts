import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@wmm/canonical";
import { compileAuthoringProject } from "@wmm/core";
import { loadReleaseWorldBundle, validateWorldBundle, verifyAuthoringBundlePresentation } from "@wmm/exchange";
import { authoringProjectSchema } from "@wmm/wire-contracts";
import type { AuthoringProject } from "@wmm/wire-contracts";
import * as application from "../src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "wmm-dm-harness-"));
  directories.push(directory);
  return directory;
}
function project(): AuthoringProject {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
}
function capture() {
  return { format: "wmm.dm-harness-input/1", mode: "dm-import", task: "Clarify the beacon keepers' description; retain declared state.", project: project(),
    sources: [{ id: "source:setting_notes", title: "Setting notebook", path: "Setting/Factions.md", text: "\ufeffBeacons stay lit.\r\nA strike is only possible.\n" }] };
}
function sha(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function proposal(runInputDigest: string) {
  const base = project();
  return { format: "wmm.dm-harness-proposal/1", runInputDigest,
    project: { ...base, entities: base.entities.map((entity, index) => index === 0 ? { ...entity, sections: entity.sections.map((section, position) => position === 0 ? { ...section, text: "The beacon keepers maintain lights at North Quay." } : section) } : entity) },
    summary: "Clarified description.", uncertainties: ["No dated event is asserted."],
    sourceUses: [{ projectPointer: "/entities/0/sections/0/text", sourceId: "source:setting_notes", sourceSha256: sha(capture().sources[0]!.text), startLine: 1, endLine: 2 }],
  };
}

describe("DM harness scoped session", () => {
  it("finalizes the admitted project through build, ordinary load, verified presentation and manifest-correct DRAFT notes", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    expect(Reflect.get(session, "finalize")).toBeTypeOf("function");
    expect(() => session.finalize()).toThrow(/proposal/i);
    const draft = proposal(run.runInputDigest);
    expect(session.call("wmm_proposal_submit", { proposal: draft })).toMatchObject({ ok: true });
    const result = session.finalize();
    expect(result).toMatchObject({ format: "wmm.dm-harness-result/1", status: "draft", runId: run.runId, runInputDigest: run.runInputDigest, baseSnapshotDigest: run.baseSnapshotDigest, runDirectory: run.runDirectory, attemptDirectory: session.attemptDirectory });
    expect(result.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshotDigest).not.toBe(result.baseSnapshotDigest);
    const bundle = loadReleaseWorldBundle(result.bundlePath);
    expect(validateWorldBundle(bundle)).toMatchObject({ snapshotDigest: result.snapshotDigest });
    expect(verifyAuthoringBundlePresentation(bundle).project).toEqual(draft.project);
    const readable = JSON.parse(readFileSync(result.projectPath, "utf8")) as AuthoringProject;
    expect(readable).toEqual(draft.project);
    expect(readable.facts).toHaveLength(1);
    expect(readable.campaigns[0]!.tracks[0]!.entries).toHaveLength(2);
    const manifest = JSON.parse(readFileSync(join(result.notesPath, "wmm-notes.json"), "utf8")) as { files: { path: string; sha256: string; byteLength: string }[] };
    for (const file of manifest.files) {
      const text = readFileSync(join(result.notesPath, file.path), "utf8");
      expect(text).toContain("DRAFT");
      expect(sha(text)).toBe(file.sha256);
      expect(String(Buffer.byteLength(text))).toBe(file.byteLength);
    }
    const entityNote = readFileSync(join(result.notesPath, "faction/lantern_guild.md"), "utf8");
    expect(entityNote).toMatch(/^---\nwmm_id:/);
    expect(entityNote).toContain("[[place/north_quay|");
    expect(readFileSync(join(result.notesPath, "track/guild_unrest.md"), "utf8")).toContain("**Current: 2**");
    expect(readFileSync(result.reviewPath, "utf8")).toContain("not proof");
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "result.json"), "utf8"))).toEqual(result);
    expect(() => session.finalize()).toThrow();
  });

  it("makes every explicit collection deletion visible and labels undeclared changes UNSOURCED in an escaped review", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const draft = proposal(run.runInputDigest);
    const proposed = { ...draft, summary: "</blockquote><script>not executable</script> [[injected]]\n# APPROVED", project: { ...draft.project, facts: [],
      campaigns: draft.project.campaigns.map((campaign) => ({ ...campaign, tracks: [] })),
      entities: draft.project.entities.map((entity, index) => index === 0 ? { ...entity, sections: entity.sections.slice(0, 1) } : entity) } };
    expect(session.call("wmm_proposal_submit", { proposal: proposed })).toMatchObject({ ok: true });
    const result = session.finalize();
    const review = JSON.parse(readFileSync(join(session.attemptDirectory, "review.json"), "utf8")) as { changes: unknown[]; collections: unknown[] };
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "remove", projectPointer: "/facts/0", before: project().facts[0], attribution: "UNSOURCED/agent interpretation" }),
      expect.objectContaining({ operation: "remove", projectPointer: "/campaigns/0/tracks/0", before: project().campaigns[0]!.tracks[0], attribution: "UNSOURCED/agent interpretation" }),
      expect.objectContaining({ operation: "remove", projectPointer: "/entities/0/sections/1", before: project().entities[0]!.sections[1] }),
      expect.objectContaining({ operation: "replace", projectPointer: "/entities/0/sections/0/text", attribution: "declared-source-basis" }),
    ]));
    expect(review.collections).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectPointer: "/facts", beforeCount: 1, afterCount: 0 }),
      expect.objectContaining({ projectPointer: "/campaigns/0/tracks", beforeCount: 1, afterCount: 0 }),
      expect.objectContaining({ projectPointer: "/entities/0/sections", beforeCount: 2, afterCount: 1 }),
    ]));
    const markdown = readFileSync(result.reviewPath, "utf8");
    expect(markdown).toContain("UNSOURCED");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\[\\[injected\\]\\]");
    expect(markdown).not.toContain("\n# APPROVED");
  });

  it.each(["run", "input", "attempt", "submission", "proposal"])("rechecks retained %s binding at finalization and retains a terminal failure", (target) => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    expect(session.call("wmm_proposal_submit", { proposal: proposal(run.runInputDigest) })).toMatchObject({ ok: true });
    const path = join(target === "run" || target === "input" ? run.runDirectory : session.attemptDirectory, `${target}.json`);
    const retained = JSON.parse(readFileSync(path, "utf8")) as { [key: string]: import("@wmm/wire-contracts").JsonValue };
    if (target === "proposal") retained["summary"] = "Changed retained proposal";
    else if (target === "input") retained["task"] = "Changed retained task";
    else retained["runInputDigest"] = "0".repeat(64);
    writeFileSync(path, canonicalJson(retained));
    expect(() => session.finalize()).toThrow();
    expect(existsSync(join(session.attemptDirectory, "bundle"))).toBe(false);
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "failure.json"), "utf8"))).toMatchObject({ status: "draft-failed" });
    expect(() => session.finalize()).toThrow();
  });

  it("re-admits an explicit proposal into a fresh resume attempt while retaining failed partial artifacts", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    expect(session.call("wmm_proposal_submit", { proposal: proposal(run.runInputDigest) })).toMatchObject({ ok: true });
    writeFileSync(join(session.attemptDirectory, "notes"), "synthetic interrupted output blocker", { flag: "wx" });
    expect(() => session.finalize()).toThrow();
    const oldSnapshot = readFileSync(join(session.attemptDirectory, "bundle", "snapshot.json"));
    const oldProposal = readFileSync(join(session.attemptDirectory, "proposal.json"));
    const oldFailure = readFileSync(join(session.attemptDirectory, "failure.json"));
    const resumed = application.createDmHarnessSession(run.runDirectory, { resume: true });
    expect(resumed.attemptId).toBe("attempt-002");
    expect(resumed.attemptDirectory).not.toBe(session.attemptDirectory);
    expect(resumed.hasProposal()).toBe(true);
    const result = resumed.finalize();
    expect(result.snapshotDigest).toBe(compileAuthoringProject(proposal(run.runInputDigest).project).snapshot.snapshotDigest);
    expect(readFileSync(join(session.attemptDirectory, "bundle", "snapshot.json"))).toEqual(oldSnapshot);
    expect(readFileSync(join(session.attemptDirectory, "proposal.json"))).toEqual(oldProposal);
    expect(readFileSync(join(session.attemptDirectory, "failure.json"))).toEqual(oldFailure);
    expect(readFileSync(join(session.attemptDirectory, "notes"), "utf8")).toBe("synthetic interrupted output blocker");
    expect(JSON.parse(readFileSync(join(resumed.attemptDirectory, "resume.json"), "utf8"))).toMatchObject({ proposalStatus: "re-admitted", priorAttemptId: session.attemptId });
    expect(existsSync(join(resumed.attemptDirectory, "calls", "0001.json"))).toBe(false);
    expect(() => application.createDmHarnessSession(run.runDirectory)).toThrow();
  });

  it("fails terminally instead of redirecting tool records through a replaced symlink ancestor", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const outside = join(temporary(), "outside");
    mkdirSync(outside);
    rmSync(join(session.attemptDirectory, "calls"), { recursive: true });
    symlinkSync(outside, join(session.attemptDirectory, "calls"));
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true, error: { code: "STORAGE_FAILURE" } });
    expect(existsSync(join(outside, "0001.json"))).toBe(false);
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true });
  });

  it("admits session options as closed detached data without invoking accessors", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    let hooks = 0;
    const options = Object.defineProperty({}, "resume", { get() { hooks++; return true; }, enumerable: true });
    expect(() => application.createDmHarnessSession(run.runDirectory, options)).toThrow();
    expect(hooks).toBe(0);
    expect(existsSync(join(run.runDirectory, "attempts"))).toBe(false);
    expect(() => application.createDmHarnessSession(run.runDirectory, { resume: false, tool: "terminal" } as { resume: boolean })).toThrow();
    expect(existsSync(join(run.runDirectory, "attempts"))).toBe(false);
  });

  it("describes the closed proposal and declared source-use fields in both proposal-tool parameter schemas", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    for (const tool of session.tools().filter((tool) => tool.name.startsWith("wmm_proposal_"))) {
      expect(tool.parameters).toMatchObject({ additionalProperties: false, required: ["proposal"], properties: { proposal: { additionalProperties: false,
        required: ["format", "runInputDigest", "project", "summary", "uncertainties", "sourceUses"],
        properties: { format: { const: "wmm.dm-harness-proposal/1" }, sourceUses: { type: "array", items: { additionalProperties: false, required: ["projectPointer", "sourceId", "sourceSha256", "startLine", "endLine"] } } } } } });
    }
  });

  it("reserves the bounded submission acknowledgement before admitting a durable proposal", () => {
    const sampleInput = capture();
    sampleInput.sources[0]!.text = "\u0001".repeat(10000);
    const sampleRun = application.prepareDmHarnessRun(sampleInput, join(temporary(), "sample"));
    const sampleSession = application.createDmHarnessSession(sampleRun.runDirectory);
    const result = sampleSession.call("wmm_source_read", { sourceId: "source:setting_notes" });
    const overhead = Buffer.byteLength(canonicalJson(result)) - 6 * 10000;
    const count = 31;
    const length = Math.floor((application.DM_HARNESS_LIMITS.maxTotalToolResultBytes - count * overhead) / (6 * count));
    const input = capture();
    input.sources[0]!.text = "\u0001".repeat(length);
    const run = application.prepareDmHarnessRun(input, join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    for (let index = 0; index < count; index++) expect(session.call("wmm_source_read", { sourceId: "source:setting_notes" })).toMatchObject({ ok: true });
    const draft = { ...proposal(run.runInputDigest), sourceUses: [] };
    expect(session.call("wmm_proposal_submit", { proposal: draft })).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "submission.json"))).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "proposal.json"))).toBe(false);
  });

  it("reports proposal publication collisions as terminal storage failure without overwriting prior bytes", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    writeFileSync(join(session.attemptDirectory, "proposal.json"), "retained interrupted sentinel", { flag: "wx" });
    expect(session.call("wmm_proposal_submit", { proposal: proposal(run.runInputDigest) })).toMatchObject({ ok: false, terminal: true, error: { code: "STORAGE_FAILURE" } });
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "submission.json"))).toBe(false);
    expect(readFileSync(join(session.attemptDirectory, "proposal.json"), "utf8")).toBe("retained interrupted sentinel");
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true });
  });

  it("does not reuse an unselected entry citation after changing the retained track's subject", () => {
    const captured = capture();
    const legacy = { id: "source:legacy_entry", title: "Old synthetic state note", path: "Old/State.md" };
    const base = { ...captured.project, sources: [...captured.project.sources, legacy], campaigns: captured.project.campaigns.map((campaign) => ({ ...campaign, tracks: campaign.tracks.map((track) => ({ ...track, entries: track.entries.map((entry) => ({ ...entry, citations: [{ sourceId: legacy.id, locator: "Original exact entry" }] })) })) })) };
    const run = application.prepareDmHarnessRun({ ...captured, project: base }, join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const draft = { ...proposal(run.runInputDigest), project: base, sourceUses: [] };
    expect(session.call("wmm_proposal_check", { proposal: draft })).toMatchObject({ ok: true });
    const switched = { ...draft, project: { ...base, campaigns: base.campaigns.map((campaign) => ({ ...campaign, tracks: campaign.tracks.map((track) => ({ ...track, subjectId: "place:north_quay" })) })) } };
    // This compiles as an authoring project; the additional source policy must deny it.
    expect(compileAuthoringProject(switched.project).snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    for (const name of ["wmm_proposal_check", "wmm_proposal_submit"]) expect(session.call(name, { proposal: switched })).toMatchObject({ ok: false, error: { code: "SOURCE_POLICY" } });
    expect(session.hasProposal()).toBe(false);
  });

  it.each(["wmm_proposal_check", "wmm_proposal_submit"])("records a bounded scalar-safe compiler rejection and charges %s against the call budget", (name) => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const draft = proposal(run.runInputDigest);
    function diagnostic(field: string): string {
      try { compileAuthoringProject({ ...draft.project, [field]: null }); }
      catch (error) { if (error instanceof Error) return error.message; throw error; }
      throw new Error("Expected the real compiler to reject an unknown project field");
    }
    const marker = "diagnostic_marker";
    const fieldOffset = diagnostic(marker).indexOf(marker);
    expect(fieldOffset).toBeGreaterThan(0);
    const field = `${"x".repeat(4095 - fieldOffset)}😀`;
    const compilerMessage = diagnostic(field);
    expect(field.isWellFormed()).toBe(true);
    expect(compilerMessage.isWellFormed()).toBe(true);
    // The old 4096-code-unit cutoff retains only the pair's high surrogate.
    expect(compilerMessage.slice(0, 4096).isWellFormed()).toBe(false);
    const invalid = { ...draft, project: { ...draft.project, [field]: null } };
    const result = session.call(name, { proposal: invalid }) as { error: { message: string } };
    expect(result).toEqual({ ok: false, error: { code: "INVALID_PROJECT", message: compilerMessage.slice(0, 4095) } });
    expect(result.error.message.isWellFormed()).toBe(true);
    expect(result.error.message.length).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(canonicalJson(result))).toBeLessThanOrEqual(application.DM_HARNESS_LIMITS.maxToolResultBytes);
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "calls", "0001.json"), "utf8"))).toEqual({ request: { name, arguments: { proposal: invalid } }, result });
    expect(session.hasProposal()).toBe(false);
    expect(() => session.finalize()).toThrow(/proposal/i);
    for (const path of ["proposal.json", "submission.json", "project.json", "bundle", "notes"]) expect(existsSync(join(session.attemptDirectory, path))).toBe(false);
    for (let count = 1; count < application.DM_HARNESS_LIMITS.maxToolCalls; count++) expect(session.call("wmm_project_read", {})).toMatchObject({ ok: true });
    const lastCall = `${String(application.DM_HARNESS_LIMITS.maxToolCalls).padStart(4, "0")}.json`;
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "calls", lastCall), "utf8"))).toMatchObject({ request: { name: "wmm_project_read" }, result: { ok: true } });
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "terminal.json"), "utf8"))).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
  });

  it("checks the real compiler then admits exactly one detached explicit full-project proposal", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const draft = proposal(run.runInputDigest);
    session.call("wmm_source_read", { sourceId: "source:setting_notes" });
    const expectedSnapshot = compileAuthoringProject(draft.project).snapshot.snapshotDigest;
    expect(session.call("wmm_proposal_check", { proposal: draft })).toMatchObject({ ok: true, status: "valid", snapshotDigest: expectedSnapshot });
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "proposal.json"))).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "bundle"))).toBe(false);
    expect(session.call("wmm_proposal_submit", { proposal: draft })).toMatchObject({ ok: true, status: "submitted", snapshotDigest: expectedSnapshot });
    expect(session.hasProposal()).toBe(true);
    const submitted = readFileSync(join(session.attemptDirectory, "proposal.json"), "utf8");
    expect(JSON.parse(submitted)).toEqual(draft);
    (draft.project.entities[0]!.sections[0] as { text: string }).text = "mutated after submission";
    expect(readFileSync(join(session.attemptDirectory, "proposal.json"), "utf8")).toBe(submitted);
    expect(session.call("wmm_proposal_submit", { proposal: proposal(run.runInputDigest) })).toMatchObject({ ok: false, error: { code: "ALREADY_SUBMITTED" } });
  });

  it.each([
    ["unknown selected source", { sourceId: "source:unselected" }],
    ["wrong captured hash", { sourceSha256: "0".repeat(64) }],
    ["nonexistent pointer", { projectPointer: "/entities/99/name" }],
    ["inherited pointer", { projectPointer: "/entities/constructor" }],
    ["invalid pointer escape", { projectPointer: "/entities/~2" }],
    ["zero line", { startLine: 0 }],
    ["reversed range", { startLine: 2, endLine: 1 }],
    ["past end", { endLine: 4 }],
    ["fractional line", { startLine: 1.5 }],
    ["open declaration", { path: "/not/a/capability" }],
  ])("denies %s in declared source uses for both checking and submission", (_label, change) => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const draft = proposal(run.runInputDigest);
    const invalid = { ...draft, sourceUses: [{ ...draft.sourceUses[0], ...change }] };
    for (const name of ["wmm_proposal_check", "wmm_proposal_submit"]) expect(session.call(name, { proposal: invalid })).toMatchObject({ ok: false });
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "proposal.json"))).toBe(false);
  });

  it("preserves baseline declarations but refuses new unselected evidence or catalogue laundering", () => {
    const input = capture();
    const legacy = { id: "source:legacy", title: "Old inventory", path: "Old/Inventory.md" };
    const base = { ...input.project, sources: [...input.project.sources, legacy], facts: input.project.facts.map((fact) => ({ ...fact, citations: [{ sourceId: legacy.id, locator: "Old exact reference" }] })) };
    const run = application.prepareDmHarnessRun({ ...input, project: base }, join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    const valid = { ...proposal(run.runInputDigest), project: { ...base, title: "A clearer campaign title" }, sourceUses: [] };
    expect(session.call("wmm_proposal_check", { proposal: valid })).toMatchObject({ ok: true });
    const projects = [
      { ...base, sources: [] },
      { ...base, sources: base.sources.map((source, index) => index === 0 ? { ...source, path: "Changed/Name.md" } : source) },
      { ...base, sources: [...base.sources, { id: "source:invented", title: "Not selected", path: "Invented.md" }] },
      { ...base, facts: base.facts.map((fact) => ({ ...fact, polarity: "negative" })) },
      { ...base, facts: base.facts.map((fact) => ({ ...fact, citations: [{ sourceId: legacy.id, locator: "Invented new reference" }] })) },
      { ...base, entities: base.entities.map((entity, index) => index === 0 ? { ...entity, sections: entity.sections.map((section) => ({ ...section, citations: [{ sourceId: legacy.id, locator: "Old exact reference" }] })) } : entity) },
    ];
    for (const proposed of projects) {
      for (const name of ["wmm_proposal_check", "wmm_proposal_submit"]) expect(session.call(name, { proposal: { ...valid, project: proposed } })).toMatchObject({ ok: false });
    }
    expect(session.hasProposal()).toBe(false);
  });

  it("fails closed at the host tool-call budget and never resumes substantive work", () => {
    const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    for (let count = 0; count < 32; count++) expect(session.call("wmm_project_read", {})).toMatchObject({ ok: true });
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(session.call("wmm_source_read", { sourceId: "source:setting_notes" })).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(session.hasProposal()).toBe(false);
  });

  it("charges canonical result bytes cumulatively and seals an exhausted attempt", () => {
    const input = capture();
    input.sources[0]!.text = "\u0001".repeat(65536);
    const run = application.prepareDmHarnessRun(input, join(temporary(), "run"));
    const session = application.createDmHarnessSession(run.runDirectory);
    for (let count = 0; count < 5; count++) expect(session.call("wmm_source_read", { sourceId: "source:setting_notes" })).toMatchObject({ ok: true });
    expect(session.call("wmm_source_read", { sourceId: "source:setting_notes" })).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true });
    expect(existsSync(join(session.attemptDirectory, "terminal.json"))).toBe(true);
  });

  it("opens only five custom tools over the captured project and selected exact source", () => {
    const create = Reflect.get(application, "createDmHarnessSession") as (directory: string) => {
      runId: string; attemptId: string; attemptDirectory: string;
      tools(): readonly { name: string; parameters: unknown }[]; startMessage(): string;
      call(name: string, args: unknown): unknown; hasProposal(): boolean;
    };
    expect(create).toBeTypeOf("function");
    const input = capture();
    const run = application.prepareDmHarnessRun(input, join(temporary(), "run"));
    const session = create(run.runDirectory);
    expect(session.runId).toBe(run.runId);
    expect(session.attemptId).toBe("attempt-001");
    expect(session.tools().map((tool) => tool.name)).toEqual(["wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit"]);
    const start = session.startMessage();
    expect(start).toContain(run.runInputDigest);
    expect(start).toContain(input.task);
    expect(start).toContain("DRAFT");
    expect(start).toContain("not actor knowledge");
    expect(start).not.toContain(run.runDirectory);
    expect(start).not.toContain(input.sources[0]!.text);
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: true, project: input.project, runInputDigest: run.runInputDigest, baseSnapshotDigest: run.baseSnapshotDigest });
    expect(session.call("wmm_source_read", { sourceId: "source:setting_notes" })).toMatchObject({ ok: true, source: { text: input.sources[0]!.text, lineCount: 3, sha256: sha(input.sources[0]!.text) } });
    expect(session.call("wmm_authoring_schema", {})).toEqual({ ok: true, schema: authoringProjectSchema });
    expect(session.hasProposal()).toBe(false);
    expect(JSON.parse(readFileSync(join(session.attemptDirectory, "calls", "0002.json"), "utf8"))).toMatchObject({ request: { name: "wmm_source_read", arguments: { sourceId: "source:setting_notes" } }, result: { ok: true } });
    expect(existsSync(join(session.attemptDirectory, "bundle"))).toBe(false);
  });
});

describe("DM harness sealed capture", () => {
  it("re-admits closed manifests and canonical sealed inputs rather than trusting syntactically valid JSON", () => {
    for (const corrupt of ["format", "unknown", "duplicate-input", "changed-source", "missing-manifest"]) {
      const run = application.prepareDmHarnessRun(capture(), join(temporary(), "run"));
      const manifestPath = join(run.runDirectory, "run.json");
      const inputPath = join(run.runDirectory, "input.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (corrupt === "format") writeFileSync(manifestPath, canonicalJson({ ...manifest, format: "unknown" }));
      if (corrupt === "unknown") writeFileSync(manifestPath, canonicalJson({ ...manifest, permission: "canon" }));
      if (corrupt === "duplicate-input") writeFileSync(inputPath, readFileSync(inputPath, "utf8").slice(0, -1) + `,"task":${JSON.stringify(capture().task)}}`);
      if (corrupt === "changed-source") writeFileSync(inputPath, JSON.stringify({ ...capture(), sources: [{ ...capture().sources[0], text: "mutated retained source" }] }));
      if (corrupt === "missing-manifest") rmSync(manifestPath);
      expect(() => application.readDmHarnessRun(run.runDirectory), corrupt).toThrow();
      expect(existsSync(join(run.runDirectory, "attempts"))).toBe(false);
    }
  });

  it("refuses symlinked retained files and run-directory aliases", () => {
    const home = temporary();
    const run = application.prepareDmHarnessRun(capture(), join(home, "run"));
    const inputPath = join(run.runDirectory, "input.json");
    const saved = readFileSync(inputPath);
    const outside = join(home, "outside.json");
    writeFileSync(outside, saved);
    rmSync(inputPath);
    symlinkSync(outside, inputPath);
    expect(() => application.readDmHarnessRun(run.runDirectory)).toThrow(/symlink|regular|real|nofollow/i);
    rmSync(inputPath);
    writeFileSync(inputPath, saved);
    const alias = join(home, "run-alias");
    symlinkSync(run.runDirectory, alias);
    expect(() => application.readDmHarnessRun(alias)).toThrow(/symlink|real/i);
    expect(readFileSync(outside)).toEqual(saved);
  });

  it("rejects selected-source metadata that conflicts with its baseline catalogue identity", () => {
    const input = capture();
    const destination = join(temporary(), "run");
    input.sources[0]!.title = "A different claimed document";
    expect(() => application.prepareDmHarnessRun(input, destination)).toThrow(/source|catalogue/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects an open capture shape before creating any destination", () => {
    const destination = join(temporary(), "run");
    expect(() => application.prepareDmHarnessRun({ ...capture(), operation: "world.export" }, destination)).toThrow();
    expect(existsSync(destination)).toBe(false);
  });

  it("preflights bounded capture resources before claiming a destination", () => {
    const inputs = [
      { ...capture(), task: "t".repeat(8193) },
      { ...capture(), sources: Array.from({ length: 17 }, (_, index) => ({ id: `source:s${index}`, title: "Synthetic", path: `S/${index}.md`, text: "x" })) },
      { ...capture(), sources: [{ ...capture().sources[0]!, text: "é".repeat(32769) }] },
      { ...capture(), sources: Array.from({ length: 5 }, (_, index) => ({ id: `source:s${index}`, title: "Synthetic", path: `S/${index}.md`, text: "x".repeat(65536) })) },
      { ...capture(), project: { ...project(), title: "x".repeat(262145) } },
    ];
    for (const input of inputs) {
      const destination = join(temporary(), "run");
      expect(() => application.prepareDmHarnessRun(input, destination)).toThrow(/budget|limit/i);
      expect(existsSync(destination)).toBe(false);
    }
    expect(application.DM_HARNESS_LIMITS).toMatchObject({ maxSources: 16, maxSourceBytes: 65536, maxTotalSourceBytes: 262144, maxProjectBytes: 262144, maxTaskBytes: 8192, maxDepth: 64 });
  });

  it("rejects unsupported economic notes before creating a run", () => {
    const economic = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url), "utf8")) as unknown;
    const destination = join(temporary(), "run");
    expect(() => application.prepareDmHarnessRun({ ...capture(), project: economic }, destination)).toThrow(/economic.*unsupported/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("materializes descriptor-safe arrays without executing inherited behavior", () => {
    const input = capture();
    let hooks = 0;
    const prototype = Object.create(Array.prototype) as object;
    for (const key of ["map", "toJSON", "constructor", Symbol.iterator]) Object.defineProperty(prototype, key, { get() { hooks++; throw new Error("hook ran"); } });
    Object.setPrototypeOf(input.sources, prototype);
    Object.setPrototypeOf(input.project.entities, prototype);
    const info = application.prepareDmHarnessRun(input, join(temporary(), "run"));
    expect(hooks).toBe(0);
    expect(info.sources[0]!.text).toBe(input.sources[0]!.text);
    expect(Object.getPrototypeOf(input.sources)).toBe(prototype);
    for (const bad of [new Proxy(capture(), { ownKeys() { hooks++; throw new Error("proxy ran"); } }), Object.defineProperty(capture(), "task", { get() { hooks++; return "bad"; }, enumerable: true })]) {
      const destination = join(temporary(), "bad");
      expect(() => application.prepareDmHarnessRun(bad, destination)).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    expect(hooks).toBe(0);
  });

  it("captures exact selected text and a compiled base in a fresh private replayable run", () => {
    // Reach an intentional behavioral RED even before the additive public symbols exist.
    const prepare = Reflect.get(application, "prepareDmHarnessRun") as (input: unknown, destination: string) => {
      runId: string; runInputDigest: string; baseSnapshotDigest: string; runDirectory: string; project: AuthoringProject;
      sources: readonly { text: string; sha256: string; byteLength: number; lineCount: number }[];
    };
    const read = Reflect.get(application, "readDmHarnessRun") as (directory: string) => unknown;
    expect(prepare).toBeTypeOf("function");
    const input = capture();
    const destination = join(temporary(), "run");
    const info = prepare(input, destination);
    expect(info.runId).toMatch(/^[a-z0-9-]+$/);
    expect(info.runInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(info.runDirectory).toBe(destination);
    expect(info.baseSnapshotDigest).toBe(compileAuthoringProject(input.project).snapshot.snapshotDigest);
    expect(info.sources[0]).toMatchObject({ text: input.sources[0]!.text, sha256: sha(input.sources[0]!.text), byteLength: Buffer.byteLength(input.sources[0]!.text), lineCount: 3 });
    expect(info.project.facts).toHaveLength(1);
    expect(info.project.entities[0]!.sections).toHaveLength(2);
    expect(info.project.campaigns[0]!.tracks[0]!.entries).toHaveLength(2);
    expect(lstatSync(destination).mode & 0o777).toBe(0o700);
    input.sources[0]!.text = "changed caller input";
    expect(read(destination)).toEqual(info);
    expect(existsSync(join(destination, "run.json"))).toBe(true);
  });
});
