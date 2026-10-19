import { propositionFamilyDigest } from "@wmm/canonical";
import {
  assertValidTemporalQuery,
  evaluateApplicability,
  TemporalInputError,
} from "@wmm/temporal";
import type {
  AssertionId,
  AssertionRecordV1,
  ClaimQueryItemV1,
  ClaimQueryResultV1,
  ScopeV1,
  SupportId,
  SupportRecordV1,
  TemporalComparisonV1,
  TemporalQueryV1,
} from "@wmm/wire-contracts";

import { aggregateEvidenceStatus, aggregateFamilySupport } from "./evidence.js";
import { compareScope } from "./scope.js";

export interface ClaimQuerySnapshotV1 {
  readonly activeAssertionIds: readonly AssertionId[];
  readonly activeSupportIds: readonly SupportId[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly supports: readonly SupportRecordV1[];
}

type QueryGroup = "definite" | "possible" | "unresolved" | "excluded";

export class ClaimQueryInputError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaimQueryInputError";
    this.code = code;
  }
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordsById<T extends { readonly id: string }>(
  records: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    if (result.has(record.id)) throw new TypeError(`Duplicate ${label} ID: ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

function selectActive<T extends { readonly id: string }>(
  activeIds: readonly string[],
  records: ReadonlyMap<string, T>,
  label: string,
): T[] {
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const id of activeIds) {
    if (seen.has(id)) throw new TypeError(`Duplicate active ${label} ID: ${id}`);
    seen.add(id);
    const record = records.get(id);
    if (record === undefined) throw new TypeError(`Active ${label} is unavailable: ${id}`);
    selected.push(record);
  }
  return selected.sort((left, right) => asciiCompare(left.id, right.id));
}

function classify(
  scopeResult: ClaimQueryItemV1["scope"]["result"],
  temporal: TemporalComparisonV1,
): QueryGroup {
  if (
    scopeResult === "different" ||
    temporal.kind === "excluded" ||
    (temporal.kind === "comparable" && temporal.truth === "never")
  ) {
    return "excluded";
  }
  if (scopeResult === "unresolved" || temporal.kind === "incomparable") {
    return "unresolved";
  }
  return temporal.truth === "sometimes" ? "possible" : "definite";
}

export function queryActiveClaims(
  snapshot: ClaimQuerySnapshotV1,
  scope: ScopeV1,
  temporal: TemporalQueryV1,
): ClaimQueryResultV1 {
  try {
    assertValidTemporalQuery(temporal);
  } catch (error) {
    if (error instanceof TemporalInputError) {
      throw new ClaimQueryInputError(error.code, error.message);
    }
    throw error;
  }

  const assertionsById = recordsById(snapshot.assertions, "assertion");
  const supportsById = recordsById(snapshot.supports, "support");
  const activeAssertions = selectActive(
    snapshot.activeAssertionIds,
    assertionsById,
    "assertion",
  );
  const activeSupports = selectActive(snapshot.activeSupportIds, supportsById, "support");

  const supportsByClaim = new Map<AssertionId, SupportRecordV1[]>();
  for (const support of activeSupports) {
    const existing = supportsByClaim.get(support.body.claimId) ?? [];
    existing.push(support);
    supportsByClaim.set(support.body.claimId, existing);
  }

  const assertionsByFamily = new Map<string, AssertionRecordV1[]>();
  for (const assertion of activeAssertions) {
    const familyDigest = propositionFamilyDigest(assertion.body);
    const existing = assertionsByFamily.get(familyDigest) ?? [];
    existing.push(assertion);
    assertionsByFamily.set(familyDigest, existing);
  }

  const groups: Record<QueryGroup, ClaimQueryItemV1[]> = {
    definite: [],
    possible: [],
    unresolved: [],
    excluded: [],
  };

  for (const assertion of activeAssertions) {
    const scopeComparison = compareScope(assertion.body.scope, scope);
    const temporalComparison = evaluateApplicability(assertion.body.applicability, temporal);
    const evidence = aggregateEvidenceStatus(
      (supportsByClaim.get(assertion.id) ?? []).map((support) => ({
        supportId: support.id,
        stance: support.body.stance,
      })),
    );
    const familySupport = aggregateFamilySupport(
      (assertionsByFamily.get(propositionFamilyDigest(assertion.body)) ?? []).map(
        (familyAssertion) => ({
          contributorId: familyAssertion.id,
          polarity: familyAssertion.body.polarity,
        }),
      ),
    );
    const item: ClaimQueryItemV1 = {
      assertionId: assertion.id,
      polarity: assertion.body.polarity,
      scope: scopeComparison,
      temporal: temporalComparison,
      evidence,
      familySupport,
    };
    groups[classify(scopeComparison.result, temporalComparison)].push(item);
  }

  return {
    format: "wmm.claim-query-result/1",
    scope,
    temporal,
    definite: groups.definite,
    possible: groups.possible,
    unresolved: groups.unresolved,
    excluded: groups.excluded,
    scopeCoverage: "exhaustive",
  };
}
