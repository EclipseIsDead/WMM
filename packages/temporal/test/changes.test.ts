import { describe, expect, it } from "vitest";

import type {
  ApplicabilityV1,
  EndEndpointV1,
  InstantPositionV1,
  IntervalTemporalQueryV1,
  StartEndpointV1,
} from "@wmm/wire-contracts";
import {
  TemporalInputError,
  evaluateApplicability,
  exactApplicabilityChanges,
} from "../src/index.js";

const AXIS = "1".repeat(64);
const OTHER_AXIS = "2".repeat(64);
const invariant: ApplicabilityV1 = { kind: "invariant" };
const exact = (position: string) => ({ kind: "exact", position }) as const;
const bounded = (lowerInclusive: string, upperExclusive: string) =>
  ({ kind: "boundedUnknown", lowerInclusive, upperExclusive }) as const;
const unknown = { kind: "unknown" } as const;
const past = { kind: "unboundedPast" } as const;
const future = { kind: "unboundedFuture" } as const;

function point(position: InstantPositionV1, axis = AXIS): ApplicabilityV1 {
  return { kind: "point", axisDefinitionDigest: axis, position };
}

function interval(
  start: StartEndpointV1,
  endExclusive: EndEndpointV1,
  axis = AXIS,
): ApplicabilityV1 {
  return { kind: "interval", axisDefinitionDigest: axis, start, endExclusive };
}

function query(
  start: string,
  endExclusive: string,
  mode: IntervalTemporalQueryV1["mode"] = "throughout",
): IntervalTemporalQueryV1 {
  return {
    format: "wmm.temporal-query/1",
    mode,
    axisDefinitionDigest: AXIS,
    start,
    endExclusive,
  };
}

const certified = (...changePositions: string[]) =>
  ({ status: "certified", changePositions }) as const;

const uncertain = {
  status: "unresolved",
  reason: "uncertain-change-position",
} as const;

interface ExactCase {
  readonly name: string;
  readonly applicability: ApplicabilityV1;
  readonly start?: string;
  readonly endExclusive?: string;
  readonly changes: readonly string[];
}

const exactCases: readonly ExactCase[] = [
  { name: "invariant", applicability: invariant, changes: [] },
  { name: "point and successor", applicability: point(exact("2")), changes: ["2", "3"] },
  { name: "point at a", applicability: point(exact("0")), changes: ["0", "1"] },
  { name: "point successor at b", applicability: point(exact("4")), changes: ["4", "5"] },
  { name: "point before a", applicability: point(exact("-1")), changes: [] },
  { name: "point at b is disjoint", applicability: point(exact("5")), changes: [] },
  {
    name: "single chronon query keeps both boundaries",
    applicability: point(exact("4")), start: "4", changes: ["4", "5"],
  },
  {
    name: "negative point and successor",
    applicability: point(exact("-2")), start: "-5", changes: ["-2", "-1"],
  },
  {
    name: "successor crosses zero",
    applicability: point(exact("-1")), start: "-1", changes: ["-1", "0"],
  },
  {
    name: "huge point successor is exact",
    applicability: point(exact("90071992547409931234567890")),
    start: "90071992547409931234567889",
    endExclusive: "90071992547409931234567891",
    changes: ["90071992547409931234567890", "90071992547409931234567891"],
  },
  {
    name: "huge negative point successor is exact",
    applicability: point(exact("-90071992547409931234567890")),
    start: "-90071992547409931234567891",
    endExclusive: "-90071992547409931234567889",
    changes: ["-90071992547409931234567890", "-90071992547409931234567889"],
  },
  { name: "interval endpoints", applicability: interval(exact("1"), exact("4")), changes: ["1", "4"] },
  { name: "interval endpoints at a and b", applicability: interval(exact("0"), exact("5")), changes: ["0", "5"] },
  { name: "start before a is clipped", applicability: interval(exact("-2"), exact("3")), changes: ["3"] },
  { name: "end after b is clipped", applicability: interval(exact("2"), exact("7")), changes: ["2"] },
  { name: "enclosing interval has no in-range boundaries", applicability: interval(exact("-2"), exact("7")), changes: [] },
  { name: "interval ending at a is disjoint", applicability: interval(exact("-2"), exact("0")), changes: [] },
  { name: "interval starting at b is disjoint", applicability: interval(exact("5"), exact("7")), changes: [] },
  { name: "unbounded past", applicability: interval(past, exact("3")), changes: ["3"] },
  { name: "unbounded future", applicability: interval(exact("2"), future), changes: ["2"] },
  { name: "unbounded past ending at b", applicability: interval(past, exact("5")), changes: ["5"] },
  { name: "unbounded future starting at a", applicability: interval(exact("0"), future), changes: ["0"] },
  { name: "fully unbounded", applicability: interval(past, future), changes: [] },
  { name: "unbounded past ending at a is disjoint", applicability: interval(past, exact("0")), changes: [] },
  { name: "unbounded future starting at b is disjoint", applicability: interval(exact("5"), future), changes: [] },
  {
    name: "positive boundaries sort numerically",
    applicability: interval(exact("2"), exact("10")),
    endExclusive: "20", changes: ["2", "10"],
  },
  {
    name: "negative boundaries sort numerically",
    applicability: interval(exact("-10"), exact("-2")),
    start: "-20", changes: ["-10", "-2"],
  },
  {
    name: "huge interval endpoints retain precision",
    applicability: interval(exact("-90071992547409931234567890"), exact("90071992547409931234567890")),
    start: "-90071992547409931234567891",
    endExclusive: "90071992547409931234567891",
    changes: ["-90071992547409931234567890", "90071992547409931234567890"],
  },
];

