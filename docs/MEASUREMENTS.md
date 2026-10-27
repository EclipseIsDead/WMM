# Shared exact quantities

Implemented foundation for the economy increment. This module supplies quantity shapes, admitted physical units and pure arithmetic. Economic records, observations, accounting, scenarios and the Economy UI are still separate work in progress; adding a quantity here does not create a world assertion, change stock, execute a delivery, or advance time.

## Representation and admission

A `Quantity` contains a `unitId` and one magnitude:

- `exact`: one `value: { numerator, denominator }`.
- `bounded`: inclusive `lower` and `upper` rationals. Equal endpoints retain bounded status.
- `unknown`: no numeric value. Unknown is not zero.

Rational components are canonical decimal integer **strings**, not fractional JSON numbers or JSON BigInts. The numerator may be signed; the denominator is positive. Each has at most 64 digits excluding the numerator sign. Core requires reduced fractions and represents zero only as `0/1`. Leading zeros, negative zero, plus/exponent/decimal forms, whitespace, unreduced values and oversized components are rejected rather than repaired.

`@wmm/wire-contracts` exports `ExactRational`, `QuantityMagnitude`, `Quantity`, `MAX_RATIONAL_DIGITS`, `measurementSchema`, and the shape validators `validateExactRational`, `validateQuantityMagnitude`, and `validateQuantity`. The standalone schema is exported at `@wmm/wire-contracts/schemas/measurement.schema.json` with ID `urn:wmm:measurement`.

Wire validation checks closed shape, tokens and plain data. It does **not** establish rational reduction, endpoint ordering, admitted units, resource identity or factual truth. Use core admission before arithmetic; a shape-valid `2/4` or `unit:local_sack` is not core-admitted data.

## Initial admitted catalogue

| Exact unit ID | Quantity kind | Fixed display symbol |
| --- | --- | --- |
| `unit:kilogram` | Mass | `kg` |
| `unit:tonne` | Mass | `t` |
| `unit:one` | Count | `item` |

Definitions in `MEASUREMENT_UNITS` are deeply frozen and release-owned; tonne uses the explicit exact scale `1000/1` relative to kilogram. Lookups use the exact ID, never the display symbol or a caller-supplied scale. The first catalogue supports neither currency nor local/authored units. In particular it does not guess the mass of a sack or convert goods to money.

## Core API

`@wmm/core` exports:

- `normalizeExactRational(input)` and `normalizeQuantity(input)` — reject invalid input and return detached, deeply frozen data without mutating/freezing caller objects.
- `addQuantities(left, right)` and `subtractQuantities(left, right)` — use exact compatible-unit conversion and return the result in the left operand's unit.
- `convertQuantity(input, targetUnitId)` — require an explicitly named, admitted compatible target.
- `formatQuantity(input)` — locale-independent literal text such as `-1/3 kg`, `[0, 1/3] t`, or `unknown item`.
- `getMeasurementUnit(unitId)`, `MEASUREMENT_UNITS`, `MeasurementUnit`, and `MeasurementUnitId`.
- `MeasurementError` with `INVALID_QUANTITY`, `INVALID_RATIONAL`, `INVALID_BOUNDS`, `UNKNOWN_UNIT`, `INCOMPATIBLE_UNITS`, and `QUANTITY_OVERFLOW` codes.

Unknown operands remain unknown, but do not bypass admission of the other operand or unit compatibility. Bounded arithmetic returns conservative inclusive envelopes and never silently promotes an estimate into an exact observation. Subtracting a bounded quantity from itself does not infer correlation or an exact zero.

Intermediate BigInts are internal only. Arithmetic reduces the final result before enforcing component limits, so cancellation is not prematurely rejected. An unrepresentable final component fails closed; there is no silent rounding, partial interval or zero-clamping.

Dimension compatibility is **not resource compatibility**. The economic layer must separately establish that amounts concern the same resource, reporting boundary and relevant period before using this arithmetic for an accounting conclusion.

## Runnable source-checkout example

After `pnpm build`, run from the repository root:

```sh
node --input-type=module <<'JS'
import { addQuantities, convertQuantity, formatQuantity } from './packages/core/dist/index.js';
const exact = (numerator, unitId = 'unit:tonne', denominator = '1') => ({
  unitId, magnitude: { kind: 'exact', value: { numerator, denominator } },
});
console.log(formatQuantity(addQuantities(exact('600'), exact('250'))));
console.log(formatQuantity(convertQuantity(exact('1', 'unit:kilogram', '3'), 'unit:tonne')));
JS
```

Verified output:

```text
850 t
1/3000 t
```

These are pure arithmetic results. The first does not establish that a scheduled shipment arrived or that an observed inventory changed. A signed arithmetic difference may be negative; a later physical-stock projection must keep unmet requirements distinct from stock rather than call that difference a negative physical inventory.

## Scope and verification

The measurement tests cover lexical/canonical rejection, exact conversions and fractions, interval/unknown propagation, final-result bounds and cancellation, hostile programmatic data, immutable outputs and literal formatting. The E1a gate, before economic-record integration, passed the full 1,373 tests across 73 files under Node 26.12.1; all 104 existing fixture JSON inputs remained covered by the 50-check fixture gate. Independent review found no blocking defects and exercised an independent Python Fraction oracle plus schema/registry checks. An additional optional hostile-object harness was not completed after its approval timed out; it does not add coverage beyond the existing executed hostile-input tests. These are results for the quantity foundation, not a claim that economic world/profile integration or a player-safe view exists.
