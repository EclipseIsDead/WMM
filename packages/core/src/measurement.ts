import { canonicalJson } from "@wmm/canonical";
import type { ExactRational, JsonValue, Quantity, QuantityMagnitude } from "@wmm/wire-contracts";
import { MAX_RATIONAL_DIGITS, validateExactRational, validateQuantity } from "@wmm/wire-contracts";

/** Shape/token failures use INVALID_QUANTITY; standalone rational admission and unreduced
 * fractions use INVALID_RATIONAL. Bounds, unit admission and result overflow stay distinct.
 * Input components outside the wire bounds are invalid input, not arithmetic overflow.
 */
export type MeasurementErrorCode =
  | "INVALID_QUANTITY"
  | "INVALID_RATIONAL"
  | "INVALID_BOUNDS"
  | "UNKNOWN_UNIT"
  | "INCOMPATIBLE_UNITS"
  | "QUANTITY_OVERFLOW";

export type MeasurementUnitId = "unit:kilogram" | "unit:tonne" | "unit:one";

export interface MeasurementUnit {
  readonly id: MeasurementUnitId;
  readonly kind: "mass" | "count";
  readonly baseUnitId: MeasurementUnitId;
  /** Multiply by this exact positive ratio to obtain the base-unit magnitude. */
  readonly scaleToBase: ExactRational;
  /** Fixed display symbol, never unit identity; count uses the literal symbol "item". */
  readonly symbol: string;
}

/** Immutable release-owned definitions; no currency, authored units or inferred sack sizes. */
export const MEASUREMENT_UNITS: readonly MeasurementUnit[] = Object.freeze([
  Object.freeze({ id: "unit:kilogram", kind: "mass", baseUnitId: "unit:kilogram", scaleToBase: Object.freeze({ numerator: "1", denominator: "1" }), symbol: "kg" } as const),
  Object.freeze({ id: "unit:tonne", kind: "mass", baseUnitId: "unit:kilogram", scaleToBase: Object.freeze({ numerator: "1000", denominator: "1" }), symbol: "t" } as const),
  Object.freeze({ id: "unit:one", kind: "count", baseUnitId: "unit:one", scaleToBase: Object.freeze({ numerator: "1", denominator: "1" }), symbol: "item" } as const),
]);

export class MeasurementError extends TypeError {
  constructor(readonly code: MeasurementErrorCode, message: string) {
    super(message);
    this.name = "MeasurementError";
  }
}

