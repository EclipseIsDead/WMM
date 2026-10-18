import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  EvidenceStatusV1,
  FamilySupportV1,
  ScopeComparisonV1,
  ScopeV1,
} from "@wmm/wire-contracts";
import {
  aggregateEvidenceStatus,
  aggregateFamilySupport,
  compareScope,
  type EvidenceContribution,
  type FamilyContribution,
} from "../src/index.js";

interface ScopeCase {
  readonly name: string;
  readonly left: ScopeV1;
  readonly right: ScopeV1;
  readonly expected: ScopeComparisonV1;
}

interface EvidenceCase {
  readonly name: string;
  readonly contributions: readonly EvidenceContribution[];
  readonly expected: EvidenceStatusV1;
}

interface FamilyCase {
  readonly name: string;
  readonly contributions: readonly FamilyContribution[];
  readonly expected: FamilySupportV1;
}

interface SemanticCases {
  readonly scopeCases: readonly ScopeCase[];
  readonly evidenceCases: readonly EvidenceCase[];
  readonly familyCases: readonly FamilyCase[];
}

const cases = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v0/semantic-contract-cases.json", import.meta.url),
    "utf8",
  ),
) as SemanticCases;

describe("scope comparison", () => {
  for (const testCase of cases.scopeCases) {
    it(testCase.name, () => {
      expect(compareScope(testCase.left, testCase.right)).toEqual(testCase.expected);
    });
  }
});

describe("evidence aggregation", () => {
  for (const testCase of cases.evidenceCases) {
    it(testCase.name, () => {
      expect(aggregateEvidenceStatus(testCase.contributions)).toEqual(testCase.expected);
    });
  }

  it("rejects duplicate support IDs instead of double-counting", () => {
    expect(() =>
      aggregateEvidenceStatus([
        { supportId: "support:one", stance: "supports" },
        { supportId: "support:one", stance: "challenges" },
      ]),
    ).toThrow(/Duplicate contribution ID/);
  });
});

describe("proposition-family support", () => {
  for (const testCase of cases.familyCases) {
    it(testCase.name, () => {
      expect(aggregateFamilySupport(testCase.contributions)).toEqual(testCase.expected);
    });
  }

  it("rejects duplicate contributor IDs", () => {
    expect(() =>
      aggregateFamilySupport([
        { contributorId: "asrt:one", polarity: "positive" },
        { contributorId: "asrt:one", polarity: "positive" },
      ]),
    ).toThrow(/Duplicate contribution ID/);
  });
});
