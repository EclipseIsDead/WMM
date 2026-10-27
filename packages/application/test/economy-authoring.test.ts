import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AuthoringProject } from "@wmm/wire-contracts";
import { loadReleaseWorldBundle, readEconomyView } from "@wmm/exchange";
import { economySemantics } from "@wmm/core";
import { buildAuthoringProject } from "../src/authoring.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economic-authoring-"));
  directories.push(directory);
  return directory;
}
function grainProject(): AuthoringProject {
  return JSON.parse(readFileSync(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url), "utf8")) as AuthoringProject;
}

describe("application economic authoring build", () => {
  it("publishes and reports a valid economic bundle through the ordinary authoring application", () => {
    const input = grainProject();
    const destination = join(temporary(), "world");
    const result = buildAuthoringProject(input, destination);
    const bundle = loadReleaseWorldBundle(destination);
    const economy = readEconomyView(bundle);
    expect(result.bundlePath).toBe(resolve(destination));
    expect(result.inputDigest).toBe(economy.inputDigest);
    expect(result.notes).toBe(input.entities.length + input.campaigns.length);
    expect(bundle.world.semanticProfileDigest).toBe(economySemantics().profileDigest);
    expect(economy.records.map((record) => record.value.kind).sort()).toEqual([
      "delivery-commitment", "planned-requirement", "stock-observation",
    ]);
    expect(economy.records.map((record) => record.value.quantity.magnitude.kind).sort()).toEqual(["bounded", "exact", "unknown"]);
  });
});
