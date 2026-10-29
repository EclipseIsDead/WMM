import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@wmm/canonical";
import type { AuthoringProject, JsonValue } from "@wmm/wire-contracts";
import { buildAuthoringProject, createDmHarnessSession, DM_HARNESS_LIMITS, prepareDmHarnessRun } from "../src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "wmm-dm-harness-denials-"));
  directories.push(directory);
  return directory;
}
function input() {
  const project = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8")) as AuthoringProject;
  return { format: "wmm.dm-harness-input/1", mode: "dm-import", task: "Review a synthetic DM title change.", project,
    sources: [{ ...project.sources[0]!, text: "\ufeff\ufeffExact selected source.\nNo event occurred.\n" }] };
}
function submitted(runInputDigest: string) {
  return { format: "wmm.dm-harness-proposal/1", runInputDigest, project: { ...input().project, title: "Synthetic DRAFT" }, summary: "Title only.", uncertainties: [], sourceUses: [] };
}

// These are boundary regressions over the already GREEN vertical implementation,
// not authored responders or a claim that an external model produced anything.
describe("DM harness closed host boundary regressions", () => {
  it.each([
    ["terminal", {}], ["read_file", { path: "/not/a/capability" }], ["world.export", {}],
    ["wmm_project_read", { path: "/not/a/capability" }], ["wmm_authoring_schema", { operation: "commit" }],
    ["wmm_source_read", { sourceId: "source:setting_notes", path: "../outside.md" }],
    ["wmm_source_read", { sourceId: "source:unselected" }], ["wmm_source_read", { sourceId: "/not/a/capability" }],
    ["wmm_proposal_submit", { proposal: "final prose is not a proposal" }],
  ])("denies %s with closed arguments and no arbitrary operation/path forwarding", (name, args) => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    const result = session.call(name, args);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(run.runDirectory);
    expect(JSON.stringify(result)).not.toContain("/not/a/capability");
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "bundle"))).toBe(false);
  });

  it("denies stale, open, malformed and semantically invalid full-project proposals without publishing drafts", () => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    const proposal = submitted(run.runInputDigest);
    const invalid = [
      { ...proposal, runInputDigest: "0".repeat(64) }, { ...proposal, format: "unknown" }, { ...proposal, approval: true },
      { ...proposal, project: { ...proposal.project, worldId: "world:another" } },
      { ...proposal, project: { ...proposal.project, facts: [{ ...proposal.project.facts[0], objectId: "place:unknown" }] } },
      { ...proposal, project: { ...proposal.project, campaigns: proposal.project.campaigns.map((campaign) => ({ ...campaign, tracks: campaign.tracks.map((track) => ({ ...track, minimum: 7 })) })) } },
      { ...proposal, project: { ...proposal.project, operation: "canon" } },
      { ...proposal, project: { ...proposal.project, economy: {} } },
    ];
    for (const value of invalid) for (const name of ["wmm_proposal_check", "wmm_proposal_submit"]) expect(session.call(name, { proposal: value })).toMatchObject({ ok: false });
    expect(session.hasProposal()).toBe(false);
    expect(existsSync(join(session.attemptDirectory, "proposal.json"))).toBe(false);
    expect(() => session.finalize()).toThrow(/proposal/i);
  });

  it("detaches caller-owned tool arguments, proposals, descriptors and returned views", () => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    let hooks = 0;
    const prototype = Object.create(Array.prototype) as object;
    for (const key of ["map", "toJSON", Symbol.iterator]) Object.defineProperty(prototype, key, { get() { hooks++; throw new Error("inherited hook"); } });
    const proposal = submitted(run.runInputDigest);
    Object.setPrototypeOf(proposal.uncertainties, prototype);
    Object.setPrototypeOf(proposal.project.entities, prototype);
    expect(session.call("wmm_proposal_check", { proposal })).toMatchObject({ ok: true });
    expect(hooks).toBe(0);
    const args = Object.defineProperty({}, "sourceId", { get() { hooks++; return "source:setting_notes"; }, enumerable: true });
    expect(session.call("wmm_source_read", args)).toMatchObject({ ok: false });
    const view = session.call("wmm_project_read", {}) as { project: { title: string } };
    view.project.title = "Caller mutation";
    expect(session.call("wmm_project_read", {})).toMatchObject({ project: { title: run.project.title } });
    Object.defineProperty(session.tools()[0]!, "name", { value: "terminal" });
    expect(session.tools()[0]!.name).toBe("wmm_project_read");
    expect(hooks).toBe(0);
    expect(Object.getPrototypeOf(proposal.uncertainties)).toBe(prototype);
  });

  it("bounds proposal/frame bytes and makes budget failure terminal", () => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    expect(session.call("wmm_proposal_submit", { proposal: { ...submitted(run.runInputDigest), summary: "x".repeat(DM_HARNESS_LIMITS.maxProposalBytes + 1) } })).toMatchObject({ ok: false, terminal: true, error: { code: "BUDGET_EXCEEDED" } });
    expect(session.call("wmm_project_read", {})).toMatchObject({ ok: false, terminal: true });
    expect(session.hasProposal()).toBe(false);
    expect(() => session.finalize()).toThrow(/budget/i);
  });

  it("admits only exact selected new catalogue entries and retains repeated leading source BOMs", () => {
    const captured = input();
    const extra = { id: "source:new_selected", title: "New selected source", path: "New/Selected.md", text: "Synthetic additional basis." };
    const run = prepareDmHarnessRun({ ...captured, sources: [...captured.sources, extra] }, join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    expect(session.call("wmm_source_read", { sourceId: captured.sources[0]!.id })).toMatchObject({ ok: true, source: { text: captured.sources[0]!.text, byteLength: Buffer.byteLength(captured.sources[0]!.text) } });
    const { text: _text, ...metadata } = extra;
    const proposal = submitted(run.runInputDigest);
    const good = { ...proposal, project: { ...proposal.project, sources: [...proposal.project.sources, metadata] } };
    expect(session.call("wmm_proposal_check", { proposal: good })).toMatchObject({ ok: true });
    expect(session.call("wmm_proposal_check", { proposal: { ...good, project: { ...good.project, sources: [...proposal.project.sources, { ...metadata, title: "Not the selected identity" }] } } })).toMatchObject({ ok: false });
  });

  it("rejects source path tricks and deep/resource-amplified captures before destination creation", () => {
    const base = input();
    for (const path of ["../outside.md", "/absolute.md", "A/../outside.md", "A//B.md", "A\\B.md", "C:/outside.md", "A/./B.md"]) {
      const destination = join(temporary(), "run");
      expect(() => prepareDmHarnessRun({ ...base, sources: [{ ...base.sources[0], path }] }, destination)).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    let deep: JsonValue = null;
    for (let depth = 0; depth < 66; depth++) deep = [deep];
    const destination = join(temporary(), "deep");
    expect(() => prepareDmHarnessRun({ ...base, extra: deep }, destination)).toThrow(/depth|limit/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses existing, linked and bundle-descendant output without overwriting any old bytes", () => {
    const home = temporary();
    const existing = join(home, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "sentinel"), "old");
    expect(() => prepareDmHarnessRun(input(), existing)).toThrow();
    const link = join(home, "linked");
    symlinkSync(existing, link);
    expect(() => prepareDmHarnessRun(input(), join(link, "new"))).toThrow();
    expect(existsSync(join(existing, "new"))).toBe(false);
    expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("old");
    const bundle = join(home, "bundle");
    buildAuthoringProject(input().project, bundle);
    expect(() => prepareDmHarnessRun(input(), join(bundle, "new-run"))).toThrow(/bundle/i);
    expect(existsSync(join(bundle, "new-run"))).toBe(false);
  });

  it.each(["malformed-proposal", "missing-submission", "invalid-submission", "changed-source-use"])("starts a fresh agent attempt instead of replaying %s or opaque runtime output", (kind) => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const session = createDmHarnessSession(run.runDirectory);
    expect(session.call("wmm_proposal_submit", { proposal: submitted(run.runInputDigest) })).toMatchObject({ ok: true });
    const proposalPath = join(session.attemptDirectory, "proposal.json");
    const submissionPath = join(session.attemptDirectory, "submission.json");
    if (kind === "malformed-proposal") writeFileSync(proposalPath, "{interrupted");
    if (kind === "missing-submission") rmSync(submissionPath);
    if (kind === "invalid-submission") writeFileSync(submissionPath, canonicalJson({ format: "invented" }));
    if (kind === "changed-source-use") {
      const proposal = { ...submitted(run.runInputDigest), sourceUses: [{ projectPointer: "/title", sourceId: "source:invented", sourceSha256: "0".repeat(64), startLine: 1, endLine: 1 }] };
      writeFileSync(proposalPath, canonicalJson(proposal as unknown as JsonValue));
    }
    const oldProposal = readFileSync(proposalPath);
    const outside = temporary();
    writeFileSync(join(outside, "submission.json"), "opaque runtime authority is invalid");
    symlinkSync(outside, join(session.attemptDirectory, "runtime"));
    const resumed = createDmHarnessSession(run.runDirectory, { resume: true });
    expect(resumed.attemptId).toBe("attempt-002");
    expect(resumed.hasProposal()).toBe(false);
    expect(() => resumed.finalize()).toThrow(/proposal/i);
    expect(JSON.parse(readFileSync(join(resumed.attemptDirectory, "resume.json"), "utf8"))).toMatchObject({ proposalStatus: "new-agent-attempt" });
    expect(readFileSync(proposalPath)).toEqual(oldProposal);
    expect(readFileSync(join(outside, "submission.json"), "utf8")).toBe("opaque runtime authority is invalid");
    expect(resumed.call("wmm_proposal_submit", { proposal: submitted(run.runInputDigest) })).toMatchObject({ ok: true });
    expect(resumed.finalize()).toMatchObject({ status: "draft" });
  });

  it("counts incomplete attempts, caps four attempts and does not replay SDK history", () => {
    const run = prepareDmHarnessRun(input(), join(temporary(), "run"));
    const first = createDmHarnessSession(run.runDirectory);
    rmSync(join(first.attemptDirectory, "attempt.json"));
    for (let number = 2; number <= 4; number++) {
      const session = createDmHarnessSession(run.runDirectory, { resume: true });
      expect(session.attemptId).toBe(`attempt-${String(number).padStart(3, "0")}`);
      expect(session.hasProposal()).toBe(false);
    }
    expect(() => createDmHarnessSession(run.runDirectory, { resume: true })).toThrow(/budget/i);
    expect(existsSync(join(run.runDirectory, "attempts", "attempt-005"))).toBe(false);
  });
});
