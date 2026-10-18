import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ApplicabilityV1,
  TemporalComparisonV1,
  TemporalQueryV1,
} from "@wmm/wire-contracts";
import {
  TemporalInputError,
  evaluateApplicability,
  mayHoldAt,
} from "../src/index.js";

interface TemporalCase {
  readonly name: string;
  readonly applicability: ApplicabilityV1;
  readonly query: TemporalQueryV1;
  readonly expected: TemporalComparisonV1;
}

interface TemporalInvalidCase {
  readonly name: string;
  readonly applicability: ApplicabilityV1;
  readonly query: TemporalQueryV1;
  readonly errorCode: string;
}

interface SemanticCases {
  readonly temporalCases: readonly TemporalCase[];
  readonly temporalInvalidCases: readonly TemporalInvalidCase[];
}

const cases = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/v0/semantic-contract-cases.json", import.meta.url),
    "utf8",
  ),
) as SemanticCases;

describe("temporal applicability", () => {
  for (const testCase of cases.temporalCases) {
    it(testCase.name, () => {
      expect(evaluateApplicability(testCase.applicability, testCase.query)).toEqual(
        testCase.expected,
      );
    });
  }

  for (const testCase of cases.temporalInvalidCases) {
    it(`rejects ${testCase.name}`, () => {
      try {
        evaluateApplicability(testCase.applicability, testCase.query);
        expect.fail("Expected TemporalInputError");
      } catch (error) {
        expect(error).toBeInstanceOf(TemporalInputError);
        expect((error as TemporalInputError).code).toBe(testCase.errorCode);
      }
    });
  }

  it("excludes point-throughout before attempting axis comparison", () => {
    expect(
      evaluateApplicability(
        {
          kind: "point",
          axisDefinitionDigest:
            "2222222222222222222222222222222222222222222222222222222222222222",
          position: { kind: "exact", position: "12" },
        },
        {
          format: "wmm.temporal-query/1",
          mode: "throughout",
          axisDefinitionDigest:
            "1111111111111111111111111111111111111111111111111111111111111111",
          start: "10",
          endExclusive: "20",
        },
      ),
    ).toEqual({
      format: "wmm.temporal-comparison/1",
      kind: "excluded",
      reason: "applicabilityType",
    });
  });

  it("projects comparable truth without flattening incomparability", () => {
    expect(
      mayHoldAt({
        format: "wmm.temporal-comparison/1",
        kind: "comparable",
        truth: "always",
      }),
    ).toBe("yes");
    expect(
      mayHoldAt({
        format: "wmm.temporal-comparison/1",
        kind: "comparable",
        truth: "sometimes",
      }),
    ).toBe("yes");
    expect(
      mayHoldAt({
        format: "wmm.temporal-comparison/1",
        kind: "comparable",
        truth: "never",
      }),
    ).toBe("no");
    expect(
      mayHoldAt({
        format: "wmm.temporal-comparison/1",
        kind: "incomparable",
        reason: "unmappedAxis",
      }),
    ).toBe("unresolved");
  });
});
