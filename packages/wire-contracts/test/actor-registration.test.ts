import { spawnSync } from "node:child_process";

import { expect, it } from "vitest";

it("loads actor validators with the complete authoring schema dependency graph", () => {
  const moduleUrl = new URL("../dist/actor-validation.js", import.meta.url).href;
  const fixtureUrl = new URL("../../../fixtures/authoring/lantern-actor-brief.json", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { validateActorBrief } from ${JSON.stringify(moduleUrl)};
    const brief = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl)}), "utf8"));
    console.log(JSON.stringify({
      valid: validateActorBrief(brief).valid,
      invalid: validateActorBrief({ ...brief, format: "unrecognized" }).valid,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, shell: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ valid: true, invalid: false });
});