/** Lookup is by exact ID, without coercion, aliases or caller-supplied definitions. */
export function getMeasurementUnit(unitId: string): MeasurementUnit {
  const unit = MEASUREMENT_UNITS.find((candidate) => candidate.id === unitId);
  if (unit === undefined) throw new MeasurementError("UNKNOWN_UNIT", "Unsupported measurement unit ID");
  return unit;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function assertCanonicalRational(value: ExactRational): void {
  if (gcd(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) {
    throw new MeasurementError("INVALID_RATIONAL", "Rationals must be reduced; zero must be 0/1");
  }
}

/** Admission, not repair: reject noncanonical input and return a detached frozen fraction. */
export function normalizeExactRational(input: unknown): ExactRational {
  if (!validateExactRational(input).valid) throw new MeasurementError("INVALID_RATIONAL", "Invalid exact rational shape or integer token");
  const value = JSON.parse(canonicalJson(input as JsonValue)) as ExactRational;
  assertCanonicalRational(value);
  return Object.freeze(value);
}

/** Only call on freshly detached/constructed data; never freeze caller-owned objects. */
function freezeQuantity(quantity: Quantity): Quantity {
  const magnitude = quantity.magnitude;
  if (magnitude.kind === "exact") Object.freeze(magnitude.value);
  if (magnitude.kind === "bounded") {
    Object.freeze(magnitude.lower);
    Object.freeze(magnitude.upper);
  }
  Object.freeze(magnitude);
  return Object.freeze(quantity);
}

/** Descriptor-safe admission returns detached immutable data; it never repairs input tokens. */
export function normalizeQuantity(input: unknown): Quantity {
  if (!validateQuantity(input).valid) throw new MeasurementError("INVALID_QUANTITY", "Invalid quantity shape or non-JSON data");
  const quantity = JSON.parse(canonicalJson(input as JsonValue)) as Quantity;
  getMeasurementUnit(quantity.unitId);
  if (quantity.magnitude.kind === "exact") assertCanonicalRational(quantity.magnitude.value);
  if (quantity.magnitude.kind === "bounded") {
    assertCanonicalRational(quantity.magnitude.lower);
    assertCanonicalRational(quantity.magnitude.upper);
    const { lower, upper } = quantity.magnitude;
    if (BigInt(lower.numerator) * BigInt(upper.denominator) > BigInt(upper.numerator) * BigInt(lower.denominator)) {
      throw new MeasurementError("INVALID_BOUNDS", "Inclusive quantity bounds require lower <= upper");
    }
  }
  return freezeQuantity(quantity);
}

// BigInts are internal working values only; wire/public results always use decimal strings.
type Fraction = readonly [numerator: bigint, denominator: bigint];

function fraction(value: ExactRational): Fraction {
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

function sum(left: Fraction, right: Fraction, sign: 1n | -1n): Fraction {
  return [left[0] * right[1] + sign * right[0] * left[1], left[1] * right[1]];
}

function scale(value: ExactRational, source: MeasurementUnit, target: MeasurementUnit): Fraction {
  return [
    BigInt(value.numerator) * BigInt(source.scaleToBase.numerator) * BigInt(target.scaleToBase.denominator),
    BigInt(value.denominator) * BigInt(source.scaleToBase.denominator) * BigInt(target.scaleToBase.numerator),
  ];
}

function rationalResult([numerator, denominator]: Fraction): ExactRational {
  const divisor = gcd(numerator, denominator);
  const value = { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
  const numeratorDigits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (numeratorDigits > MAX_RATIONAL_DIGITS || value.denominator.length > MAX_RATIONAL_DIGITS) {
    throw new MeasurementError("QUANTITY_OVERFLOW", `Canonical result exceeds ${MAX_RATIONAL_DIGITS} digits per component`);
  }
  return Object.freeze(value);
}

function compatibleUnits(sourceId: string, targetId: string): readonly [MeasurementUnit, MeasurementUnit] {
  const source = getMeasurementUnit(sourceId);
  const target = getMeasurementUnit(targetId);
  if (source.kind !== target.kind) throw new MeasurementError("INCOMPATIBLE_UNITS", "Measurement units have incompatible quantity kinds");
  return [source, target];
}

function endpoints(magnitude: Exclude<QuantityMagnitude, { kind: "unknown" }>): readonly [ExactRational, ExactRational] {
  return magnitude.kind === "exact" ? [magnitude.value, magnitude.value] : [magnitude.lower, magnitude.upper];
}

function combineQuantities(leftInput: unknown, rightInput: unknown, sign: 1n | -1n): Quantity {
  const left = normalizeQuantity(leftInput);
  const right = normalizeQuantity(rightInput);
  const [source, target] = compatibleUnits(right.unitId, left.unitId);
  if (left.magnitude.kind === "unknown" || right.magnitude.kind === "unknown") {
    return freezeQuantity({ unitId: left.unitId, magnitude: { kind: "unknown" } });
  }
  const [leftLower, leftUpper] = endpoints(left.magnitude);
  const [rightLower, rightUpper] = endpoints(right.magnitude);
  const lower = rationalResult(sum(fraction(leftLower), scale(sign === 1n ? rightLower : rightUpper, source, target), sign));
  if (left.magnitude.kind === "exact" && right.magnitude.kind === "exact") {
    return freezeQuantity({ unitId: left.unitId, magnitude: { kind: "exact", value: lower } });
  }
  const upper = rationalResult(sum(fraction(leftUpper), scale(sign === 1n ? rightUpper : rightLower, source, target), sign));
  return freezeQuantity({ unitId: left.unitId, magnitude: { kind: "bounded", lower, upper } });
}

/** Explicit conversion only; no default target, quantity-kind inference or symbol aliases. */
export function convertQuantity(input: unknown, targetUnitId: string): Quantity {
  const quantity = normalizeQuantity(input);
  const [source, target] = compatibleUnits(quantity.unitId, targetUnitId);
  const magnitude = quantity.magnitude;
  if (magnitude.kind === "unknown") return freezeQuantity({ unitId: target.id, magnitude: { kind: "unknown" } });
  if (magnitude.kind === "exact") {
    const value = rationalResult(scale(magnitude.value, source, target));
    return freezeQuantity({ unitId: target.id, magnitude: { kind: "exact", value } });
  }
  const lower = rationalResult(scale(magnitude.lower, source, target));
  const upper = rationalResult(scale(magnitude.upper, source, target));
  return freezeQuantity({ unitId: target.id, magnitude: { kind: "bounded", lower, upper } });
}

/** Addition in the left unit: [a,b] + [c,d] = [a+c,b+d]. Unknown stays unknown;
 * any bounded operand keeps the result bounded, including equal endpoints.
 * Resource identity is the caller's separate domain check. No rounding/partial results.
 */
export function addQuantities(left: unknown, right: unknown): Quantity {
  return combineQuantities(left, right, 1n);
}

/** Subtraction in the left unit: [a,b] - [c,d] = [a-d,b-c], even for the same input.
 * No correlation/independence assumptions, exactness promotion or zero-clamping is inferred.
 */
export function subtractQuantities(left: unknown, right: unknown): Quantity {
  return combineQuantities(left, right, -1n);
}

function rationalText(value: ExactRational): string {
  return value.denominator === "1" ? value.numerator : `${value.numerator}/${value.denominator}`;
}

/** Literal, locale-independent DM text: "1/3 kg", "[0, 1/3] t", "unknown item".
 * Brackets are inclusive; no decimals, rounding, implicit conversion or symbol-based identity.
 */
export function formatQuantity(input: unknown): string {
  const quantity = normalizeQuantity(input);
  const { symbol } = getMeasurementUnit(quantity.unitId);
  const magnitude = quantity.magnitude;
  if (magnitude.kind === "unknown") return `unknown ${symbol}`;
  if (magnitude.kind === "exact") return `${rationalText(magnitude.value)} ${symbol}`;
  return `[${rationalText(magnitude.lower)}, ${rationalText(magnitude.upper)}] ${symbol}`;
}
