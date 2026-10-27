import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAuthoringBundle, readEconomyView } from "@wmm/exchange";
import { validateEconomyView } from "@wmm/wire-contracts";
import { canonicalJson } from "@wmm/canonical";
import type { JsonValue } from "@wmm/wire-contracts";
import { renderEconomyPlain } from "../src/economy-format.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
export const grainProjectPath = fileURLToPath(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url));
export function runEconomyCli(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" }, ...(input === undefined ? {} : { input }) });
}

describe("built Economy CLI", () => {
  it.each([[], ["inspect"], ["inspect", "missing", "--plain"], ["inspect", "missing", "--json", "--json"], ["inspect", "missing", "extra"]].map(args => ({ args })))("rejects malformed options without a partial view: $args", ({ args }) => {
    const result = runEconomyCli(["economy", ...args]);
    expect(result.status).toBe(1);
    if (args.includes("--json")) {
      const response = JSON.parse(result.stdout);
      expect(response).toMatchObject({ apiVersion: "wmm/dev/1", outcome: "error", execution: "completed", error: { code: "DEVELOPMENT_COMMAND_FAILED", message: expect.stringContaining("Usage: wmm economy inspect") } });
      expect(response).not.toHaveProperty("data");
    } else { expect(result.stdout).toBe(""); expect(result.stderr).toContain("Usage: wmm economy inspect"); }
  });
  it("reports an unsupported legacy bundle as an error, not an empty complete economy", () => {
    const bundle = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
    const result = runEconomyCli(["economy", "inspect", bundle, "--json"]);
    expect(result.status).toBe(1);
    const response = JSON.parse(result.stdout);
    expect(response).toMatchObject({ apiVersion: "wmm/dev/1", outcome: "error", execution: "completed" });
    expect(response).not.toHaveProperty("data");
    expect(result.stdout).toBe(`${canonicalJson(response as JsonValue)}\n`);
  });
  it("inspects a normally verified bundle with shared plain formatting and canonical complete JSON", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-command-"));
    try {
      const bundle = join(root, "bundle");
      const view = readEconomyView(buildAuthoringBundle(JSON.parse(readFileSync(grainProjectPath, "utf8")), bundle));
      const plain = runEconomyCli(["economy", "inspect", bundle]);
      expect(plain.status, plain.stdout + plain.stderr).toBe(0);
      expect(plain.stdout).toBe(`${renderEconomyPlain(view)}\n`);
      expect(plain.stderr).toBe("");
      const json = runEconomyCli(["economy", "inspect", bundle, "--json"]);
      expect(json.status, json.stdout + json.stderr).toBe(0);
      const response = JSON.parse(json.stdout);
      expect(response).toMatchObject({ outcome: "success", execution: "completed", data: view });
      expect(validateEconomyView(response.data).valid).toBe(true);
      expect(json.stdout).toBe(`${canonicalJson(response as JsonValue)}\n`);
      expect(runEconomyCli(["--help"]).stdout).toContain("wmm economy inspect <bundle-directory> [--json]");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
