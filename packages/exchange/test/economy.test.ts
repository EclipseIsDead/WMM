import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as exchange from "../src/index.js";

import { stock, project, delivery, requirement } from "../../core/test/helpers/economy.js";
import type { EconomyView } from "@wmm/wire-contracts";
import { canonicalJsonBytes } from "@wmm/canonical";

function withRoot(run: (root: string) => void) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-economy-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("verified economic authoring", () => {
  it("explicitly refuses legacy DM notes for economic profiles rather than silently omitting records", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project(), join(root, "bundle"));
    expect(() => exchange.renderDmNotes(bundle)).toThrow(/economic.*unsupported|economy view/i);
  }));
  it("detaches inherited array behavior before verifying and projecting admitted assertions", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project(), join(root, "bundle"));
    const expected = exchange.readEconomyView(bundle);
    let calls = 0;
    const assertions = [...bundle.assertions];
    Object.setPrototypeOf(assertions, Object.create(Array.prototype, { [Symbol.iterator]: { get: () => { calls += 1; throw new Error("Caller iterator ran"); } } }));
    expect(exchange.readEconomyView({ ...bundle, assertions })).toEqual(expected);
    expect(calls).toBe(0);
    expect(Object.isFrozen(assertions)).toBe(false);
  }));
  it("rejects in-memory assertion changes even when the old snapshot and documents are retained", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project(), join(root, "bundle"));
    const assertions = bundle.assertions.map((record) => {
      if (record.body.proposition.kind !== "atom" || record.body.proposition.value.kind !== "literal") throw new Error("Expected economic atom");
      const value = record.body.proposition.value;
      return { ...record, body: { ...record.body, proposition: { ...record.body.proposition, value: { ...value, data: { ...(value.data as Record<string, never>), description: "Tampered admitted value" } } } } };
    });
    expect(() => exchange.readEconomyView({ ...bundle, assertions })).toThrow(/correspondence|differs|mismatch/i);
  }));
  it("rejects presentation bytes changed after ordinary loading instead of trusting its snapshot wrapper", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project(), join(root, "bundle"));
    const documents = bundle.documents.map((document) => document.path !== "authoring/index.json" ? document : { ...document, bytes: canonicalJsonBytes({ ...JSON.parse(new TextDecoder().decode(document.bytes)), title: "Forged title", notes: [{ id: "place:store", name: "Forged label", campaignId: null, sections: [], facts: [], track: null }] }) });
    expect(() => exchange.readEconomyView({ ...bundle, documents })).toThrow(/correspondence|differs|mismatch/i);
  }));
  it("reads a planned requirement without treating it as consumption or negative inventory", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project([stock(), delivery(), requirement()]), join(root, "bundle"));
    const view = exchange.readEconomyView(bundle);
    expect(view.records).toHaveLength(3);
    expect(view.records.find((record) => record.value.id === "food-plan")?.value).toMatchObject({ kind: "planned-requirement", purpose: "Planned food provision, not consumption", quantity: stock().quantity, reference: { kind: "mapped", start: "1", endExclusive: "3" } });
    expect(view).not.toHaveProperty("consumption");
    expect(view).not.toHaveProperty("balance");
  }));
  it("keeps a future delivery commitment separate from observed stock", () => withRoot((root) => {
    const bundle = exchange.buildAuthoringBundle(project([stock(), delivery()]), join(root, "bundle"));
    const view = exchange.readEconomyView(bundle);
    expect(view.records.map((record) => record.value.kind).sort()).toEqual(["delivery-commitment", "stock-observation"]);
    expect(view.records.find((record) => record.value.id === "promised")?.value).toMatchObject({ kind: "delivery-commitment", reference: { kind: "mapped", start: "1", endExclusive: "3" }, timing: { kind: "future-as-authored", relativeTo: { kind: "mapped", position: "0" } } });
    expect(view.records.every((record) => !Object.hasOwn(record.value, "balance"))).toBe(true);
  }));
  it("compiles, ordinarily loads and reads one source-bound stock observation", () => withRoot((root) => {
    // Namespace access keeps the behavioral test runnable before this new export exists.
    const read = (exchange as unknown as Record<string, unknown>)["readEconomyView"];
    expect(typeof read, "missing verified readEconomyView producer").toBe("function");
    const built = exchange.buildAuthoringBundle(project(), join(root, "bundle"));
    const loaded = exchange.loadReleaseWorldBundle(join(root, "bundle"));
    const view = (read as (bundle: typeof loaded) => EconomyView)(loaded);
    expect(loaded.snapshot).toEqual(built.snapshot);
    expect(view).toMatchObject({ format: "wmm.economy-view/1", worldId: "world:reedbank", snapshotDigest: loaded.snapshot.snapshotDigest, perspective: "dm", accounting: "not-run", scenarios: "not-run" });
    expect(view.records).toHaveLength(1);
    expect(view.records[0]).toMatchObject({ subjectId: "place:reedbank", scope: { account: { kind: "ref", id: "account:setting" } }, value: { id: "opening", kind: "stock-observation", quantity: stock().quantity, reference: { kind: "mapped" }, citations: stock().citations } });
    expect(view.records[0]!.value).not.toHaveProperty("subjectId");
    expect(view.records[0]!.value).not.toHaveProperty("context");
    expect(view.records[0]!.value).not.toHaveProperty("applicability");
    expect(view.entities).toContainEqual({ id: "place:store", name: "Town Store" });
    expect(view.sources).toEqual(project().sources);
    const reference = view.records[0]!.value.reference;
    if (reference.kind !== "mapped") throw new Error("Expected mapped stock reference");
    expect(view.axes[0]).toMatchObject({ key: "days", definitionDigest: reference.axisDefinitionDigest });
    expect(loaded.sources).toContainEqual({ format: "wmm.source/1", worldId: "world:reedbank", id: "source:ledger", sourceType: "document", content: { availability: "none" } });
    expect(loaded.supports[0]?.body.sourceId).toBe("source:wmm_authoring");
    expect(view).toEqual((read as Function)(loaded));
  }));
});
