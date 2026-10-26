import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { validateEntityContextPacket } from "@wmm/wire-contracts";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url));
const legacy = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
function run(args: readonly string[]) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8", timeout: 10000 });
}

describe("entity context CLI", () => {
  it("returns an opt-in cited packet without scraping notes or changing its source bundle", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-context-cli-"));
    try {
      const bundle = join(root, "bundle");
      const built = run(["authoring", "build", fixture, "--out", bundle]);
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const before = readdirSync(root, { recursive: true }).sort();
      const snapshot = readFileSync(join(bundle, "snapshot.json"));
      const command = ["context", "entity", bundle, "faction:lantern_guild", "--campaign", "campaign:harbor_watch"];
      const first = run(command);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toBe(run(command).stdout);
      const response = JSON.parse(first.stdout);
      expect(response).toMatchObject({ apiVersion: "wmm/dev/1", outcome: "success", execution: "completed" });
      expect(validateEntityContextPacket(response.data)).toEqual({ valid: true, errors: [] });
      expect(response.data.tracks[0].current.value).toBe(2);
      const setting = run(["context", "entity", bundle, "faction:lantern_guild"]);
      expect(setting.status, setting.stdout + setting.stderr).toBe(0);
      expect(JSON.parse(setting.stdout).data.tracks).toEqual([]);
      expect(JSON.parse(setting.stdout).data.sections).toHaveLength(1);
      const bounded = run([...command, "--max-items", "1", "--max-bytes", "4096"]);
      expect(bounded.status, bounded.stdout + bounded.stderr).toBe(0);
      const small = JSON.parse(bounded.stdout).data;
      expect(small.coverage.complete).toBe(false);
      expect(small.tracks).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(small), "utf8")).toBeLessThanOrEqual(4096);
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
      expect(readFileSync(join(bundle, "snapshot.json"))).toEqual(snapshot);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);

  it("reports authored-profile support explicitly rather than pretending a legacy world has an empty dossier", () => {
    const response = run(["context", "entity", legacy, "person:alys"]);
    expect(response.status).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({ outcome: "error", error: { code: "UNSUPPORTED_CONTEXT_WORLD" } });
  });

  it("exposes the closed schema and discoverable CLI syntax", () => {
    const schema = run(["context", "schema"]);
    expect(schema.status, schema.stdout + schema.stderr).toBe(0);
    expect(JSON.parse(schema.stdout).data.$defs.Packet.additionalProperties).toBe(false);
    expect(run(["--help"]).stdout).toContain("wmm context entity");
  });

  it.each([
    [], ["entity"], ["wrong-command"],
    ["entity", "not-a-world", "Faction:bad"],
    ["entity", "not-a-world", "faction:valid", "--campaign"],
    ["entity", "not-a-world", "faction:valid", "--campaign", "invalid"],
    ["entity", "not-a-world", "faction:valid", "--campaign", "campaign:one", "--campaign", "campaign:two"],
    ...["0", "-1", "01", "1.5", "513", "9007199254740992"].map((value) => ["entity", "not-a-world", "faction:valid", "--max-items", value]),
    ...["4095", "262145", "1e5", "NaN"].map((value) => ["entity", "not-a-world", "faction:valid", "--max-bytes", value]),
    ["entity", "not-a-world", "faction:valid", "--knowledge", "actor"],
    ["entity", "not-a-world", "faction:valid", "--out", "unused"],
  ])("rejects malformed arguments before opening any world: %j", (...args) => {
    const response = run(["context", ...args]);
    expect(response.status, response.stdout + response.stderr).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({ outcome: "error", error: { code: "INVALID_CONTEXT_REQUEST" } });
  });

  it("does not guess unknown entity or campaign IDs", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-context-unknown-"));
    try {
      const bundle = join(root, "bundle");
      expect(run(["authoring", "build", fixture, "--out", bundle]).status).toBe(0);
      const entity = run(["context", "entity", bundle, "faction:absent"]);
      expect(JSON.parse(entity.stdout)).toMatchObject({ outcome: "error", error: { code: "UNKNOWN_ENTITY" } });
      const campaign = run(["context", "entity", bundle, "faction:lantern_guild", "--campaign", "campaign:absent"]);
      expect(JSON.parse(campaign.stdout)).toMatchObject({ outcome: "error", error: { code: "UNKNOWN_CAMPAIGN" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
