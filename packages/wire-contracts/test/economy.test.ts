import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stock, project, delivery, requirement } from "../../core/test/helpers/economy.js";
import { validateAuthoringEconomy, validateAuthoringProject, validateEconomicRecordValue, validateEconomyView } from "../src/index.js";
import type { EconomicRecordValue } from "../src/index.js";

function literal(): EconomicRecordValue {
  const { subjectId: _subject, context: _context, applicability: _applicability, ...value } = stock();
  return { ...value, reference: { kind: "mapped", axisDefinitionDigest: "a".repeat(64), position: "0" } };
}
function view() {
  return { format: "wmm.economy-view/1", worldId: "world:reedbank", snapshotDigest: "a".repeat(64), semanticProfileDigest: "b".repeat(64), inputDigest: "c".repeat(64), perspective: "dm", accounting: "not-run", scenarios: "not-run",
    records: [{ assertionId: `asrt:${"d".repeat(64)}`, subjectId: "place:reedbank", scope: { account: { kind: "ref", id: "account:setting" }, jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "notApplicable" } }, value: literal() }], entities: [], sources: [], axes: [], limitations: [],
  };
}

describe("closed economic wire shapes", () => {
  it("registers the complete built authoring/economy schema graph at process startup", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import {validateAuthoringProject,validateEconomicRecordValue,validateEconomyView} from './packages/wire-contracts/dist/index.js'; if (![validateAuthoringProject,validateEconomicRecordValue,validateEconomyView].every(f=>typeof f==='function')) process.exit(1)"], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
  it.each([stock(), delivery(), requirement()])("admits the closed authoring union: $kind", (record) => {
    expect(validateAuthoringProject(project([record])).valid).toBe(true);
    expect(validateAuthoringEconomy(project([record]).economy).valid).toBe(true);
  });
  it("keeps context, subject and applicability out of literal data", () => {
    expect(validateEconomicRecordValue(literal()).valid).toBe(true);
    for (const extra of [{ subjectId: "place:reedbank" }, { context: { kind: "setting" } }, { applicability: { kind: "invariant" } }, { approval: true }]) expect(validateEconomicRecordValue({ ...literal(), ...extra }).valid).toBe(false);
  });
  it("rejects incomplete, wrong-reference and unbounded authoring envelopes", () => {
    for (const bad of [{ ...stock(), id: "Bad ID" }, { ...stock(), reference: delivery().reference }, { ...delivery(), reference: stock().reference }, { ...stock(), applicability: { kind: "point" } }]) expect(validateAuthoringProject({ ...project(), economy: { format: "wmm.authoring-economy/1", records: [bad] } }).valid).toBe(false);
    expect(validateAuthoringEconomy({ format: "wmm.authoring-economy/1", records: Array.from({ length: 65 }, stock) }).valid).toBe(false);
    expect(validateAuthoringEconomy({ format: "wmm.authoring-economy/2", records: [] }).valid).toBe(false);
  });
  it("does not mistake shape admission for arithmetic or unit admission", () => {
    expect(validateEconomicRecordValue({ ...literal(), quantity: { unitId: "unit:unadmitted", magnitude: { kind: "exact", value: { numerator: "2", denominator: "4" } } } }).valid).toBe(true);
  });
  it("admits the separate DM complete-view shape, not a workspace route or accounting result", () => {
    expect(validateEconomyView(view()).valid).toBe(true);
    for (const extra of [{ accounting: "complete" }, { scenarios: "run" }, { perspective: "actor" }, { balance: 3 }]) expect(validateEconomyView({ ...view(), ...extra }).valid).toBe(false);
  });
  it("preflights getters and proxies without executing them", () => {
    let calls = 0;
    const getter = Object.defineProperty(literal(), "quantity", { enumerable: true, get: () => { calls += 1; throw new Error("Getter ran"); } });
    const proxy = new Proxy({}, { ownKeys: () => { calls += 1; throw new Error("Proxy ran"); } });
    expect(validateEconomicRecordValue(getter).valid).toBe(false);
    expect(validateEconomicRecordValue(proxy).valid).toBe(false);
    expect(validateEconomyView(proxy).valid).toBe(false);
    expect(calls).toBe(0);
  });
});
