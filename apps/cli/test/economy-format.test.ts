import { describe, expect, it } from "vitest";
import type { EconomyView } from "@wmm/wire-contracts";
import * as presentation from "../src/workspace/presentation.js";
import { cells } from "../src/workspace/text.js";
import { economyFixture } from "./economy-fixture.js";

describe("readable source-bound Economy output", () => {
  it("preserves literal fractions, unknown references and report status with terminal-safe Unicode layout", () => {
    const view = economyFixture(project => ({ ...project,
      entities: project.entities.map(entity => ({ ...entity, name: `${entity.name} 中立👩‍👩‍👧‍👦\x9b31m\u202e` })),
      sources: project.sources.map(source => ({ ...source, title: `${source.title}\x9d8;;https://untrusted.invalid\x9cclick\x9d8;;\x9c` })),
      economy: { format: "wmm.authoring-economy/1", records: project.economy!.records.map(record => record.kind === "stock-observation" ? { ...record, status: "reported-estimate", quantity: { unitId: "unit:kilogram", magnitude: { kind: "exact", value: { numerator: "1", denominator: "3" } } }, reference: { kind: "unknown" } } : record) },
    }));
    const render = presentation.renderEconomyPlain;
    const output = render(view, 40);
    expect(output).toContain("1/3 kg"); expect(output).not.toContain("0.333");
    expect(output).toContain("reported-estimate"); expect(output).toContain("Reference: unknown (not mapped)");
    expect(output).toContain("中立");
    expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
    expect(output).not.toContain("https://untrusted.invalid");
    expect(output.split("\n").every(line => cells(line) <= 40)).toBe(true);
  });
  it("formats real stock, future commitments and planned requirements separately without availability arithmetic", () => {
    const view = economyFixture();
    const render = (presentation as unknown as Record<string, unknown>)["renderEconomyPlain"];
    expect(typeof render, "missing shared readable Economy formatter").toBe("function");
    const output = (render as (view: EconomyView) => string)(view);
    for (const text of ["ECONOMY / DM / READ-ONLY", "STOCK OBSERVATIONS", "FUTURE COMMITMENTS", "PLANNED REQUIREMENTS", "600 t", "[200, 250] t", "unknown t", "Reedbank", "Grain", "account:campaign_rainwatch", "unmapped", "Opening entry", "Town store only", "Reported store count", "complete-as-declared", "source:ledger", "Reports/Ledger.md", view.snapshotDigest, view.semanticProfileDigest, view.inputDigest]) expect(output).toContain(text);
    expect(output).toContain("Unknown is not zero");
    expect(output).toContain("Commitments are not stock");
    expect(output).toContain("Accounting: not-run | Scenarios: not-run");
    expect(output).not.toMatch(/(?:available stock|availability total|balance):\s*\d/i);
    expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(output.split("\n").every(line => cells(line) <= 100)).toBe(true);
    expect((render as (view: EconomyView) => string)(view)).toBe(output);
  });
});
