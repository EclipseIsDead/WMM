import type {
  ApplicabilityV1,
  BoundedUnknownPositionV1,
  EndEndpointV1,
  InstantPositionV1,
  StartEndpointV1,
  TemporalComparisonV1,
  TemporalQueryV1,
} from "@wmm/wire-contracts";

export type TemporalInputErrorCode =
  | "INVALID_INTEGER"
  | "EMPTY_BOUNDED_UNKNOWN"
  | "EMPTY_QUERY_INTERVAL"
  | "EMPTY_ADMISSIBLE_EXTENT";

export class TemporalInputError extends TypeError {
  readonly code: TemporalInputErrorCode;

  constructor(code: TemporalInputErrorCode, message: string) {
    super(message);
    this.name = "TemporalInputError";
    this.code = code;
  }
}

interface IntegerRange {
  readonly lower: bigint | null;
  readonly upper: bigint | null;
}

type StartDomain =
  | { readonly kind: "negativeInfinity" }
  | { readonly kind: "finite"; readonly range: IntegerRange };

type EndDomain =
  | { readonly kind: "positiveInfinity" }
  | { readonly kind: "finite"; readonly range: IntegerRange };

interface FeasibilityConstraints {
  readonly startLower?: bigint;
  readonly startUpper?: bigint;
  readonly endLower?: bigint;
  readonly endUpper?: bigint;
}

const INTEGER_PATTERN = /^(0|-?[1-9][0-9]*)$/;

function parsePosition(value: string): bigint {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TemporalInputError(
      "INVALID_INTEGER",
      `Position is not a canonical integer string: ${value}`,
    );
  }
  return BigInt(value);
}

function boundedRange(position: BoundedUnknownPositionV1): IntegerRange {
  const lower = parsePosition(position.lowerInclusive);
  const upperExclusive = parsePosition(position.upperExclusive);
  if (lower >= upperExclusive) {
    throw new TemporalInputError(
      "EMPTY_BOUNDED_UNKNOWN",
      "boundedUnknown requires lowerInclusive < upperExclusive",
    );
  }
  return { lower, upper: upperExclusive - 1n };
}

function instantRange(position: InstantPositionV1): IntegerRange {
  switch (position.kind) {
    case "exact": {
      const exact = parsePosition(position.position);
      return { lower: exact, upper: exact };
    }
    case "boundedUnknown":
      return boundedRange(position);
    case "unknown":
      return { lower: null, upper: null };
  }
}

function startDomain(endpoint: StartEndpointV1): StartDomain {
  return endpoint.kind === "unboundedPast"
    ? { kind: "negativeInfinity" }
    : { kind: "finite", range: instantRange(endpoint) };
}

function endDomain(endpoint: EndEndpointV1): EndDomain {
  return endpoint.kind === "unboundedFuture"
    ? { kind: "positiveInfinity" }
    : { kind: "finite", range: instantRange(endpoint) };
}

function maxLower(current: bigint | null, candidate: bigint | undefined): bigint | null {
  if (candidate === undefined) return current;
  if (current === null || candidate > current) return candidate;
  return current;
}

function minUpper(current: bigint | null, candidate: bigint | undefined): bigint | null {
  if (candidate === undefined) return current;
  if (current === null || candidate < current) return candidate;
  return current;
}

function restrictRange(
  range: IntegerRange,
  lower: bigint | undefined,
  upper: bigint | undefined,
): IntegerRange | null {
  const restricted = {
    lower: maxLower(range.lower, lower),
    upper: minUpper(range.upper, upper),
  };
  if (
    restricted.lower !== null &&
    restricted.upper !== null &&
    restricted.lower > restricted.upper
  ) {
    return null;
  }
  return restricted;
}

function feasible(
  start: StartDomain,
  end: EndDomain,
  constraints: FeasibilityConstraints = {},
): boolean {
  if (start.kind === "negativeInfinity" && constraints.startLower !== undefined) {
    return false;
  }
  if (end.kind === "positiveInfinity" && constraints.endUpper !== undefined) {
    return false;
  }

  const restrictedStart: StartDomain | null =
    start.kind === "negativeInfinity"
      ? start
      : (() => {
          const range = restrictRange(
            start.range,
            constraints.startLower,
            constraints.startUpper,
          );
          return range === null ? null : { kind: "finite", range };
        })();
  const restrictedEnd: EndDomain | null =
    end.kind === "positiveInfinity"
      ? end
      : (() => {
          const range = restrictRange(
            end.range,
            constraints.endLower,
            constraints.endUpper,
          );
          return range === null ? null : { kind: "finite", range };
        })();

  if (restrictedStart === null || restrictedEnd === null) return false;
  if (restrictedStart.kind === "negativeInfinity") return true;
  if (restrictedEnd.kind === "positiveInfinity") return true;

  const lowestStart = restrictedStart.range.lower;
  const highestEnd = restrictedEnd.range.upper;
  if (lowestStart === null || highestEnd === null) return true;
  return lowestStart < highestEnd;
}

function comparable(
  canBeTrue: boolean,
  canBeFalse: boolean,
): TemporalComparisonV1 {
  if (canBeTrue && !canBeFalse) {
    return { format: "wmm.temporal-comparison/1", kind: "comparable", truth: "always" };
  }
  if (!canBeTrue && canBeFalse) {
    return { format: "wmm.temporal-comparison/1", kind: "comparable", truth: "never" };
  }
  if (canBeTrue && canBeFalse) {
    return {
      format: "wmm.temporal-comparison/1",
      kind: "comparable",
      truth: "sometimes",
    };
  }
  throw new Error("Temporal feasibility invariant failed");
}

