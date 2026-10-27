import type { AuthoringEconomicRecord, AuthoringProject } from "@wmm/wire-contracts";

export function stock(): Extract<AuthoringEconomicRecord, { kind: "stock-observation" }> {
  return {
    id: "opening", kind: "stock-observation", subjectId: "place:reedbank", resourceId: "item:grain",
    context: { kind: "setting" }, applicability: { kind: "invariant" },
    quantity: { unitId: "unit:tonne", magnitude: { kind: "exact", value: { numerator: "3", denominator: "1" } } },
    description: "Authored opening grain report, not a complete inventory", reference: { kind: "mapped", axisKey: "days", position: "0" },
    method: { kind: "declared", description: "Reported store count" }, boundary: { kind: "declared", description: "Town store only", entityIds: ["place:store"] },
    coverage: { kind: "partial", description: "Other stores not counted" }, citations: [{ sourceId: "source:ledger", locator: "Opening entry" }],
    status: "observed", owner: { kind: "declared", entityId: "faction:council" }, custodian: { kind: "unknown" },
    location: { kind: "declared", entityId: "place:store" }, availableUse: { kind: "unknown" },
  };
}
export function project(records: readonly AuthoringEconomicRecord[] = [stock()]): AuthoringProject {
  return {
    format: "wmm.authoring-project/1", worldId: "world:reedbank", title: "Reedbank grain", sources: [{ id: "source:ledger", title: "Authored ledger", path: "Reports/Ledger.md" }],
    entities: [["place:reedbank", "Reedbank"], ["item:grain", "Grain"], ["place:store", "Town Store"], ["faction:council", "Town Council"]].map(([id, name]) => ({ id: id!, name: name!, sections: [] })),
    facts: [], campaigns: [], economy: { format: "wmm.authoring-economy/1", records },
  };
}
export function delivery(): Extract<AuthoringEconomicRecord, { kind: "delivery-commitment" }> {
  const { status: _status, owner: _owner, custodian: _custodian, location: _location, availableUse: _use, ...common } = stock();
  return { ...common, id: "promised", kind: "delivery-commitment", reference: { kind: "mapped", axisKey: "days", start: "1", endExclusive: "3" },
    promisor: { kind: "declared", entityId: "faction:council" }, recipient: { kind: "unknown" }, destination: { kind: "declared", entityId: "place:store" },
    timing: { kind: "future-as-authored", relativeTo: { kind: "mapped", axisKey: "days", position: "0" } },
  };
}
export function requirement(): Extract<AuthoringEconomicRecord, { kind: "planned-requirement" }> {
  const { promisor: _promisor, recipient: _recipient, destination: _destination, timing: _timing, ...common } = delivery();
  return { ...common, id: "food-plan", kind: "planned-requirement", planner: { kind: "declared", entityId: "faction:council" }, beneficiary: { kind: "declared", entityId: "place:reedbank" }, purpose: "Planned food provision, not consumption" };
}
