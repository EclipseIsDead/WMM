import { isDeepStrictEqual } from "node:util";

import {
  absenceEvaluationDigest,
  absenceInputSelectionDigest,
  coverageInputSelectionDigest,
  populationRosterDigest,
} from "@wmm/canonical";
import {
  assertValidTemporalQuery,
  evaluateApplicability,
  TemporalInputError,
} from "@wmm/temporal";
import type {
  AbsenceCandidateEvaluationV1,
  AbsenceCoverageCheckV1,
  DescriptorRecordV1,
  RosterV1,
  AbsenceEvaluationBodyV1,
  AbsenceEvaluationReceiptV1,
  AbsenceInputSelectionV1,
  AbsenceQueryResultV1,
  AssertionId,
  AssertionRecordV1,
  ExistsV1,
  PointTemporalQueryV1,
  ScopeV1,
  SemanticDefinitionV1,
  SemanticOperationV1,
  TemporalQueryV1,
} from "@wmm/wire-contracts";

import { validateSemanticContract } from "@wmm/wire-contracts";

import {
  populationCoverageBasis, resolvePopulationSelector, selectCoverageInputs,
  type PopulationSelectorBindingsV1,
} from "./population.js";
import {
  ClaimQueryInputError,
  classifyQueryComparison,
  type ClaimQueryGroupV1,
} from "./query.js";
import { compareScope } from "./scope.js";

/**
 * Precondition: the repository adapter has verified that snapshotDigest identifies
 * the supplied active assertions, admitted definitions, descriptor births and roster artifacts.
 */
