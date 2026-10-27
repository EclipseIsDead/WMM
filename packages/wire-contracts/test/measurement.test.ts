import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AnySchema, ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import type { ExactRational, Quantity, QuantityMagnitude } from "../src/index.js";

import * as wire from "../src/index.js";

function validator(name: string): (input: unknown) => { readonly valid: boolean; readonly errors: readonly unknown[] } {
  const validate = Reflect.get(wire, name) as ReturnType<typeof validator>;
  expect(typeof validate, name).toBe("function");
  return validate;
}

const fraction = (numerator: string, denominator = "1"): ExactRational => ({ numerator, denominator });

describe("measurement wire shapes", () => {
  it("exports a portable standalone quantity schema with stable reusable definitions", () => {
    const schema = JSON.parse(readFileSync(new URL(import.meta.resolve("@wmm/wire-contracts/schemas/measurement.schema.json")), "utf8")) as AnySchema;
    expect(schema).toEqual(wire.measurementSchema);
    expect(schema).toMatchObject({ $id: "urn:wmm:measurement", $ref: "#/$defs/Quantity" });
    const Ajv = createRequire(import.meta.url)("ajv/dist/2020") as new (options: object) => {
      addSchema(schema: AnySchema): void;
      compile(schema: AnySchema): ValidateFunction;
    };
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(schema);
    const validate = ajv.compile({ $ref: "urn:wmm:measurement#/$defs/Quantity" });
    const magnitude: QuantityMagnitude = { kind: "exact", value: fraction("1", "3") };
    const quantity: Quantity = { unitId: "unit:kilogram", magnitude };
    expect(validate(quantity)).toBe(true);
    expect(validate({ ...quantity, magnitude: { kind: "exact", value: fraction("01") } })).toBe(false);
    expect(wire.MAX_RATIONAL_DIGITS).toBe(64);
  });

  it("keeps arithmetic canonicality, endpoint ordering and unit admission separate from wire shape", () => {
    for (const value of [fraction("2", "4"), fraction("0", "2")]) {
      expect(validator("validateExactRational")(value).valid).toBe(true);
      expect(validator("validateQuantity")({ unitId: "unit:local_sack", magnitude: { kind: "exact", value } }).valid).toBe(true);
    }
    const reversed = { kind: "bounded", lower: fraction("1"), upper: fraction("0") };
    expect(validator("validateQuantityMagnitude")(reversed).valid).toBe(true);
  });

  it("rejects missing, extra, mixed-magnitude and non-string amount fields in closed shapes", () => {
    for (const value of [null, [], {}, { numerator: "1" }, { ...fraction("1"), scale: "kg" }]) {
      expect(validator("validateExactRational")(value).valid).toBe(false);
    }
    for (const magnitude of [
      {}, { kind: "known", value: fraction("1") }, { kind: "exact" }, { kind: "exact", value: 0.5 },
      { kind: "exact", value: fraction("1"), lower: fraction("0") }, { kind: "bounded", lower: fraction("0") },
      { kind: "bounded", lower: fraction("0"), upper: fraction("1"), inclusive: true }, { kind: "unknown", value: fraction("0") },
    ]) expect(validator("validateQuantityMagnitude")(magnitude).valid).toBe(false);
    for (const quantity of [{ unitId: "unit:kilogram" }, { magnitude: { kind: "unknown" } }, { unitId: "unit:kilogram", magnitude: { kind: "unknown" }, symbol: "kg" }]) {
      expect(validator("validateQuantity")(quantity).valid).toBe(false);
    }
  });

  it("reuses capture-free plain-data preflight without calling accessors, proxy traps or toJSON", () => {
    let calls = 0;
    const trap = (): never => { calls += 1; throw new Error("Caller behavior executed"); };
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const getter = Object.defineProperty({}, "kind", { enumerable: true, get: trap });
    const hidden = Object.defineProperty({ kind: "unknown" }, "secret", { value: "x" });
    const inherited = Object.create({ get kind() { return trap(); } }) as unknown;
    for (const candidate of [proxy, getter, hidden, inherited, { kind: "exact", value: proxy }, { kind: "exact", value: { numerator: "1", get denominator() { return trap(); } } }, { kind: "unknown", toJSON: trap }, { kind: "unknown", [Symbol("extra")]: "x" }]) {
      const result = validator("validateQuantityMagnitude")(candidate);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({ keyword: "jsonData" });
      expect(validator("validateQuantity")({ unitId: "unit:kilogram", magnitude: candidate }).valid).toBe(false);
    }
    expect(validator("validateExactRational")({ numerator: "\ud800", denominator: "1" }).valid).toBe(false);
    expect(calls).toBe(0);
  });
  it("rejects noncanonical integer tokens and components beyond 64 decimal digits", () => {
    const validate = validator("validateExactRational");
    for (const token of ["00", "01", "-0", "+1", "1.0", "1e3", " 1", "1 ", "1\n", "1\r", "١", "−1", "1".repeat(65), "-" + "1".repeat(65)]) {
      expect(validate(fraction(token)).valid, `numerator ${JSON.stringify(token)}`).toBe(false);
    }
    for (const token of ["0", "-1", "01", "+1", "1.0", "1e3", "1\n", "1".repeat(65)]) {
      expect(validate(fraction("1", token)).valid, `denominator ${JSON.stringify(token)}`).toBe(false);
    }
    for (const value of [fraction("9".repeat(64)), fraction("-" + "9".repeat(64)), fraction("1", "9".repeat(64))]) {
      expect(validate(value).valid).toBe(true);
    }
    for (const value of [{ numerator: 1, denominator: "1" }, { numerator: 1n, denominator: "1" }, { numerator: "1", denominator: 1.5 }]) {
      expect(validate(value).valid).toBe(false);
    }
  });
  it("requires literal unit identifiers instead of display symbols or repaired identifiers", () => {
    const validate = validator("validateQuantity");
    for (const unitId of ["kg", "", "unit:", "unit:1", "Unit:kilogram", "unit:kilogram\n", "unit:kilogram ", "unit:" + "x".repeat(252)]) {
      expect(validate({ unitId, magnitude: { kind: "unknown" } }).valid, JSON.stringify(unitId)).toBe(false);
    }
    // Shape admission does not claim that local units or currency are supported by core.
    for (const unitId of ["unit:kilogram", "unit:local_sack", "unit:usd"]) {
      expect(validate({ unitId, magnitude: { kind: "unknown" } }).valid).toBe(true);
    }
  });

  it("admits the exact, inclusive bounded, and explicit unknown quantity shapes", () => {
    const exact = { kind: "exact", value: fraction("-1", "3") };
    const bounded = { kind: "bounded", lower: fraction("0"), upper: fraction("3", "2") };
    const unknown = { kind: "unknown" };
    expect(validator("validateExactRational")(exact.value).valid).toBe(true);
    for (const magnitude of [exact, bounded, unknown]) {
      expect(validator("validateQuantityMagnitude")(magnitude).valid).toBe(true);
      expect(validator("validateQuantity")({ unitId: "unit:kilogram", magnitude }).valid).toBe(true);
    }
  });
});
