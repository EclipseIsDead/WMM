import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateApiResponse } from "@wmm/wire-contracts";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/atlas-project.json", import.meta.url));
function run(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" }, ...(input === undefined ? {} : { input }) });
}

describe("reference atlas process boundary", () => {
  it("opens an authored atlas, reads deterministic plain/JSON after source loss, and leaves decisions unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "wmm-atlas-command-"));
    try {
      const bundle = join(root, "bundle"), workspace = join(root, "workspace");
      const built = run(["authoring", "build", fixture, "--out", bundle]);
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const opened = run(["workspace", "open", bundle, "--workspace-dir", workspace, "--json"]);
      expect(opened.status, opened.stdout + opened.stderr).toBe(0);
      const initial = JSON.parse(opened.stdout).data;
      const sourceSnapshot = readFileSync(join(bundle, "snapshot.json"));
      renameSync(bundle, join(root, "moved"));
      const args = ["workspace", "map", "--workspace-dir", workspace, "--atlas", "reference_demo"];
      const plain = run([...args, "--plain"]);
      expect(plain.status, plain.stdout + plain.stderr).toBe(0);
      expect(plain.stdout).toContain("REFERENCE ATLAS");
      expect(plain.stdout).toContain("BASE WORLD");
      expect(plain.stdout).toMatch(/selected proposals are not shown/i);
      expect(plain.stdout).toContain("Tiny Islet");
      expect(plain.stdout).not.toMatch(/\x1b|\x00/);
      expect(run([...args, "--plain"]).stdout).toBe(plain.stdout);
      const json = run([...args, "--json"]);
      expect(json.status, json.stdout + json.stderr).toBe(0);
      expect(json.stdout.trim().split("\n")).toHaveLength(1);
      const response = JSON.parse(json.stdout);
      expect(validateApiResponse(response).valid).toBe(true);
      expect(response).toMatchObject({ outcome: "success", operation: "workspace.map.read", data: { worldBasis: "base", factProjection: "not-run", selectedProposalsIncluded: false, candidateView: "unavailable" } });
      const machine = run(["json", "--workspace-dir", workspace], JSON.stringify({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "fixed-map", operation: "workspace.map.read", payload: { workspaceId: "main", atlasId: "reference_demo" } }));
      expect(machine.status, machine.stdout + machine.stderr).toBe(0);
      expect(JSON.parse(machine.stdout).data).toEqual(response.data);
      const resumed = run(["workspace", "resume", "--workspace-dir", workspace, "--json"]);
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout).data).toEqual(initial);
      expect(readFileSync(join(root, "moved/snapshot.json"))).toEqual(sourceSnapshot);
      const unknown = run(["workspace", "map", "--workspace-dir", workspace, "--atlas", "missing", "--json"]);
      expect(unknown.status).toBe(3);
      expect(JSON.parse(unknown.stdout)).toMatchObject({ outcome: "error", error: { code: "UNKNOWN_RECORD" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
