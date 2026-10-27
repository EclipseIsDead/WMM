import { formatQuantity } from "@wmm/core";
import type { EconomicDeclaration, EconomicPoint, EconomicPeriod, EconomicRecordValue, EconomicRole, EconomyView, ScopeV1, WorkspaceEconomyView } from "@wmm/wire-contracts";
import { wrap } from "./workspace/text.js";

export const economyCategories = ["stock-observation", "delivery-commitment", "planned-requirement"] as const;
export type EconomyCategory = typeof economyCategories[number];
export const economyCategoryLabels: Readonly<Record<EconomyCategory, string>> = {
  "stock-observation": "STOCK OBSERVATIONS",
  "delivery-commitment": "FUTURE COMMITMENTS",
  "planned-requirement": "PLANNED REQUIREMENTS",
};
export type EconomyRecord = EconomyView["records"][number];
const prose = (lines: readonly string[], width: number): string[] => lines.flatMap(line => wrap(line, width));
export const economyEntityLabel = (view: EconomyView, id: string): string => {
  const name = view.entities.find(entity => entity.id === id)?.name;
  return name === undefined ? id : `${name} (${id})`;
};
const role = (view: EconomyView, value: EconomicRole): string => value.kind === "unknown" ? "unknown" : economyEntityLabel(view, value.entityId);
const declaration = (value: EconomicDeclaration): string => value.kind === "unknown" ? "unknown" : value.description;
const scopeValue = (value: ScopeV1[keyof ScopeV1]): string => value.kind === "ref" ? value.id : value.kind;

export function economyReferenceLabel(view: EconomyView, reference: EconomicPoint | EconomicPeriod): string {
  if (reference.kind === "unknown") return "unknown (not mapped)";
  if (reference.kind === "unmapped") return `unmapped: ${reference.label}`;
  const axis = view.axes.find(axis => axis.definitionDigest === reference.axisDefinitionDigest);
  const position = "position" in reference ? `point ${reference.position}` : `period [${reference.start}, ${reference.endExclusive}) (end exclusive)`;
  return `mapped ${position}; axis ${axis?.key ?? "unknown"} (${reference.axisDefinitionDigest})`;
}

export function economyRecordSummary(view: EconomyView, record: EconomyRecord): string {
  return `${record.value.id} | ${record.value.quantity.magnitude.kind}: ${formatQuantity(record.value.quantity)} | ${economyEntityLabel(view, record.subjectId)} | ${economyEntityLabel(view, record.value.resourceId)}`;
}

/** Shared readable record inspector. References describe reports, not applicability. */
export function economyRecordLines(view: EconomyView, record: EconomyRecord, width = 100): string[] {
  const value: EconomicRecordValue = record.value;
  const lines = [economyCategoryLabels[value.kind], `Report: ${value.id}`, `Subject: ${economyEntityLabel(view, record.subjectId)}`, `Resource: ${economyEntityLabel(view, value.resourceId)}`,
    `Quantity (${value.quantity.magnitude.kind}): ${formatQuantity(value.quantity)}`, `Unit identity: ${value.quantity.unitId}`,
    `Scope account: ${scopeValue(record.scope.account)}`, `Scope jurisdiction: ${scopeValue(record.scope.jurisdiction)}`, `Scope recognition frame: ${scopeValue(record.scope.recognitionFrame)}`,
    `Reference: ${economyReferenceLabel(view, value.reference)}`, "Reference is not claim applicability; no current date or calendar is inferred.", "", value.description];
  if (value.kind === "stock-observation") lines.push(`Status: ${value.status}`, `Owner: ${role(view, value.owner)}`, `Custodian: ${role(view, value.custodian)}`, `Location: ${role(view, value.location)}`, `Available use (declared, not a computed total): ${declaration(value.availableUse)}`);
  else if (value.kind === "delivery-commitment") lines.push("Timing: future-as-authored; not an arrival or stock", `Relative to: ${economyReferenceLabel(view, value.timing.relativeTo)}`, `Promisor: ${role(view, value.promisor)}`, `Recipient: ${role(view, value.recipient)}`, `Destination: ${role(view, value.destination)}`);
  else lines.push("Plan only; not consumption or negative inventory.", `Planner: ${role(view, value.planner)}`, `Beneficiary: ${role(view, value.beneficiary)}`, `Purpose: ${value.purpose}`);
  lines.push("", `Method: ${declaration(value.method)}`, `Boundary: ${value.boundary.kind === "unknown" ? "unknown" : value.boundary.description}`);
  if (value.boundary.kind === "declared") lines.push(`Boundary entities: ${value.boundary.entityIds.map(id => economyEntityLabel(view, id)).join(", ") || "none declared"}`);
  lines.push(`Coverage: ${value.coverage.kind} — ${value.coverage.description}`, "Declared coverage is not a completeness certificate.", "", "CITATIONS (references only; no captured document content or documentary verification)");
  for (const citation of value.citations) {
    const source = view.sources.find(source => source.id === citation.sourceId);
    lines.push(`${citation.sourceId}${source ? ` | ${source.title} | ${source.path}` : " | source metadata unavailable"}`, `Locator: ${citation.locator}`);
  }
  if (!value.citations.length) lines.push("No citations declared.");
  lines.push("", `Assertion: ${record.assertionId}`);
  return prose(lines, width);
}

export function economyBindingLines(view: EconomyView, width = 100): string[] {
  return prose(["ECONOMY / DM / READ-ONLY", `World: ${view.worldId}`, `Base snapshot: ${view.snapshotDigest}`, `Semantic profile: ${view.semanticProfileDigest}`, `Captured input: ${view.inputDigest}`, "Accounting: not-run | Scenarios: not-run", "Unknown is not zero. Commitments are not stock; planned requirements are not consumption.", "No availability totals, execution, approval or canon writes."], width);
}

/** Complete linear view; no implicit reads, conversions, accounting or terminal controls. */
export function renderEconomyPlain(view: EconomyView, width = 100): string {
  const lines = economyBindingLines(view, width);
  for (const category of economyCategories) {
    const records = view.records.filter(record => record.value.kind === category);
    lines.push("", ...prose([economyCategoryLabels[category]], width));
    if (!records.length) lines.push(...prose(["No records declared in this category."], width));
    for (const record of records) lines.push("", ...economyRecordLines(view, record, width));
  }
  lines.push("", ...prose(["LIMITATIONS", ...view.limitations], width));
  return lines.join("\n");
}

export function renderWorkspaceEconomyPlain(view: WorkspaceEconomyView, width = 100): string {
  return [...prose([`Workspace: ${view.workspaceId} | Saved v${view.workspaceVersion}`, "BASE WORLD | Selected proposals excluded; candidate unavailable."], width), renderEconomyPlain(view.economy, width), ...prose(["", ...view.limitations], width)].join("\n");
}
