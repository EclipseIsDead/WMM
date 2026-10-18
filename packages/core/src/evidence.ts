import type {
  EvidenceStatusV1,
  FamilySupportV1,
  RecordId,
} from "@wmm/wire-contracts";

export interface EvidenceContribution {
  readonly supportId: RecordId;
  readonly stance: "supports" | "challenges";
}

export interface FamilyContribution {
  readonly contributorId: RecordId;
  readonly polarity: "positive" | "negative";
}

function collectUniqueIds<T>(
  contributions: readonly T[],
  idOf: (contribution: T) => RecordId,
  classify: (contribution: T) => "positive" | "negative",
): { readonly positive: RecordId[]; readonly negative: RecordId[] } {
  const seen = new Set<RecordId>();
  const positive: RecordId[] = [];
  const negative: RecordId[] = [];

  for (const contribution of contributions) {
    const id = idOf(contribution);
    if (seen.has(id)) throw new TypeError(`Duplicate contribution ID: ${id}`);
    seen.add(id);
    (classify(contribution) === "positive" ? positive : negative).push(id);
  }

  positive.sort();
  negative.sort();
  return { positive, negative };
}

export function aggregateEvidenceStatus(
  contributions: readonly EvidenceContribution[],
): EvidenceStatusV1 {
  const ids = collectUniqueIds(
    contributions,
    (contribution) => contribution.supportId,
    (contribution) => (contribution.stance === "supports" ? "positive" : "negative"),
  );

  const status =
    ids.positive.length > 0 && ids.negative.length > 0
      ? "supported-and-challenged"
      : ids.positive.length > 0
        ? "supported"
        : ids.negative.length > 0
          ? "challenged"
          : "unsupported";

  return {
    format: "wmm.evidence-status/1",
    status,
    supportingIds: ids.positive,
    challengingIds: ids.negative,
  };
}

export function aggregateFamilySupport(
  contributions: readonly FamilyContribution[],
): FamilySupportV1 {
  const ids = collectUniqueIds(
    contributions,
    (contribution) => contribution.contributorId,
    (contribution) => contribution.polarity,
  );

  const status =
    ids.positive.length > 0 && ids.negative.length > 0
      ? "both"
      : ids.positive.length > 0
        ? "positive-only"
        : ids.negative.length > 0
          ? "negative-only"
          : "neither";

  return {
    format: "wmm.family-support/1",
    status,
    positiveIds: ids.positive,
    negativeIds: ids.negative,
  };
}
