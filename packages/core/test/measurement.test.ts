import type { ExactRational, Quantity } from "@wmm/wire-contracts";
import { describe, expect, it } from "vitest";

import * as core from "../src/index.js";

const rational = (numerator: string, denominator = "1"): ExactRational => ({ numerator, denominator });
const exact = (numerator: string, denominator = "1", unitId = "unit:kilogram"): Quantity => ({ unitId, magnitude: { kind: "exact", value: rational(numerator, denominator) } });
const bounded = (lower: ExactRational, upper: ExactRational, unitId = "unit:kilogram"): Quantity => ({ unitId, magnitude: { kind: "bounded", lower, upper } });
const unknownQuantity = (unitId = "unit:kilogram"): Quantity => ({ unitId, magnitude: { kind: "unknown" } });

function normalize(input: unknown): Quantity {
  const run = Reflect.get(core, "normalizeQuantity") as (input: unknown) => Quantity;
  expect(typeof run).toBe("function");
  return run(input);
}

describe("exact quantity arithmetic", () => {
  it("converts exact values only to an explicitly named admitted compatible unit", () => {
    expect(typeof Reflect.get(core, "convertQuantity")).toBe("function");
    expect(core.convertQuantity(exact("1", "3", "unit:tonne"), "unit:kilogram")).toEqual(exact("1000", "3"));
    expect(core.convertQuantity(exact("1", "3"), "unit:tonne")).toEqual(exact("1", "3000", "unit:tonne"));
    const input = exact("1", "3", "unit:one");
    const output = core.convertQuantity(input, "unit:one");
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(() => Reflect.apply(core.convertQuantity, undefined, [input])).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
  });
  it("subtracts exact fractions without rounding or changing the left unit", () => {
    expect(typeof Reflect.get(core, "subtractQuantities")).toBe("function");
    expect(core.subtractQuantities(exact("1", "3"), exact("1", "6"))).toEqual(exact("1", "6"));
    expect(core.subtractQuantities(exact("1", "6"), exact("1", "3"))).toEqual(exact("-1", "6"));
    expect(core.subtractQuantities(exact("-1", "3"), exact("-1", "3"))).toEqual(exact("0"));
    expect(core.subtractQuantities(exact("1", "2"), exact("1", "3", "unit:tonne"))).toEqual(exact("-1997", "6"));
  });
  it("adds exact fractions in the left operand's admitted compatible unit", () => {
    expect(typeof Reflect.get(core, "addQuantities")).toBe("function");
    expect(core.addQuantities(exact("1", "3"), exact("1", "6"))).toEqual(exact("1", "2"));
    expect(core.addQuantities(exact("-1", "3"), exact("1", "3"))).toEqual(exact("0"));
    expect(core.addQuantities(exact("9007199254740993"), exact("1"))).toEqual(exact("9007199254740994"));
    expect(core.addQuantities(exact("1", "2"), exact("1", "3", "unit:tonne"))).toEqual(exact("2003", "6"));
    expect(core.addQuantities(exact("1", "3", "unit:tonne"), exact("1", "2"))).toEqual(exact("2003", "6000", "unit:tonne"));
    expect(core.addQuantities(exact("1", "3", "unit:one"), exact("1", "6", "unit:one"))).toEqual(exact("1", "2", "unit:one"));
  });
});

