import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildAuthoringProject } from "@wmm/application";
import { validateActorContextPacket, validateActorDecisionReview } from "@wmm/wire-contracts";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url));
function run(args: readonly string[]) { return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); }
function withActor(test: (paths: { root: string; bundle: string; brief: string }) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-actor-command-"));
  try {
    const bundle = join(root, "bundle");
    // Authoring CLI has its own process tests; reserve this budget for actor commands.
    const built = buildAuthoringProject(JSON.parse(readFileSync(fixture, "utf8")), bundle);
    expect(built.status).toBe("valid");
    const snapshot = JSON.parse(readFileSync(join(bundle, "snapshot.json"), "utf8")) as { snapshotDigest: string };
    const brief = join(root, "brief.json");
    writeFileSync(brief, JSON.stringify({ format: "wmm.actor-brief/1", snapshotDigest: snapshot.snapshotDigest, actorId: "faction:lantern_guild", campaignId: "campaign:harbor_watch", question: "What should the next watch do?", items: [
      { id: "mission", kind: "goal", text: "Keep the harbor beacons operating.", basis: [{ kind: "section", ownerId: "faction:lantern_guild", sectionId: "overview" }] },
    ] }));
    test({ root, bundle, brief });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("actor CLI", () => {
  it("publishes the closed actor schema and help without adding a model or execution command", () => {
    const schema = run(["actor", "schema"]);
    expect(schema.status, schema.stdout + schema.stderr).toBe(0);
    const definitions = JSON.parse(schema.stdout).data.$defs;
    expect(definitions.Brief.additionalProperties).toBe(false);
    expect(definitions.Decision.properties.status.const).toBe("proposed");
    expect(run(["--help"]).stdout).toContain("wmm actor review");
  });

  it.each([
    [], ["execute"], ["schema", "extra"], ["prepare"], ["prepare", "bundle", "brief", "--out", "other"],
    ["review", "bundle", "brief"], ["review", "bundle", "brief", "decision", "--out"],
    ["review", "bundle", "brief", "decision", "--apply", "true"],
    ["review", "bundle", "brief", "decision", "--out", "one", "--out", "two"],
  ])("rejects unsupported actor arguments before opening data: %j", (...args) => {
    const response = run(["actor", ...args]);
    expect(response.status).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({ outcome: "error", error: { code: "INVALID_ACTOR_COMMAND" } });
  });

  it.each(["invalid-utf8.json", "duplicate.json", "oversized.json", "directory", "alias.json"])("rejects unsafe actor brief sidecar %s", (name) => withActor(({ root, bundle, brief }) => {
    const invalidUtf8 = join(root, "invalid-utf8.json");
    const duplicate = join(root, "duplicate.json");
    const oversized = join(root, "oversized.json");
    const directory = join(root, "directory");
    const alias = join(root, "alias.json");
    writeFileSync(invalidUtf8, new Uint8Array([0xc3, 0x28]));
    writeFileSync(duplicate, '{"format":"wmm.actor-brief/1","format":"wmm.actor-brief/1"}');
    writeFileSync(oversized, " ".repeat(262145));
    mkdirSync(directory);
    symlinkSync(brief, alias);
    const response = run(["actor", "prepare", bundle, join(root, name)]);
    expect(response.status, response.stdout + response.stderr).toBe(1);
    expect(JSON.parse(response.stdout).outcome).toBe("error");
  }));

  it("fails malformed requests before bundle loading and stale decisions before output creation", () => withActor(({ root, bundle, brief }) => {
    const value = JSON.parse(readFileSync(brief, "utf8"));
    const prepared = run(["actor", "prepare", bundle, brief]);
    expect(prepared.status).toBe(0);
    const decision = join(root, "stale-decision.json");
    writeFileSync(decision, JSON.stringify({ format: "wmm.actor-decision/1", status: "proposed", contextDigest: "0".repeat(64), action: { text: "Keep watch.", basis: ["mission"] }, rationale: { text: "Preserve the beacons.", basis: ["mission"] }, uncertainties: [], communication: null }));
    const destination = join(root, "must-not-exist");
    const stale = run(["actor", "review", bundle, brief, decision, "--out", destination]);
    expect(JSON.parse(stale.stdout)).toMatchObject({ outcome: "error", error: { code: "STALE_ACTOR_DECISION" } });
    expect(existsSync(destination)).toBe(false);
    writeFileSync(brief, JSON.stringify({ ...value, actorId: "Faction:bad" }));
    const malformed = run(["actor", "prepare", "not-a-bundle", brief]);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ outcome: "error", error: { code: "INVALID_ACTOR_BRIEF" } });
  }));

  it("checks a proposed decision and writes a fresh, readable DM review without delivering or applying anything", () => withActor(({ root, bundle, brief }) => {
    const prepared = run(["actor", "prepare", bundle, brief]);
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const context = JSON.parse(prepared.stdout).data as { contextDigest: string };
    const decision = join(root, "decision.json");
    writeFileSync(decision, JSON.stringify({ format: "wmm.actor-decision/1", status: "proposed", contextDigest: context.contextDigest,
      action: { text: "Request watch funding from the steward.", basis: ["mission"] }, rationale: { text: "The beacons must remain staffed.", basis: ["mission"] }, uncertainties: [],
      communication: { status: "draft", recipient: "Council steward", text: "Please confirm funding for the next watch.", basis: ["mission"] },
    }));
    const destination = join(root, "review");
    const result = run(["actor", "review", bundle, brief, decision, "--out", destination]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const response = JSON.parse(result.stdout).data as { review: unknown; markdown: string };
    expect(validateActorDecisionReview(response.review).valid).toBe(true);
    expect(response.markdown).toContain("Proposed action");
    expect(response.markdown).toContain("not executed");
    expect(response.markdown).toContain("Draft communication");
    expect(response.markdown).toContain("Setting/Factions.md");
    expect(readFileSync(join(destination, "review.md"), "utf8")).toBe(response.markdown);
    expect(JSON.parse(readFileSync(join(destination, "review.json"), "utf8"))).toEqual(response.review);
    expect(run(["world", "validate", bundle]).status).toBe(0);
    expect(run(["actor", "review", bundle, brief, decision, "--out", destination]).status).toBe(1);
  }));

  it("prepares only the actor-facing packet from a verified snapshot without copying narrative or citation paths", () => withActor(({ bundle, brief }) => {
    const before = readFileSync(join(bundle, "snapshot.json"));
    const result = run(["actor", "prepare", bundle, brief]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const response = JSON.parse(result.stdout) as { data: unknown };
    expect(validateActorContextPacket(response.data).valid).toBe(true);
    expect(response.data).toMatchObject({ perspective: "actor", selectionPolicy: "explicit-curation", items: [{ id: "mission" }] });
    expect(result.stdout).not.toContain("Setting/Factions.md");
    expect(result.stdout).not.toContain("A guild of lamplighters");
    expect(readFileSync(join(bundle, "snapshot.json"))).toEqual(before);
    expect(run(["world", "validate", bundle]).status).toBe(0);
  }));
});
