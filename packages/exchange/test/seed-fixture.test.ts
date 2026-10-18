import {
  cpSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "@wmm/canonical";
import {
  exportSeedFixture,
  inspectSeedFixture,
  loadSeedFixture,
  validateSeedFixture,
} from "../src/index.js";

const kitPath = fileURLToPath(
  new URL("../../../wmm-v0.3-contract-kit/", import.meta.url),
);

describe("seed fixture exchange", () => {
  it("loads and validates every declared byte without claiming reference completeness", () => {
    const fixture = loadSeedFixture(kitPath);
    const report = validateSeedFixture(fixture);

    expect(report).toMatchObject({
      status: "valid-seed-fixture",
      files: 12,
      definitions: 7,
      assertions: 2,
      documents: 1,
      diagnostics: [
        {
          code: "SEED_FIXTURE_INCOMPLETE",
          severity: "warning",
        },
      ],
    });
    expect(report.diagnostics[0]?.unresolvedRecordIds).toContain("person:alys");
    expect(report.diagnostics[0]?.unresolvedRecordIds).toContain("office:valen-crown");
  });

  it("inspects records and exact authored prose deterministically", () => {
    const fixture = loadSeedFixture(kitPath);
    expect(inspectSeedFixture(fixture, "world:valen_demo")).toMatchObject({
      format: "wmm.world-fixture/1",
    });
    expect(
      inspectSeedFixture(
        fixture,
        "asrt:ef2bd1b1c292116ea078c3e3afa91317bd4396fb45df56e2b6d34bf3bc8228ee",
      ),
    ).toMatchObject({ id: expect.stringMatching(/^asrt:/) });
    expect(inspectSeedFixture(fixture, "path:prose/valen.md")).toMatchObject({
      path: "prose/valen.md",
      text: expect.stringContaining("Valen"),
    });
    expect(inspectSeedFixture(fixture, "person:missing")).toBeUndefined();
  });

  it("exports a canonicalizable, stable JSON view", () => {
    const first = exportSeedFixture(loadSeedFixture(kitPath));
    const second = exportSeedFixture(loadSeedFixture(kitPath));
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("rejects undeclared and tampered payload files", () => {
    const extraRoot = mkdtempSync(join(tmpdir(), "wmm-extra-"));
    cpSync(kitPath, extraRoot, { recursive: true });
    writeFileSync(join(extraRoot, "fixture-payload", "unexpected.json"), "{}", "utf8");
    expect(() => loadSeedFixture(extraRoot)).toThrow(/differ from the snapshot manifest/);

    const tamperedRoot = mkdtempSync(join(tmpdir(), "wmm-tampered-"));
    cpSync(kitPath, tamperedRoot, { recursive: true });
    writeFileSync(join(tamperedRoot, "fixture-payload", "prose", "valen.md"), "changed", "utf8");
    expect(() => loadSeedFixture(tamperedRoot)).toThrow(/do not match manifest/);
  });
});
