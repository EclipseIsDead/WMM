import type {
  ApplicabilityV1,
  IntervalTemporalQueryV1,
} from "@wmm/wire-contracts";

import {
  assertValidApplicability,
  assertValidTemporalQuery,
  evaluateApplicability,
} from "./index.js";

/**
 * Certifies exact partition boundaries for the query extent [a, b).
 * Returned positions include boundaries at a and b, not just its interior.
 */
export function exactApplicabilityChanges(
  applicability: ApplicabilityV1,
  query: IntervalTemporalQueryV1,
):
  | { readonly status: "certified"; readonly changePositions: readonly string[] }
  | {
      readonly status: "unresolved";
      readonly reason: "uncertain-change-position" | "unmapped-axis";
    } {
  assertValidTemporalQuery(query);
  assertValidApplicability(applicability);

  if (applicability.kind === "invariant") {
    return { status: "certified", changePositions: [] };
  }
  if (applicability.axisDefinitionDigest !== query.axisDefinitionDigest) {
    return { status: "unresolved", reason: "unmapped-axis" };
  }

  // Only the extent matters; point applicability is excluded by throughout.
  const intersection = evaluateApplicability(applicability, {
    ...query,
    mode: "intersects",
  });
  if (intersection.kind === "comparable" && intersection.truth === "never") {
    return { status: "certified", changePositions: [] };
  }

  const positions: bigint[] = [];
  if (applicability.kind === "point") {
    if (applicability.position.kind !== "exact") {
      return { status: "unresolved", reason: "uncertain-change-position" };
    }
    const position = BigInt(applicability.position.position);
    positions.push(position, position + 1n);
  } else {
    if (
      (applicability.start.kind !== "exact" &&
        applicability.start.kind !== "unboundedPast") ||
      (applicability.endExclusive.kind !== "exact" &&
        applicability.endExclusive.kind !== "unboundedFuture")
    ) {
      return { status: "unresolved", reason: "uncertain-change-position" };
    }
    if (applicability.start.kind === "exact") {
      positions.push(BigInt(applicability.start.position));
    }
    if (applicability.endExclusive.kind === "exact") {
      positions.push(BigInt(applicability.endExclusive.position));
    }
  }

  const a = BigInt(query.start);
  const b = BigInt(query.endExclusive);
  const changePositions = [...new Set(positions.filter((x) => a <= x && x <= b))]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((position) => position.toString());
  return { status: "certified", changePositions };
}