export interface ValidatedAbsenceQuerySnapshotV1 {
  readonly worldId: string;
  readonly snapshotDigest: string;
  readonly activeAssertionIds: readonly AssertionId[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
  readonly descriptors: readonly DescriptorRecordV1[];
  readonly rosters: readonly { readonly digest: string; readonly body: RosterV1 }[];
}

interface ClassifiedAssertion {
  readonly assertion: AssertionRecordV1;
  readonly group: ClaimQueryGroupV1;
}

interface AbsenceSemanticBindings extends PopulationSelectorBindingsV1 {
  readonly eligibilityPredicateDigest: string;
  readonly criterionValue: ExistsV1["criterion"]["arguments"][string];
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(asciiCompare);
}

/** @internal Shared by point evaluation and certified interval partitioning. */
export function activeAssertions(snapshot: ValidatedAbsenceQuerySnapshotV1): AssertionRecordV1[] {
  const records = new Map<string, AssertionRecordV1>();
  for (const assertion of snapshot.assertions) {
    if (records.has(assertion.id)) throw new TypeError(`Duplicate assertion ID: ${assertion.id}`);
    records.set(assertion.id, assertion);
  }

  const active: AssertionRecordV1[] = [];
  const seen = new Set<string>();
  for (const id of snapshot.activeAssertionIds) {
    if (seen.has(id)) throw new TypeError(`Duplicate active assertion ID: ${id}`);
    seen.add(id);
    const assertion = records.get(id);
    if (assertion === undefined) throw new TypeError(`Active assertion is unavailable: ${id}`);
    active.push(assertion);
  }
  return active.sort((left, right) => asciiCompare(left.id, right.id));
}

function classifyAssertions(
  assertions: readonly AssertionRecordV1[],
  scope: ScopeV1,
  temporal: PointTemporalQueryV1,
): ClassifiedAssertion[] {
  return assertions.map((assertion) => {
    const scopeComparison = compareScope(assertion.body.scope, scope);
    const temporalComparison = evaluateApplicability(assertion.body.applicability, temporal);
    return {
      assertion,
      group: classifyQueryComparison(scopeComparison.result, temporalComparison),
    };
  });
}

function dependencyForOperation(
  definition: SemanticDefinitionV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
  operation: SemanticOperationV1,
): string | undefined {
  const matches = definition.dependencies.filter(
    (digest) => definitions[digest]?.operation === operation,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** @internal Resolve the same implementation-owned primitives for both evaluators. */
export function resolveBindings(
  target: ExistsV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
): AbsenceSemanticBindings | undefined {
  const selector = resolvePopulationSelector(target.population.definitionDigest, definitions);
  const criterion = definitions[target.criterion.definitionDigest];
  if (
    selector === undefined ||
    criterion?.kind !== "criterion" ||
    criterion.operation !== "bundled-eligibility-v1" ||
    criterion.dependencies.length !== 1 ||
    !isDeepStrictEqual(Object.keys(target.criterion.arguments).sort(), ["office"])
  ) {
    return undefined;
  }

  const eligibilityPredicateDigest = dependencyForOperation(
    criterion,
    definitions,
    "criterion-satisfaction-atom-v1",
  );
  const criterionValue = target.criterion.arguments["office"];
  if (
    eligibilityPredicateDigest === undefined ||
    criterionValue?.kind !== "ref"
  ) {
    return undefined;
  }

  return {
    ...selector,
    eligibilityPredicateDigest,
    criterionValue,
  };
}

function isNonExcluded(value: ClassifiedAssertion): boolean {
  return value.group !== "excluded";
}

function idsFor(
  values: readonly ClassifiedAssertion[],
  group: ClaimQueryGroupV1,
  polarity?: "positive" | "negative",
): AssertionId[] {
  return values
    .filter(
      (value) =>
        value.group === group &&
        (polarity === undefined || value.assertion.body.polarity === polarity),
    )
    .map((value) => value.assertion.id)
    .sort(asciiCompare);
}

function matchesTarget(assertion: AssertionRecordV1, target: ExistsV1): boolean {
  return (
    assertion.body.proposition.kind === "exists" &&
    isDeepStrictEqual(assertion.body.proposition, target)
  );
}

function matchingAtom(value: ClassifiedAssertion, predicateDigest: string): boolean {
  return (
    value.assertion.body.proposition.kind === "atom" &&
    value.assertion.body.proposition.predicateDefinitionDigest === predicateDigest
  );
}

function withEvaluationDigest(body: AbsenceEvaluationBodyV1): AbsenceEvaluationReceiptV1 {
  return { ...body, evaluationDigest: absenceEvaluationDigest(body) };
}

function receiptBase(
  inputSelection: AbsenceInputSelectionV1,
  positiveCoverageAssertionIds: readonly AssertionId[],
  negativeCoverageAssertionIds: readonly AssertionId[],
  eligibilityAssertionIds: readonly AssertionId[],
  candidates: readonly AbsenceCandidateEvaluationV1[],
  staleCoverageAssertionIds: readonly AssertionId[] = [],
  coverageChecks: readonly AbsenceCoverageCheckV1[] = [],
  selectedCoverageAssertionId: AssertionId | null = null,
  premiseAssertionIds: readonly AssertionId[] = [],
) {
  return {
    format: "wmm.absence-evaluation-receipt/1" as const,
    algorithm: "bundled-absence-point-v3" as const,
    inputSelection,
    inputSelectionDigest: absenceInputSelectionDigest(inputSelection),
    positiveCoverageAssertionIds,
    negativeCoverageAssertionIds,
    staleCoverageAssertionIds,
    coverageChecks,
    selectedCoverageAssertionId,
    premiseAssertionIds,
    eligibilityAssertionIds,
    candidates,
  };
}

function groupHas(
  values: readonly ClassifiedAssertion[],
  polarity: "positive" | "negative",
  group: ClaimQueryGroupV1,
): boolean {
  return values.some(
    (value) => value.assertion.body.polarity === polarity && value.group === group,
  );
}

export type AbsenceVerificationErrorV1 =
  | "INVALID_RECEIPT_SHAPE"
  | "INVALID_RESULT_SHAPE"
  | "ROSTER_DIGEST_MISMATCH"
  | "INPUT_SELECTION_DIGEST_MISMATCH"
  | "COVERAGE_CHECK_MISMATCH"
  | "NONCANONICAL_SET"
  | "PREMISE_SELECTION_MISMATCH"
  | "EVALUATION_DIGEST_MISMATCH"
  | "SNAPSHOT_MISMATCH"
  | "EVALUATION_MISMATCH"
  | "RESULT_MISMATCH";

export interface AbsenceVerificationV1 {
  readonly valid: boolean;
  readonly verification: "integrity-only" | "snapshot-replay";
  readonly errors: readonly AbsenceVerificationErrorV1[];
}

function coverageCheckStatus(check: Omit<AbsenceCoverageCheckV1, "status">): AbsenceCoverageCheckV1["status"] {
  if (check.basis.selectorDefinitionDigest !== check.inputSelection.selectorDefinitionDigest) return "selector-mismatch";
  if (check.basis.inputSelectionDigest !== check.inputSelectionDigest) return "input-stale";
  if (check.roster === null) return "roster-missing";
  if (
    populationRosterDigest(check.roster) !== check.basis.rosterDigest ||
    check.roster.worldId !== check.inputSelection.worldId ||
    check.roster.populationDefinitionDigest !== check.basis.populationDefinitionDigest
  ) return "roster-mismatch";
  return "matched";
}

/** Unkeyed hash consistency only; this does not authenticate or prove a conclusion. */
export function verifyAbsenceReceiptIntegrity(input: unknown): AbsenceVerificationV1 {
  if (
    !validateSemanticContract(input).valid ||
    (input as { readonly format?: unknown }).format !== "wmm.absence-evaluation-receipt/1"
  ) {
    return { valid: false, verification: "integrity-only", errors: ["INVALID_RECEIPT_SHAPE"] };
  }
  const receipt = input as AbsenceEvaluationReceiptV1;
  const errors: AbsenceVerificationErrorV1[] = [];
  const sets = [
    receipt.inputSelection.membershipAssertionIds, receipt.positiveCoverageAssertionIds,
    receipt.negativeCoverageAssertionIds, receipt.staleCoverageAssertionIds,
    receipt.eligibilityAssertionIds, receipt.premiseAssertionIds,
    receipt.coverageChecks.map((check) => check.assertionId),
    receipt.candidates.map((candidate) => candidate.candidateId),
    ...receipt.candidates.flatMap((candidate) => [candidate.membershipAssertionIds, candidate.eligibilityAssertionIds]),
    ...receipt.coverageChecks.flatMap((check) => [check.inputSelection.primitiveClaimIds,
      check.inputSelection.candidateBirthDigests, check.roster?.memberIds ?? []]),
  ];
  if (sets.some((values) => !isDeepStrictEqual(values, sortedUnique(values)))) errors.push("NONCANONICAL_SET");
  const premises = new Set(receipt.premiseAssertionIds);
  const referenced = [
    ...receipt.inputSelection.membershipAssertionIds, ...receipt.positiveCoverageAssertionIds,
    ...receipt.negativeCoverageAssertionIds, ...receipt.staleCoverageAssertionIds,
    ...receipt.eligibilityAssertionIds, ...receipt.coverageChecks.map((check) => check.assertionId),
    ...receipt.candidates.flatMap((candidate) => [...candidate.membershipAssertionIds, ...candidate.eligibilityAssertionIds]),
  ];
  if (referenced.some((id) => !premises.has(id))) errors.push("PREMISE_SELECTION_MISMATCH");
  const selected = receipt.coverageChecks.find((check) => check.assertionId === receipt.selectedCoverageAssertionId);
  if ((receipt.selectedCoverageAssertionId !== null && selected === undefined) ||
    (receipt.status === "established" && (selected?.status !== "matched" ||
      !receipt.positiveCoverageAssertionIds.includes(receipt.selectedCoverageAssertionId ?? "")))) {
    errors.push("COVERAGE_CHECK_MISMATCH");
  }
  for (const check of receipt.coverageChecks) {
    if (check.inputSelection.worldId !== receipt.inputSelection.worldId ||
      check.inputSelection.populationDefinitionDigest !== receipt.inputSelection.target.population.definitionDigest ||
      check.basis.populationDefinitionDigest !== check.inputSelection.populationDefinitionDigest) {
      errors.push("COVERAGE_CHECK_MISMATCH");
    }
    if (check.roster !== null && populationRosterDigest(check.roster) !== check.basis.rosterDigest) {
      errors.push("ROSTER_DIGEST_MISMATCH");
    }
    if (check.inputSelectionDigest !== coverageInputSelectionDigest(check.inputSelection)) {
      errors.push("INPUT_SELECTION_DIGEST_MISMATCH");
    }
    if (check.status !== coverageCheckStatus(check)) errors.push("COVERAGE_CHECK_MISMATCH");
  }
  if (receipt.inputSelectionDigest !== absenceInputSelectionDigest(receipt.inputSelection)) {
    errors.push("INPUT_SELECTION_DIGEST_MISMATCH");
  }
  const { evaluationDigest, ...body } = receipt;
  if (evaluationDigest !== absenceEvaluationDigest(body)) {
    errors.push("EVALUATION_DIGEST_MISMATCH");
  }
  return { valid: errors.length === 0, verification: "integrity-only", errors: [...new Set(errors)] };
}

/** Replay against adapter-verified content; no imported receipt supplies its own authority. */
export function verifyAbsenceEvaluationReceipt(
  input: unknown,
  snapshot: ValidatedAbsenceQuerySnapshotV1,
): AbsenceVerificationV1 {
  const integrity = verifyAbsenceReceiptIntegrity(input);
  if (!integrity.valid) return { ...integrity, verification: "snapshot-replay" };
  const receipt = input as AbsenceEvaluationReceiptV1;
  const selection = receipt.inputSelection;
  if (selection.worldId !== snapshot.worldId || selection.snapshotDigest !== snapshot.snapshotDigest) {
    return { valid: false, verification: "snapshot-replay", errors: ["SNAPSHOT_MISMATCH"] };
  }
  const expected = queryAbsence(snapshot, selection.target, selection.scope, selection.temporal);
  const errors: AbsenceVerificationErrorV1[] = isDeepStrictEqual(receipt, expected.derivation)
    ? [] : ["EVALUATION_MISMATCH"];
  return { valid: errors.length === 0, verification: "snapshot-replay", errors };
}

export function verifyAbsenceQueryResult(
  input: unknown,
  snapshot: ValidatedAbsenceQuerySnapshotV1,
): AbsenceVerificationV1 {
  if (
    !validateSemanticContract(input).valid ||
    (input as { readonly format?: unknown }).format !== "wmm.absence-query-result/1"
  ) {
    return { valid: false, verification: "snapshot-replay", errors: ["INVALID_RESULT_SHAPE"] };
  }
  const result = input as AbsenceQueryResultV1;
  const receipt = verifyAbsenceEvaluationReceipt(result.derivation, snapshot);
  if (!receipt.valid) return receipt;
  const expected = queryAbsence(snapshot, result.target, result.scope, result.temporal);
  const errors: AbsenceVerificationErrorV1[] = isDeepStrictEqual(result, expected)
    ? [] : ["RESULT_MISMATCH"];
  return { valid: errors.length === 0, verification: "snapshot-replay", errors };
}

export function queryAbsence(
  snapshot: ValidatedAbsenceQuerySnapshotV1,
  target: ExistsV1,
  scope: ScopeV1,
  temporal: TemporalQueryV1,
): AbsenceQueryResultV1 {
  try {
    assertValidTemporalQuery(temporal);
    if (temporal.mode !== "at") {
      throw new ClaimQueryInputError(
        "UNSUPPORTED_RELATION",
        "The bounded absence profile accepts exact point queries only",
      );
    }
  } catch (error) {
    if (error instanceof TemporalInputError) {
      throw new ClaimQueryInputError(error.code, error.message);
    }
    throw error;
  }

  const active = activeAssertions(snapshot);
  const classified = classifyAssertions(active, scope, temporal);
  const matchingExists = classified.filter((value) =>
    matchesTarget(value.assertion, target),
  );
  const negativeExists = matchingExists.filter(
    (value) => value.assertion.body.polarity === "negative",
  );
  const positiveExists = matchingExists.filter(
    (value) => value.assertion.body.polarity === "positive",
  );

  const declarationDefinite = idsFor(negativeExists, "definite");
  const declarationPossible = idsFor(negativeExists, "possible");
  const declarationUnresolved = idsFor(negativeExists, "unresolved");
  const declarationStatus =
    declarationDefinite.length > 0
      ? "recorded"
      : declarationPossible.length > 0
        ? "possible"
        : declarationUnresolved.length > 0
          ? "unresolved"
          : "not-recorded";

  const existentialWitnessIds = idsFor(positiveExists, "definite");
  const possibleExistentialWitnessIds = idsFor(positiveExists, "possible");
  const unresolvedExistentialWitnessIds = idsFor(positiveExists, "unresolved");

  const bindings = resolveBindings(target, snapshot.definitionsByDigest);

  let inputSelection: AbsenceInputSelectionV1 = {
    format: "wmm.absence-input-selection/1",
    worldId: snapshot.worldId,
    snapshotDigest: snapshot.snapshotDigest,
    target,
    scope,
    temporal,

    membershipAssertionIds: [],
  };

  let derivation: AbsenceEvaluationReceiptV1;
  let candidateIds: string[] = [];
  let possibleCandidateIds: string[] = [];
  let unresolvedCandidateIds: string[] = [];

  if (bindings === undefined) {
    derivation = withEvaluationDigest({
      ...receiptBase(inputSelection, [], [], [], [], [], [], null,
        matchingExists.filter(isNonExcluded).map((value) => value.assertion.id)),
      status: "unsupported",
      reason: "unsupported-semantics",
    });
  } else {
    const coverageCandidates = classified.filter((value) => {
      const proposition = value.assertion.body.proposition;
      if (
        !isNonExcluded(value) ||
        !matchingAtom(value, bindings.coveragePredicateDigest) ||
        proposition.kind !== "atom" ||
        proposition.subjectId !== target.population.descriptorId
      ) return false;
      const basis = populationCoverageBasis(proposition.value, snapshot.definitionsByDigest);
      return basis?.populationDefinitionDigest === target.population.definitionDigest;
    });
    const coverageChecks: AbsenceCoverageCheckV1[] = coverageCandidates.map(({ assertion }) => {
      const proposition = assertion.body.proposition;
      const basis = proposition.kind === "atom"
        ? populationCoverageBasis(proposition.value, snapshot.definitionsByDigest) : undefined;
      if (basis === undefined) throw new TypeError("Missing validated coverage basis");
      // Coverage binds its own assertion context, never the query point/context.
      const selection = selectCoverageInputs(snapshot.worldId, target.population.definitionDigest,
        bindings, assertion.body.scope, assertion.body.applicability, active, snapshot.descriptors);
      const check = {
        assertionId: assertion.id, basis, inputSelection: selection,
        inputSelectionDigest: coverageInputSelectionDigest(selection),
        roster: snapshot.rosters.find((roster) => roster.digest === basis.rosterDigest)?.body ?? null,
      };
      return { ...check, status: coverageCheckStatus(check) };
    });
    const checksById = new Map(coverageChecks.map((check) => [check.assertionId, check]));
    const coverage = coverageCandidates.filter((value) => checksById.get(value.assertion.id)?.status === "matched");
    const staleCoverageAssertionIds = coverageChecks
      .filter((check) => check.status !== "matched" && check.status !== "roster-missing")
      .map((check) => check.assertionId).sort(asciiCompare);
    const membership = classified.filter((value) => {
      const proposition = value.assertion.body.proposition;
      return (
        isNonExcluded(value) &&
        matchingAtom(value, bindings.membershipPredicateDigest) &&
        proposition.kind === "atom" &&
        proposition.value.kind === "ref" &&
        proposition.value.id === target.population.descriptorId
      );
    });

    const membershipAssertionIds = membership
      .map((value) => value.assertion.id)
      .sort(asciiCompare);
    inputSelection = { ...inputSelection, membershipAssertionIds };

    const positiveCoverageAssertionIds = coverage
      .filter((value) => value.assertion.body.polarity === "positive")
      .map((value) => value.assertion.id)
      .sort(asciiCompare);
    const negativeCoverageAssertionIds = coverage
      .filter((value) => value.assertion.body.polarity === "negative")
      .map((value) => value.assertion.id)
      .sort(asciiCompare);

    const candidateIdSet = new Set(snapshot.descriptors
      .filter((descriptor) => descriptor.birthTypeDefinitionDigest === bindings.candidateTypeDefinitionDigest)
      .map((descriptor) => descriptor.id));
    for (const value of membership) {
      const proposition = value.assertion.body.proposition;
      if (proposition.kind === "atom") candidateIdSet.add(proposition.subjectId);
    }
    for (const check of coverageChecks) {
      for (const memberId of check.roster?.memberIds ?? []) candidateIdSet.add(memberId);
    }

    const candidateEvaluations: AbsenceCandidateEvaluationV1[] = [];
    for (const candidateId of [...candidateIdSet].sort(asciiCompare)) {
      const candidateMembership = membership.filter((value) => {
        const proposition = value.assertion.body.proposition;
        return proposition.kind === "atom" && proposition.subjectId === candidateId;
      });
      const positiveMemberDefinite = groupHas(
        candidateMembership,
        "positive",
        "definite",
      );
      const positiveMemberPossible = groupHas(
        candidateMembership,
        "positive",
        "possible",
      );
      const positiveMemberUnresolved = groupHas(
        candidateMembership,
        "positive",
        "unresolved",
      );
      const negativeMemberDefinite = groupHas(
        candidateMembership,
        "negative",
        "definite",
      );
      const negativeMemberUncertain =
        groupHas(candidateMembership, "negative", "possible") ||
        groupHas(candidateMembership, "negative", "unresolved");

      let membershipResult: AbsenceCandidateEvaluationV1["membership"];
      if (positiveMemberDefinite && negativeMemberDefinite) membershipResult = "conflicting";
      else if (
        positiveMemberDefinite &&
        !negativeMemberDefinite &&
        !negativeMemberUncertain
      ) {
        membershipResult = "member";
      } else if (negativeMemberDefinite && !positiveMemberDefinite && !positiveMemberPossible && !positiveMemberUnresolved) {
        membershipResult = "nonmember";
      } else if (
        positiveMemberPossible &&
        !positiveMemberUnresolved &&
        !negativeMemberDefinite &&
        !negativeMemberUncertain
      ) {
        membershipResult = "possible";
      } else {
        membershipResult = "unresolved";
      }

      const eligibility = classified.filter((value) => {
        const proposition = value.assertion.body.proposition;
        return (
          isNonExcluded(value) &&
          matchingAtom(value, bindings.eligibilityPredicateDigest) &&
          proposition.kind === "atom" &&
          proposition.subjectId === candidateId &&
          isDeepStrictEqual(proposition.value, bindings.criterionValue)
        );
      });
      const positiveEligibleDefinite = groupHas(eligibility, "positive", "definite");
      const positiveEligiblePossible = groupHas(eligibility, "positive", "possible");
      const positiveEligibleUnresolved = groupHas(eligibility, "positive", "unresolved");
      const negativeEligibleDefinite = groupHas(eligibility, "negative", "definite");
      const negativeEligibleUncertain =
        groupHas(eligibility, "negative", "possible") ||
        groupHas(eligibility, "negative", "unresolved");

      let eligibilityResult: AbsenceCandidateEvaluationV1["eligibility"];
      if (positiveEligibleDefinite && negativeEligibleDefinite) {
        eligibilityResult = "conflicting";
      } else if (
        positiveEligibleDefinite &&
        !negativeEligibleDefinite &&
        !negativeEligibleUncertain
      ) {
        eligibilityResult = "eligible";
      } else if (
        negativeEligibleDefinite &&
        !positiveEligibleDefinite &&
        !positiveEligiblePossible &&
        !positiveEligibleUnresolved
      ) {
        eligibilityResult = "ineligible";
      } else if (
        positiveEligiblePossible &&
        !positiveEligibleUnresolved &&
        !negativeEligibleDefinite &&
        !negativeEligibleUncertain
      ) {
        eligibilityResult = "possibly-eligible";
      } else {
        eligibilityResult = "unresolved";
      }

      // Positive support survives contrary information; missing eligibility is
      // not itself a recorded witness against an authorial stipulation.
      if (positiveMemberDefinite && positiveEligibleDefinite) {
        candidateIds.push(candidateId);
      } else if (
        (positiveMemberDefinite || positiveMemberPossible) &&
        (positiveEligibleDefinite || positiveEligiblePossible)
      ) {
        possibleCandidateIds.push(candidateId);
      } else if (
        (positiveMemberUnresolved &&
          (positiveEligibleDefinite || positiveEligiblePossible || positiveEligibleUnresolved)) ||
        ((positiveMemberDefinite || positiveMemberPossible) && positiveEligibleUnresolved)
      ) {
        unresolvedCandidateIds.push(candidateId);
      }

      candidateEvaluations.push({
        candidateId,
        membershipAssertionIds: candidateMembership
          .map((value) => value.assertion.id)
          .sort(asciiCompare),
        membership: membershipResult,
        eligibilityAssertionIds: eligibility
          .map((value) => value.assertion.id)
          .sort(asciiCompare),
        eligibility: eligibilityResult,
      });
    }

    candidateIds = sortedUnique(candidateIds);
    possibleCandidateIds = sortedUnique(possibleCandidateIds).filter(
      (id) => !candidateIds.includes(id),
    );
    unresolvedCandidateIds = sortedUnique(unresolvedCandidateIds).filter(
      (id) => !candidateIds.includes(id) && !possibleCandidateIds.includes(id),
    );
    const eligibilityAssertionIds = sortedUnique(
      candidateEvaluations.flatMap((candidate) => candidate.eligibilityAssertionIds),
    );


    const definiteWitness =
      existentialWitnessIds.length > 0 || candidateIds.length > 0;
    const uncertainWitness =
      possibleExistentialWitnessIds.length > 0 ||
      unresolvedExistentialWitnessIds.length > 0 ||
      possibleCandidateIds.length > 0 ||
      unresolvedCandidateIds.length > 0;

    type ProofReason = Exclude<AbsenceEvaluationBodyV1["reason"], "unsupported-semantics">;
    function proofReason(value: ClassifiedAssertion): ProofReason {
      const check = checksById.get(value.assertion.id);
      if (check === undefined) throw new TypeError("Missing coverage check");
      if (check.status === "selector-mismatch") return "coverage-selector-mismatch";
      if (check.status === "input-stale") return "coverage-input-stale";
      if (check.status === "roster-missing") return "coverage-roster-missing";
      if (check.status === "roster-mismatch") return "coverage-roster-mismatch";
      const opposition = coverageCandidates.filter((other) =>
        other.assertion.body.polarity === "negative" &&
        isDeepStrictEqual(checksById.get(other.assertion.id)?.basis, check.basis));
      if (groupHas(opposition, "negative", "definite")) return "coverage-conflicted";
      if (opposition.length > 0) return "coverage-unresolved";
      const members = new Set(check.roster?.memberIds);
      if (members.size === 0) return "membership-not-established";
      if (candidateEvaluations.some((candidate) => candidate.membership === "conflicting")) return "membership-conflicted";
      if (candidateEvaluations.some((candidate) => !members.has(candidate.candidateId) && candidate.membership === "member")) return "coverage-roster-mismatch";
      if (candidateEvaluations.some((candidate) => members.has(candidate.candidateId)
        ? candidate.membership !== "member" : candidate.membership !== "nonmember")) return "membership-unresolved";
      const intended = candidateEvaluations.filter((candidate) => members.has(candidate.candidateId));
      if (intended.some((candidate) => candidate.eligibility === "conflicting")) return "candidate-eligibility-conflicted";
      if (definiteWitness) return "recorded-witness";
      if (intended.some((candidate) => candidate.eligibility !== "ineligible") || uncertainWitness) return "candidate-eligibility-unresolved";
      return "all-candidates-ineligible";
    }
    const definiteCoverage = coverageCandidates.filter((value) =>
      value.assertion.body.polarity === "positive" && value.group === "definite");
    const attempts = definiteCoverage.map((value) => ({ id: value.assertion.id, reason: proofReason(value) }));
    const selected = attempts.find((attempt) => attempt.reason === "all-candidates-ineligible") ?? attempts[0];
    const reason: ProofReason = selected?.reason ?? (coverageCandidates.some((value) =>
      value.assertion.body.polarity === "positive") ? "coverage-unresolved" : "coverage-not-established");
    const status = reason === "all-candidates-ineligible" ? "established" : "not-established";
    const premiseAssertionIds = sortedUnique([
      ...matchingExists.filter(isNonExcluded).map((value) => value.assertion.id),
      ...coverageCandidates.map((value) => value.assertion.id),
      ...membershipAssertionIds,
      ...eligibilityAssertionIds,
    ]);

    derivation = withEvaluationDigest({
      ...receiptBase(
        inputSelection,
        positiveCoverageAssertionIds,
        negativeCoverageAssertionIds,
        eligibilityAssertionIds,
        candidateEvaluations,
        staleCoverageAssertionIds,
        coverageChecks,
        selected?.id ?? null,
        premiseAssertionIds,
      ),
      status,
      reason,
    } as AbsenceEvaluationBodyV1);
  }

  const witnessesStatus =
    existentialWitnessIds.length > 0 || candidateIds.length > 0
      ? "recorded"
      : possibleExistentialWitnessIds.length > 0 || possibleCandidateIds.length > 0
        ? "possible"
        : unresolvedExistentialWitnessIds.length > 0 || unresolvedCandidateIds.length > 0
          ? "unresolved"
          : "none-recorded";
  const bases: ("declared" | "derived")[] = [];
  if (declarationStatus === "recorded") bases.push("declared");
  if (derivation.status === "established") bases.push("derived");

  let conclusionStatus: AbsenceQueryResultV1["conclusion"]["status"];
  if (bases.length > 0 && witnessesStatus === "recorded") conclusionStatus = "conflicting";
  else if (
    bases.length > 0 &&
    (witnessesStatus === "possible" || witnessesStatus === "unresolved")
  ) {
    conclusionStatus = "unresolved";
  } else if (bases.length === 2) conclusionStatus = "absence-declared-and-derived";
  else if (bases[0] === "declared") conclusionStatus = "absence-declared";
  else if (bases[0] === "derived") conclusionStatus = "absence-derived";
  else if (witnessesStatus === "recorded") conclusionStatus = "witness-recorded";
  else if (
    declarationStatus === "possible" ||
    declarationStatus === "unresolved" ||
    witnessesStatus === "possible" ||
    witnessesStatus === "unresolved"
  ) {
    conclusionStatus = "unresolved";
  } else {
    conclusionStatus = "absence-not-established";
  }

  return {
    format: "wmm.absence-query-result/1",
    target,
    scope,
    temporal,
    conclusion: { status: conclusionStatus, bases },
    declaration: {
      status: declarationStatus,
      definiteAssertionIds: declarationDefinite,
      possibleAssertionIds: declarationPossible,
      unresolvedAssertionIds: declarationUnresolved,
    },
    witnesses: {
      status: witnessesStatus,
      existentialAssertionIds: existentialWitnessIds,
      possibleExistentialAssertionIds: possibleExistentialWitnessIds,
      unresolvedExistentialAssertionIds: unresolvedExistentialWitnessIds,
      candidateIds,
      possibleCandidateIds,
      unresolvedCandidateIds,
    },
    derivation,
  };
}