function ensureValidDuration(start: StartDomain, end: EndDomain): void {
  if (!feasible(start, end)) {
    throw new TemporalInputError(
      "EMPTY_ADMISSIBLE_EXTENT",
      "No endpoint assignment satisfies start < end",
    );
  }
}

function rangeContains(range: IntegerRange, value: bigint): boolean {
  return (
    (range.lower === null || range.lower <= value) &&
    (range.upper === null || value <= range.upper)
  );
}

function rangeIsSingleton(range: IntegerRange, value: bigint): boolean {
  return range.lower === value && range.upper === value;
}

function rangeIntersects(range: IntegerRange, lower: bigint, upper: bigint): boolean {
  return restrictRange(range, lower, upper) !== null;
}

function rangeIsSubsetOf(range: IntegerRange, lower: bigint, upper: bigint): boolean {
  return (
    range.lower !== null &&
    range.upper !== null &&
    lower <= range.lower &&
    range.upper <= upper
  );
}

function validateQuery(query: TemporalQueryV1):
  | { readonly mode: "at"; readonly position: bigint }
  | {
      readonly mode: "intersects" | "throughout";
      readonly start: bigint;
      readonly endExclusive: bigint;
    } {
  if (query.mode === "at") {
    return { mode: "at", position: parsePosition(query.position) };
  }

  const start = parsePosition(query.start);
  const endExclusive = parsePosition(query.endExclusive);
  if (start >= endExclusive) {
    throw new TemporalInputError(
      "EMPTY_QUERY_INTERVAL",
      "Temporal query interval requires start < endExclusive",
    );
  }
  return { mode: query.mode, start, endExclusive };
}

function evaluatePoint(
  applicability: Extract<ApplicabilityV1, { kind: "point" }>,
  query: TemporalQueryV1,
  parsedQuery: ReturnType<typeof validateQuery>,
): TemporalComparisonV1 {
  const range = instantRange(applicability.position);
  if (parsedQuery.mode === "throughout") {
    return {
      format: "wmm.temporal-comparison/1",
      kind: "excluded",
      reason: "applicabilityType",
    };
  }

  if (applicability.axisDefinitionDigest !== query.axisDefinitionDigest) {
    return {
      format: "wmm.temporal-comparison/1",
      kind: "incomparable",
      reason: "unmappedAxis",
    };
  }

  if (parsedQuery.mode === "at") {
    const canBeTrue = rangeContains(range, parsedQuery.position);
    const canBeFalse = !rangeIsSingleton(range, parsedQuery.position);
    return comparable(canBeTrue, canBeFalse);
  }

  const upperInclusive = parsedQuery.endExclusive - 1n;
  const canBeTrue = rangeIntersects(range, parsedQuery.start, upperInclusive);
  const canBeFalse = !rangeIsSubsetOf(range, parsedQuery.start, upperInclusive);
  return comparable(canBeTrue, canBeFalse);
}

function evaluateInterval(
  applicability: Extract<ApplicabilityV1, { kind: "interval" }>,
  query: TemporalQueryV1,
  parsedQuery: ReturnType<typeof validateQuery>,
): TemporalComparisonV1 {
  const start = startDomain(applicability.start);
  const end = endDomain(applicability.endExclusive);
  ensureValidDuration(start, end);

  if (applicability.axisDefinitionDigest !== query.axisDefinitionDigest) {
    return {
      format: "wmm.temporal-comparison/1",
      kind: "incomparable",
      reason: "unmappedAxis",
    };
  }

  if (parsedQuery.mode === "at") {
    const t = parsedQuery.position;
    return comparable(
      feasible(start, end, { startUpper: t, endLower: t + 1n }),
      feasible(start, end, { startLower: t + 1n }) ||
        feasible(start, end, { endUpper: t }),
    );
  }

  const a = parsedQuery.start;
  const b = parsedQuery.endExclusive;
  if (parsedQuery.mode === "intersects") {
    return comparable(
      feasible(start, end, { startUpper: b - 1n, endLower: a + 1n }),
      feasible(start, end, { startLower: b }) ||
        feasible(start, end, { endUpper: a }),
    );
  }

  return comparable(
    feasible(start, end, { startUpper: a, endLower: b }),
    feasible(start, end, { startLower: a + 1n }) ||
      feasible(start, end, { endUpper: b - 1n }),
  );
}

export function evaluateApplicability(
  applicability: ApplicabilityV1,
  query: TemporalQueryV1,
): TemporalComparisonV1 {
  const parsedQuery = validateQuery(query);

  if (applicability.kind === "invariant") {
    return { format: "wmm.temporal-comparison/1", kind: "comparable", truth: "always" };
  }
  if (applicability.kind === "point") {
    return evaluatePoint(applicability, query, parsedQuery);
  }
  return evaluateInterval(applicability, query, parsedQuery);
}

export function mayHoldAt(
  comparison: TemporalComparisonV1,
): "yes" | "no" | "unresolved" {
  if (comparison.kind !== "comparable") return "unresolved";
  return comparison.truth === "never" ? "no" : "yes";
}
