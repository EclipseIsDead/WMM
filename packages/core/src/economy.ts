import { canonicalJson } from "@wmm/canonical";
import type { AuthoringEconomicRecord, AuthoringEconomicPoint, AuthoringEconomicPeriod, EconomicPoint, EconomicPeriod, EconomicRecordValue, JsonValue, SemanticDefinitionV1 } from "@wmm/wire-contracts";
import { validateEconomicRecordValue } from "@wmm/wire-contracts";
import { MeasurementError, normalizeQuantity } from "./measurement.js";

export class EconomyError extends TypeError {
  constructor(message: string) { super(message); this.name = "EconomyError"; }
}
export interface EconomicReferenceContext {
  readonly entityIds: ReadonlySet<string>;
  readonly placeIds: ReadonlySet<string>;
  readonly sourceIds: ReadonlySet<string>;
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
}
/** Nested semantic references, independent of presentation indexes. */
export function economicEntityIds(value: EconomicRecordValue): readonly string[] {
  const roles = value.kind === "stock-observation" ? [value.owner, value.custodian, value.location] : value.kind === "delivery-commitment" ? [value.promisor, value.recipient, value.destination] : [value.planner, value.beneficiary];
  return [...new Set([value.resourceId, ...roles.flatMap((role) => role.kind === "declared" ? [role.entityId] : []), ...(value.boundary.kind === "declared" ? value.boundary.entityIds : [])])].sort();
}
export function economicMappedReferences(value: EconomicRecordValue): readonly Extract<EconomicPoint | EconomicPeriod, { kind: "mapped" }>[] {
  const references = value.kind === "delivery-commitment" ? [value.reference, value.timing.relativeTo] : [value.reference];
  return references.filter((reference): reference is Extract<EconomicPoint | EconomicPeriod, { kind: "mapped" }> => reference.kind === "mapped");
}
/** Shape admission detaches data before any collection methods or property reads. */
export function admitEconomicRecordValue(input: unknown, context: EconomicReferenceContext): EconomicRecordValue {
  if (!validateEconomicRecordValue(input).valid) throw new EconomyError("Invalid economic record value");
  const value = JSON.parse(canonicalJson(input as JsonValue)) as EconomicRecordValue;
  try { normalizeQuantity(value.quantity); }
  catch (error) {
    if (error instanceof MeasurementError) throw new EconomyError(error.message);
    throw error;
  }
  const magnitude = value.quantity.magnitude;
  const lower = magnitude.kind === "exact" ? magnitude.value : magnitude.kind === "bounded" ? magnitude.lower : undefined;
  if (lower !== undefined && BigInt(lower.numerator) < 0n) throw new EconomyError("Economic physical amounts must be nonnegative");
  for (const id of economicEntityIds(value)) if (!context.entityIds.has(id)) throw new EconomyError(`Unknown economic entity: ${id}`);
  const location = value.kind === "stock-observation" ? value.location : value.kind === "delivery-commitment" ? value.destination : undefined;
  if (location?.kind === "declared" && !context.placeIds.has(location.entityId)) throw new EconomyError("Economic physical location/destination requires a place");
  for (const citation of value.citations) if (!context.sourceIds.has(citation.sourceId)) throw new EconomyError(`Unknown economic citation source: ${citation.sourceId}`);
  for (const reference of economicMappedReferences(value)) {
    if (context.definitionsByDigest[reference.axisDefinitionDigest]?.kind !== "axis") throw new EconomyError("Unknown economic reference axis");
  }
  if (value.kind !== "stock-observation" && value.reference.kind === "mapped" && BigInt(value.reference.start) >= BigInt(value.reference.endExclusive)) {
    throw new EconomyError("Economic period requires start < endExclusive");
  }
  if (value.kind === "delivery-commitment" && value.reference.kind === "mapped" && value.timing.relativeTo.kind === "mapped" && value.reference.axisDefinitionDigest === value.timing.relativeTo.axisDefinitionDigest && BigInt(value.reference.start) <= BigInt(value.timing.relativeTo.position)) {
    throw new EconomyError("Future delivery must start after its authored relativeTo point");
  }
  return value;
}
/** Internal compiler transform, after detached authoring admission. Subject, context
 * and applicability belong to the claim, never the literal. */
export function compileEconomicRecordValue(record: AuthoringEconomicRecord, definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>): EconomicRecordValue {
  function mapped(reference: AuthoringEconomicPoint): EconomicPoint;
  function mapped(reference: AuthoringEconomicPeriod): EconomicPeriod;
  function mapped(reference: AuthoringEconomicPoint | AuthoringEconomicPeriod): EconomicPoint | EconomicPeriod {
    if (reference.kind !== "mapped") return reference;
    const axis = Object.entries(definitionsByDigest).find(([, definition]) => definition.key === reference.axisKey && definition.kind === "axis");
    if (axis === undefined) throw new EconomyError(`Unknown economic axis: ${reference.axisKey}`);
    return "position" in reference ? { kind: "mapped", axisDefinitionDigest: axis[0], position: reference.position } : { kind: "mapped", axisDefinitionDigest: axis[0], start: reference.start, endExclusive: reference.endExclusive };
  }
  const { subjectId: _subject, context: _context, applicability: _applicability, ...value } = record;
  if (value.kind === "stock-observation") return { ...value, reference: mapped(value.reference) };
  if (value.kind === "planned-requirement") return { ...value, reference: mapped(value.reference) };
  return { ...value, reference: mapped(value.reference), timing: { kind: "future-as-authored", relativeTo: mapped(value.timing.relativeTo) } };
}
