/** Maximum decimal digits per canonical component, excluding a numerator's sign. */
export const MAX_RATIONAL_DIGITS = 64;

/** Signed integer numerator and positive integer denominator, each <=64 decimal digits
 * excluding the sign. No leading zeros, -0, plus signs, decimals or exponents.
 * Wire validates tokens/shape; core additionally requires gcd=1, including zero 0/1.
 */
export interface ExactRational {
  readonly numerator: string;
  readonly denominator: string;
}

/** Bounds are inclusive. Core verifies ordering; equal endpoints still mean bounded. */
export type QuantityMagnitude =
  | { readonly kind: "exact"; readonly value: ExactRational }
  | { readonly kind: "bounded"; readonly lower: ExactRational; readonly upper: ExactRational }
  | { readonly kind: "unknown" };

/** A unit ID is identity, not a symbol. Wire shape does not admit a unit definition. */
export interface Quantity {
  readonly unitId: string;
  readonly magnitude: QuantityMagnitude;
}