const relevantUncertainCases = [
  { name: "unknown point", applicability: point(unknown) },
  { name: "bounded point", applicability: point(bounded("1", "3")) },
  { name: "singleton bounded point", applicability: point(bounded("2", "3")) },
  { name: "point bounds spanning the query", applicability: point(bounded("-5", "10")) },
  { name: "unknown start", applicability: interval(unknown, exact("3")) },
  { name: "unknown end", applicability: interval(exact("2"), unknown) },
  { name: "both endpoints unknown", applicability: interval(unknown, unknown) },
  { name: "bounded start", applicability: interval(bounded("1", "3"), exact("4")) },
  { name: "bounded end", applicability: interval(exact("1"), bounded("3", "5")) },
  { name: "singleton bounded start", applicability: interval(bounded("1", "2"), exact("4")) },
  { name: "singleton bounded end", applicability: interval(exact("1"), bounded("4", "5")) },
  { name: "bounded start wholly before query", applicability: interval(bounded("-5", "-1"), future) },
  { name: "bounded end wholly after query", applicability: interval(past, bounded("6", "10")) },
  { name: "uncertain endpoints enclosing query", applicability: interval(bounded("-5", "-1"), bounded("6", "10")) },
];

const disjointUncertainCases = [
  { name: "bounded point before query", applicability: point(bounded("-4", "0")) },
  { name: "bounded point after query", applicability: point(bounded("5", "8")) },
  { name: "unknown start but end at a", applicability: interval(unknown, exact("0")) },
  { name: "unknown end but start at b", applicability: interval(exact("5"), unknown) },
  { name: "bounded start at or after b", applicability: interval(bounded("5", "7"), future) },
  { name: "bounded end at or before a", applicability: interval(past, bounded("-4", "1")) },
  { name: "both endpoints bounded before query", applicability: interval(bounded("-5", "-3"), bounded("-2", "1")) },
  { name: "bounded start after query and unknown end", applicability: interval(bounded("5", "8"), unknown) },
];

const invalidCases = [
  { name: "empty query", applicability: invariant, query: query("0", "0"), code: "EMPTY_QUERY_INTERVAL" },
  { name: "reversed query", applicability: invariant, query: query("10", "2"), code: "EMPTY_QUERY_INTERVAL" },
  { name: "noncanonical query start", applicability: invariant, query: query("01", "5"), code: "INVALID_INTEGER" },
  { name: "negative zero query start", applicability: invariant, query: query("-0", "5"), code: "INVALID_INTEGER" },
  { name: "fractional query end", applicability: invariant, query: query("0", "5.5"), code: "INVALID_INTEGER" },
  { name: "nonfinite query end", applicability: invariant, query: query("0", "Infinity"), code: "INVALID_INTEGER" },
  { name: "invalid point", applicability: point(exact("01")), query: query("0", "5"), code: "INVALID_INTEGER" },
  { name: "empty point bounds", applicability: point(bounded("2", "2")), query: query("0", "5"), code: "EMPTY_BOUNDED_UNKNOWN" },
  { name: "reversed point bounds", applicability: point(bounded("3", "2")), query: query("0", "5"), code: "EMPTY_BOUNDED_UNKNOWN" },
  { name: "invalid disjoint point bounds", applicability: point(bounded("6", "08")), query: query("0", "5"), code: "INVALID_INTEGER" },
  { name: "empty interval", applicability: interval(exact("2"), exact("2")), query: query("0", "5"), code: "EMPTY_ADMISSIBLE_EXTENT" },
  { name: "reversed interval", applicability: interval(exact("3"), exact("2")), query: query("0", "5"), code: "EMPTY_ADMISSIBLE_EXTENT" },
  { name: "infeasible uncertain interval", applicability: interval(bounded("5", "7"), exact("5")), query: query("0", "5"), code: "EMPTY_ADMISSIBLE_EXTENT" },
  { name: "invalid unknown interval end", applicability: interval(unknown, exact("-0")), query: query("0", "5"), code: "INVALID_INTEGER" },
  { name: "empty start bounds", applicability: interval(bounded("2", "2"), future), query: query("0", "5"), code: "EMPTY_BOUNDED_UNKNOWN" },
  { name: "invalid end bounds", applicability: interval(past, bounded("0", "x")), query: query("0", "5"), code: "INVALID_INTEGER" },
  { name: "invalid point on unmapped axis", applicability: point(exact("01"), OTHER_AXIS), query: query("0", "5"), code: "INVALID_INTEGER" },
  { name: "invalid interval on unmapped axis", applicability: interval(exact("3"), exact("2"), OTHER_AXIS), query: query("0", "5"), code: "EMPTY_ADMISSIBLE_EXTENT" },
];

