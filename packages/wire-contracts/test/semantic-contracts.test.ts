import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateSemanticContract } from "../src/index.js";

interface NamedNegativeCase {
  readonly name: string;
  readonly payload: unknown;
}

interface SemanticCases {
  readonly scopeCases: readonly { readonly expected: unknown }[];
  readonly evidenceCases: readonly { readonly expected: unknown }[];
  readonly familyCases: readonly { readonly expected: unknown }[];
  readonly temporalCases: readonly {
    readonly query: unknown;
    readonly expected: unknown;
  }[];
  readonly semanticSchemaPositiveCases: readonly unknown[];
  readonly semanticSchemaNegativeCases: readonly NamedNegativeCase[];
}

const cases = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v0/semantic-contract-cases.json", import.meta.url),
    "utf8",
  ),
) as SemanticCases;

const generatedPositiveCases = [
  ...cases.scopeCases.map((testCase) => testCase.expected),
  ...cases.evidenceCases.map((testCase) => testCase.expected),
  ...cases.familyCases.map((testCase) => testCase.expected),
  ...cases.temporalCases.flatMap((testCase) => [testCase.query, testCase.expected]),
];

describe("V0 semantic wire contracts", () => {
  it("accepts every supplied and generated positive case", () => {
    const positives = [...cases.semanticSchemaPositiveCases, ...generatedPositiveCases];
    expect(positives.length).toBeGreaterThan(40);
    for (const payload of positives) {
      const result = validateSemanticContract(payload);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });

  it("rejects every forbidden result-algebra combination", () => {
    for (const testCase of cases.semanticSchemaNegativeCases) {
      const result = validateSemanticContract(testCase.payload);
      expect(result.valid, testCase.name).toBe(false);
      expect(result.errors.length, testCase.name).toBeGreaterThan(0);
    }
  });
});
