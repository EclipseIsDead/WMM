import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateApiResponse } from "@wmm/wire-contracts";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url));
function run(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" }, ...(input === undefined ? {} : { input }) });
}

describe("persisted Economy command boundary", () => {
  it("preserves actual Economy API errors and exit codes for a missing workspace", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-missing-"));
    try {
      const world = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
      const opened = run(["workspace", "open", world, "--workspace-dir", root, "--json"]);
      expect(opened.status, opened.stdout + opened.stderr).toBe(0);
      const missing = run(["workspace", "economy", "--workspace-dir", root, "--id", "missing", "--json"]);
      expect(missing.status, missing.stdout + missing.stderr).toBe(3);
      const response = JSON.parse(missing.stdout);
      expect(validateApiResponse(response).valid).toBe(true);
      expect(response).toMatchObject({ operation: "workspace.economy.read", outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reads complete captured-base economy after source loss without changing selection, history, version or review", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-workspace-economy-command-"));
    try {
      const bundle = join(root, "bundle"), workspace = join(root, "workspace"), workspaceId = "grain-inspection";
      const built = run(["authoring", "build", fixture, "--out", bundle]);
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const opened = run(["workspace", "open", bundle, "--workspace-dir", workspace, "--id", workspaceId, "--json"]);
      expect(opened.status, opened.stdout + opened.stderr).toBe(0);
      const initial = JSON.parse(opened.stdout).data;
      const machine = (operation: string, payload: object) => run(["json", "--workspace-dir", workspace], JSON.stringify({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "economy-command", operation, payload: { workspaceId, ...payload } }));
      const proposal = machine("workspace.mutate", { expectedVersion: 1, idempotencyKey: "prose", action: { kind: "put-proposal", proposal: { id: "prose", title: "Selected prose does not alter economics", rationale: "Deliberately excluded", author: "Synthetic", dependencies: [], exclusions: [], operations: [{ kind: "write-prose", path: "prose/future.md", beforeSha256: null, text: "Not stock or delivery." }] } } });
      expect(proposal.status, proposal.stdout + proposal.stderr).toBe(0);
      const selected = machine("workspace.mutate", { expectedVersion: 2, idempotencyKey: "select", action: { kind: "decide", groupId: "prose", decision: "selected" } });
      expect(selected.status, selected.stdout + selected.stderr).toBe(0);
      const reviewed = machine("workspace.review", { expectedVersion: 3 });
      expect(reviewed.status, reviewed.stdout + reviewed.stderr).toBe(0);
      const before = JSON.parse(reviewed.stdout).data;
      const sourceSnapshot = readFileSync(join(bundle, "snapshot.json"));
      renameSync(bundle, join(root, "moved"));
      const args = ["workspace", "economy", "--workspace-dir", workspace, "--id", workspaceId];
      const plain = run([...args, "--plain"]);
      expect(plain.status, plain.stdout + plain.stderr).toBe(0);
      for (const text of ["ECONOMY / DM / READ-ONLY", "600 t", "[200, 250] t", "unknown t", "Selected proposals excluded", "candidate unavailable", "account:campaign_rainwatch", "source:ledger"]) expect(plain.stdout).toContain(text);
      expect(plain.stdout).not.toMatch(/\x1b|\x00/);
      expect(run(args).stdout).toBe(plain.stdout);
      const json = run([...args, "--json"]);
      expect(json.status, json.stdout + json.stderr).toBe(0);
      const response = JSON.parse(json.stdout);
      expect(validateApiResponse(response).valid).toBe(true);
      expect(response).toMatchObject({ operation: "workspace.economy.read", outcome: "success", resolved: initial.workspace.base, data: { workspaceId, workspaceVersion: 3, base: initial.workspace.base, worldBasis: "base", selectedProposalsIncluded: false, candidateView: "unavailable", economy: { worldId: initial.workspace.base.worldId, snapshotDigest: initial.workspace.base.snapshotDigest, accounting: "not-run", scenarios: "not-run" } } });
      expect(response.data.economy.records).toHaveLength(3);
      const exact = machine("workspace.economy.read", { atVersion: 3 });
      expect(exact.status, exact.stdout + exact.stderr).toBe(0);
      expect(JSON.parse(exact.stdout).data).toEqual(response.data);
      const historical = machine("workspace.economy.read", { atVersion: 1 });
      expect(historical.status, historical.stdout + historical.stderr).toBe(0);
      expect(JSON.parse(historical.stdout).data).toMatchObject({ workspaceVersion: 1, economy: response.data.economy });
      const malformed = machine("workspace.economy.read", { atVersion: 1, candidate: true });
      expect(malformed.status).toBe(2);
      expect(JSON.parse(malformed.stdout).error.code).toBe("INVALID_REQUEST");
      const resumed = machine("workspace.read", {});
      expect(resumed.status).toBe(0);
      expect(JSON.parse(resumed.stdout).data).toEqual(before);
      expect(readFileSync(join(root, "moved/snapshot.json"))).toEqual(sourceSnapshot);
      expect(run(["--help"]).stdout).toContain("wmm workspace economy --workspace-dir <directory> [--id main] [--plain | --json]");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});