describe("interval quantity arithmetic", () => {
  it("converts every inclusive endpoint exactly while preserving bounded status", () => {
    const input = bounded(rational("-1", "3"), rational("1", "3"), "unit:tonne");
    const converted = core.convertQuantity(input, "unit:kilogram");
    expect(converted).toEqual(bounded(rational("-1000", "3"), rational("1000", "3")));
    expect(core.convertQuantity(converted, "unit:tonne")).toEqual(input);
    expect(core.convertQuantity(bounded(rational("1", "3"), rational("1", "3")), "unit:tonne"))
      .toEqual(bounded(rational("1", "3000"), rational("1", "3000"), "unit:tonne"));
  });
  it("propagates inclusive ranges conservatively without inventing precision or correlation", () => {
    const left = bounded(rational("-1", "2"), rational("1", "3"));
    const right = bounded(rational("1", "3"), rational("2", "3"));
    expect(core.addQuantities(left, right)).toEqual(bounded(rational("-1", "6"), rational("1")));
    expect(core.subtractQuantities(left, right)).toEqual(bounded(rational("-7", "6"), rational("0")));
    expect(core.subtractQuantities(left, left)).toEqual(bounded(rational("-5", "6"), rational("5", "6")));
    expect(core.addQuantities(left, exact("1", "6"))).toEqual(bounded(rational("-1", "3"), rational("1", "2")));
    expect(core.addQuantities(exact("1", "6"), left)).toEqual(bounded(rational("-1", "3"), rational("1", "2")));
    expect(core.subtractQuantities(exact("1", "6"), left)).toEqual(bounded(rational("-1", "6"), rational("2", "3")));
    const delivery = bounded(rational("0"), rational("1", "1000"), "unit:tonne");
    expect(core.addQuantities(left, delivery)).toEqual(bounded(rational("-1", "2"), rational("4", "3")));
    expect(core.subtractQuantities(left, delivery)).toEqual(bounded(rational("-3", "2"), rational("1", "3")));
    const equal = bounded(rational("1", "3"), rational("1", "3"));
    expect(core.addQuantities(equal, exact("1", "6"))).toEqual(bounded(rational("1", "2"), rational("1", "2")));
    expect(core.subtractQuantities(equal, equal)).toEqual(bounded(rational("0"), rational("0")));
  });
});

describe("unknown quantity propagation", () => {
  it("keeps unknown distinct from zero through arithmetic and compatible conversion", () => {
    const unknown = unknownQuantity();
    expect(core.addQuantities(unknown, exact("0"))).toEqual(unknown);
    expect(normalize(unknown)).not.toEqual(exact("0"));
    for (const operation of [core.addQuantities, core.subtractQuantities]) {
      for (const known of [exact("0"), exact("1", "3", "unit:tonne"), bounded(rational("0"), rational("1")), unknown]) {
        expect(operation(unknown, known)).toEqual(unknown);
        expect(operation(known, unknown)).toEqual(unknownQuantity(known.unitId));
      }
    }
    expect(core.subtractQuantities(unknown, unknown)).toEqual(unknown);
    const converted = core.convertQuantity(unknown, "unit:tonne");
    expect(converted).toEqual(unknownQuantity("unit:tonne"));
    expect(converted).not.toBe(unknown);
    expect(Object.isFrozen(converted.magnitude)).toBe(true);
  });
});

describe("bounded exact arithmetic resources", () => {
  it("fails closed when a final canonical component exceeds 64 digits, without premature intermediate rejection", () => {
    const maximum = "9".repeat(64);
    const overflow = expect.objectContaining({ code: "QUANTITY_OVERFLOW" });
    expect(() => core.addQuantities(exact(maximum), exact("1"))).toThrow(overflow);
    expect(() => core.subtractQuantities(exact("-" + maximum), exact("1"))).toThrow(overflow);
    expect(() => core.convertQuantity(exact(maximum, "1", "unit:tonne"), "unit:kilogram")).toThrow(overflow);
    const denominator = "1" + "0".repeat(63);
    expect(() => core.convertQuantity(exact("1", denominator), "unit:tonne")).toThrow(overflow);
    expect(() => core.addQuantities(exact("1", denominator), exact("1", "9".repeat(63)))).toThrow(overflow);
    const interval = bounded(rational("0"), rational(maximum));
    const before = structuredClone(interval);
    expect(() => core.addQuantities(interval, exact("1"))).toThrow(overflow);
    expect(interval).toEqual(before);
    expect(() => core.convertQuantity(bounded(rational("0"), rational(maximum), "unit:tonne"), "unit:kilogram")).toThrow(overflow);
    expect(core.addQuantities(exact(maximum), exact("-" + maximum))).toEqual(exact("0"));
    expect(core.addQuantities(exact("1", denominator), exact(String(BigInt(denominator) - 1n), denominator))).toEqual(exact("1"));
    // This right operand alone cannot be represented in kilograms, but the final sum can.
    expect(core.addQuantities(exact("-" + maximum), exact("1" + "0".repeat(61), "1", "unit:tonne"))).toEqual(exact("1"));
    expect(core.convertQuantity(exact(maximum), "unit:kilogram")).toEqual(exact(maximum));
  });
});