describe("exactApplicabilityChanges", () => {
  for (const mode of ["throughout", "intersects"] as const) {
    describe(mode, () => {
      it.each(exactCases)("certifies $name", (testCase) => {
        expect(exactApplicabilityChanges(
          testCase.applicability,
          query(testCase.start ?? "0", testCase.endExclusive ?? "5", mode),
        )).toEqual(certified(...testCase.changes));
      });

      it.each(relevantUncertainCases)("leaves $name unresolved", ({ applicability }) => {
        expect(exactApplicabilityChanges(applicability, query("0", "5", mode)))
          .toEqual(uncertain);
      });

      it.each(disjointUncertainCases)("certifies no changes for $name", ({ applicability }) => {
        expect(exactApplicabilityChanges(applicability, query("0", "5", mode)))
          .toEqual(certified());
      });

      it.each([
        point(exact("2"), OTHER_AXIS),
        point(bounded("6", "8"), OTHER_AXIS),
        point(unknown, OTHER_AXIS),
        interval(exact("1"), exact("4"), OTHER_AXIS),
        interval(exact("5"), unknown, OTHER_AXIS),
        interval(past, future, OTHER_AXIS),
      ])("does not infer changes on an unmapped axis: %j", (applicability) => {
        expect(exactApplicabilityChanges(applicability, query("0", "5", mode)))
          .toEqual({ status: "unresolved", reason: "unmapped-axis" });
      });
    });
  }

  it.each(invalidCases)("rejects $name", (testCase) => {
    try {
      exactApplicabilityChanges(testCase.applicability, testCase.query);
      expect.fail("Expected TemporalInputError");
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalInputError);
      expect((error as TemporalInputError).code).toBe(testCase.code);
    }
  });

  it("keeps representative truth constant on every small certified partition", () => {
    const applicabilities: ApplicabilityV1[] = [invariant, interval(past, future)];
    for (let start = -4; start <= 4; start += 1) {
      applicabilities.push(
        point(exact(start.toString())),
        interval(past, exact(start.toString())),
        interval(exact(start.toString()), future),
      );
      for (let end = start + 1; end <= 4; end += 1) {
        applicabilities.push(interval(exact(start.toString()), exact(end.toString())));
      }
    }

    for (const mode of ["throughout", "intersects"] as const) {
      for (let a = -3; a < 3; a += 1) {
        for (let b = a + 1; b <= 3; b += 1) {
          const extent = query(a.toString(), b.toString(), mode);
          for (const applicability of applicabilities) {
            const changes = exactApplicabilityChanges(applicability, extent);
            if (changes.status !== "certified") expect.fail("Expected exact changes");
            const cuts = [...new Set([a, b, ...changes.changePositions.map(Number)])]
              .sort((left, right) => left - right);
            for (const [index, lower] of cuts.entries()) {
              const upper = cuts[index + 1];
              if (upper === undefined) continue;
              const at = (position: number) => evaluateApplicability(applicability, {
                format: "wmm.temporal-query/1",
                mode: "at",
                axisDefinitionDigest: AXIS,
                position: position.toString(),
              });
              const representative = at(lower);
              for (let position = lower; position < upper; position += 1) {
                expect(at(position)).toEqual(representative);
              }
            }
          }
        }
      }
    }
  });
});