describe("human quantity formatting", () => {
  it("uses literal fractions, inclusive brackets or unknown with the admitted unit symbol", () => {
    expect(typeof Reflect.get(core, "formatQuantity")).toBe("function");
    for (const [quantity, text] of [
      [exact("-1", "3"), "-1/3 kg"], [exact("0"), "0 kg"], [exact("2", "1", "unit:tonne"), "2 t"],
      [bounded(rational("-1", "3"), rational("2", "3")), "[-1/3, 2/3] kg"],
      [bounded(rational("1", "3"), rational("1", "3")), "[1/3, 1/3] kg"],
      [unknownQuantity("unit:tonne"), "unknown t"], [exact("2", "1", "unit:one"), "2 item"],
      [unknownQuantity("unit:one"), "unknown item"],
    ] as const) expect(core.formatQuantity(quantity)).toBe(text);
  });
});

describe("measurement core admission", () => {
  it("rejects incompatible or unsupported units even when a magnitude is unknown", () => {
    const mass = [exact("1"), bounded(rational("0"), rational("1")), unknownQuantity()];
    const count = [exact("1", "1", "unit:one"), bounded(rational("0"), rational("1"), "unit:one"), unknownQuantity("unit:one")];
    for (const left of mass) {
      expect(() => core.convertQuantity(left, "unit:one")).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_UNITS" }));
      for (const right of count) {
        for (const operation of [core.addQuantities, core.subtractQuantities]) {
          expect(() => operation(left, right)).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_UNITS" }));
          expect(() => operation(right, left)).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_UNITS" }));
        }
      }
      for (const unitId of ["kg", "unit:local_sack", "unit:usd"]) {
        expect(() => core.convertQuantity(left, unitId)).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
      }
    }
    for (const unitId of ["unit:local_sack", "unit:usd"]) {
      const unknown = unknownQuantity(unitId);
      for (const consume of [core.normalizeQuantity, core.formatQuantity, (value: unknown) => core.convertQuantity(value, "unit:kilogram"), (value: unknown) => core.addQuantities(unknownQuantity(), value)]) {
        expect(() => consume(unknown)).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
      }
    }
    // Unknown never bypasses validation of the other operand.
    expect(() => core.addQuantities(unknownQuantity(), exact("2", "4"))).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    expect(() => core.subtractQuantities(exact("2", "4"), unknownQuantity())).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
  });

  it("admits all programmatic consumers without executing caller accessors, proxies or coercions", () => {
    let calls = 0;
    const trap = (): never => { calls += 1; throw new Error("Caller behavior executed"); };
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const getter = Object.defineProperty({ magnitude: { kind: "unknown" } }, "unitId", { enumerable: true, get: trap });
    const hidden = Object.defineProperty({ ...unknownQuantity() }, "secret", { value: "x" });
    const inherited = Object.create({ get unitId() { return trap(); } }) as unknown;
    const cyclic: Record<string, unknown> = { unitId: "unit:kilogram" }; cyclic["magnitude"] = cyclic;
    const candidates = [proxy, revoked.proxy, getter, hidden, inherited, cyclic,
      { unitId: "unit:kilogram", magnitude: proxy }, { ...exact("1"), magnitude: { kind: "exact", value: proxy } },
      { ...exact("1"), magnitude: { kind: "exact", value: { numerator: "1", get denominator() { return trap(); } } } },
      { ...unknownQuantity(), toJSON: trap }, { ...unknownQuantity(), [Symbol("extra")]: "x" },
      null, [], Object.create(null) as unknown,
    ];
    const consumers = [core.normalizeQuantity, core.formatQuantity,
      (value: unknown) => core.addQuantities(value, unknownQuantity()), (value: unknown) => core.addQuantities(unknownQuantity(), value),
      (value: unknown) => core.subtractQuantities(value, unknownQuantity()), (value: unknown) => core.subtractQuantities(unknownQuantity(), value),
      (value: unknown) => core.convertQuantity(value, "unit:kilogram"),
    ];
    for (const value of candidates) {
      for (const consume of consumers) expect(() => consume(value)).toThrow(expect.objectContaining({ code: "INVALID_QUANTITY" }));
    }
    for (const value of [proxy, revoked.proxy, { numerator: "1", get denominator() { return trap(); } }]) {
      expect(() => core.normalizeExactRational(value)).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    }
    expect(() => Reflect.apply(core.convertQuantity, undefined, [unknownQuantity(), proxy])).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
    expect(() => Reflect.apply(core.getMeasurementUnit, undefined, [{ [Symbol.toPrimitive]: trap }])).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
    expect(calls).toBe(0);
  });

  it("rejects lexical and closed-shape violations consistently in every quantity consumer", () => {
    const consumers = [core.normalizeQuantity, core.formatQuantity,
      (value: unknown) => core.addQuantities(value, exact("1")), (value: unknown) => core.subtractQuantities(exact("1"), value),
      (value: unknown) => core.convertQuantity(value, "unit:tonne"),
    ];
    for (const value of [exact("01"), exact("-0"), exact("+1"), exact("1e3"), exact("1\n"), exact("1", "-1"), exact("1", "0"), exact("1".repeat(65)), exact("1", "1".repeat(65)),
      { unitId: "unit:kilogram", magnitude: { kind: "exact", value: { numerator: 1.5, denominator: "1" } } },
      { unitId: "unit:kilogram", magnitude: { kind: "exact", value: { numerator: 1n, denominator: "1" } } },
      { ...unknownQuantity(), symbol: "kg" }, { unitId: "unit:kilogram", magnitude: { kind: "unknown", value: rational("0") } },
      unknownQuantity("unit:kilogram\n"), unknownQuantity("unit:toString"),
    ]) {
      for (const consume of consumers) expect(() => consume(value)).toThrow(expect.objectContaining({ code: "INVALID_QUANTITY" }));
    }
  });

  it("detaches aliased endpoints and arithmetic results without freezing or modifying caller data", () => {
    const endpoint = { numerator: "1", denominator: "3" };
    const input = { unitId: "unit:kilogram", magnitude: { kind: "bounded", lower: endpoint, upper: endpoint } };
    const output = normalize(input);
    const sum = core.addQuantities(input, exact("0"));
    const difference = core.subtractQuantities(input, exact("0"));
    const converted = core.convertQuantity(input, "unit:kilogram");
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(endpoint)).toBe(false);
    endpoint.numerator = "2";
    for (const admitted of [output, sum, difference, converted]) {
      expect(admitted).toEqual(bounded(rational("1", "3"), rational("1", "3")));
      if (admitted.magnitude.kind !== "bounded") throw new Error("Expected bounds");
      expect(admitted.magnitude.lower).not.toBe(endpoint);
      expect(admitted.magnitude.upper).not.toBe(endpoint);
      expect(admitted.magnitude.lower).not.toBe(admitted.magnitude.upper);
      expect(Object.isFrozen(admitted.magnitude.lower)).toBe(true);
      expect(Object.isFrozen(admitted.magnitude.upper)).toBe(true);
      expect(JSON.parse(JSON.stringify(admitted))).toEqual(admitted);
    }
  });
  it("requires inclusive ordered rational endpoints and preserves equal-endpoint bounded status", () => {
    for (const candidate of [bounded(rational("1", "2"), rational("1", "3")), bounded(rational("-1", "3"), rational("-1", "2"))]) {
      expect(() => normalize(candidate)).toThrow(expect.objectContaining({ code: "INVALID_BOUNDS" }));
    }
    for (const candidate of [bounded(rational("-1", "2"), rational("1", "3")), bounded(rational("1", "3"), rational("1", "3"))]) {
      const admitted = normalize(candidate);
      expect(admitted).toEqual(candidate);
      expect(admitted.magnitude.kind).toBe("bounded");
      if (admitted.magnitude.kind !== "bounded" || candidate.magnitude.kind !== "bounded") throw new Error("Expected bounds");
      expect(admitted.magnitude.lower).not.toBe(candidate.magnitude.lower);
      expect(admitted.magnitude.upper).not.toBe(candidate.magnitude.upper);
      expect(Object.isFrozen(admitted.magnitude.lower)).toBe(true);
      expect(Object.isFrozen(admitted.magnitude.upper)).toBe(true);
    }
    expect(() => normalize(bounded(rational("2", "4"), rational("1")))).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    expect(() => normalize(bounded(rational("0"), rational("4", "2")))).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
  });
  it("admits only the immutable release-owned mass/count catalogue, not symbols, currency or local units", () => {
    for (const unitId of ["unit:local_sack", "unit:usd", "unit:kilograms", "unit:kg", "unit:tostring"]) {
      expect(() => normalize(exact("1", "1", unitId))).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
    }
    expect(typeof Reflect.get(core, "getMeasurementUnit")).toBe("function");
    expect(core.MEASUREMENT_UNITS).toEqual([
      { id: "unit:kilogram", kind: "mass", baseUnitId: "unit:kilogram", scaleToBase: rational("1"), symbol: "kg" },
      { id: "unit:tonne", kind: "mass", baseUnitId: "unit:kilogram", scaleToBase: rational("1000"), symbol: "t" },
      { id: "unit:one", kind: "count", baseUnitId: "unit:one", scaleToBase: rational("1"), symbol: "item" },
    ]);
    expect(Object.isFrozen(core.MEASUREMENT_UNITS)).toBe(true);
    for (const unit of core.MEASUREMENT_UNITS) {
      expect(core.getMeasurementUnit(unit.id)).toBe(unit);
      expect(normalize(exact("1", "1", unit.id)).unitId).toBe(unit.id);
      expect(Object.isFrozen(unit)).toBe(true);
      expect(Object.isFrozen(unit.scaleToBase)).toBe(true);
      expect(Reflect.set(unit.scaleToBase, "numerator", "999")).toBe(false);
    }
    for (const symbol of ["kg", "t", "item", "unit:usd"]) {
      expect(() => core.getMeasurementUnit(symbol)).toThrow(expect.objectContaining({ code: "UNKNOWN_UNIT" }));
    }
  });
  it("rejects unreduced fractions and noncanonical zero rather than repairing them", () => {
    for (const [numerator, denominator] of [["2", "4"], ["-2", "4"], ["0", "2"], ["10", "5"]] as const) {
      expect(() => normalize(exact(numerator, denominator))).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    }
    expect(normalize(exact("0"))).toEqual(exact("0"));
    expect(typeof Reflect.get(core, "normalizeExactRational")).toBe("function");
    const input = rational("-5", "7");
    const admitted = core.normalizeExactRational(input);
    expect(admitted).toEqual(input);
    expect(admitted).not.toBe(input);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(() => core.normalizeExactRational(rational("2", "4"))).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    for (const candidate of [rational("01"), rational("-0"), rational("1", "0"), rational("1".repeat(65)), { numerator: 1n, denominator: "1" }]) {
      expect(() => core.normalizeExactRational(candidate)).toThrow(expect.objectContaining({ code: "INVALID_RATIONAL" }));
    }
  });
  it("admits exact fractional quantities as detached immutable plain data without mutating the caller", () => {
    const input = exact("-1", "3");
    const before = structuredClone(input);
    const admitted = normalize(input);
    expect(admitted).toEqual(before);
    expect(input).toEqual(before);
    expect(admitted).not.toBe(input);
    expect(admitted.magnitude).not.toBe(input.magnitude);
    expect(admitted.magnitude.kind).toBe("exact");
    if (admitted.magnitude.kind !== "exact" || input.magnitude.kind !== "exact") throw new Error("Expected exact quantities");
    expect(admitted.magnitude.value).not.toBe(input.magnitude.value);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.magnitude)).toBe(true);
    expect(Object.isFrozen(admitted.magnitude.value)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.magnitude.value)).toBe(false);
  });
});
