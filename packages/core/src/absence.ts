import { isDeepStrictEqual } from "node:util";

import {
  absenceEvaluationDigest,
  absenceInputSelectionDigest,
} from "@wmm/canonical";
import {
  assertValidTemporalQuery,
  evaluateApplicability,
  TemporalInputError,
} from "@wmm/temporal";
import type {
  AbsenceCandidateEvaluationV1,
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

import {
  ClaimQueryInputError,
  classifyQueryComparison,
  type ClaimQueryGroupV1,
} from "./query.js";
import { compareScope } from "./scope.js";

/**
 * Precondition: the repository adapter has verified that snapshotDigest identifies
 * the supplied active assertions and semantic definitions.
 */
export interface ValidatedAbsenceQuerySnapshotV1 {
  readonly worldId: string;
  readonly snapshotDigest: string;
  readonly activeAssertionIds: readonly AssertionId[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
}

interface ClassifiedAssertion {
  readonly assertion: AssertionRecordV1;
  readonly group: ClaimQueryGroupV1;
}

interface AbsenceSemanticBindings {
  readonly coveragePredicateDigest: string;
  readonly membershipPredicateDigest: string;
  readonly eligibilityPredicateDigest: string;
  readonly criterionValue: ExistsV1["criterion"]["arguments"][string];
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(asciiCompare);
}

function activeAssertions(snapshot: ValidatedAbsenceQuerySnapshotV1): AssertionRecordV1[] {
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

function resolveBindings(
  target: ExistsV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
): AbsenceSemanticBindings | undefined {
  const population = definitions[target.population.definitionDigest];
  const criterion = definitions[target.criterion.definitionDigest];
  if (
    population?.kind !== "population" ||
    population.operation !== "bundled-candidate-membership-v1" ||
    criterion?.kind !== "criterion" ||
    criterion.operation !== "bundled-eligibility-v1" ||
    !isDeepStrictEqual(Object.keys(target.criterion.arguments).sort(), ["office"])
  ) {
    return undefined;
  }

  const coveragePredicateDigest = dependencyForOperation(
    population,
    definitions,
    "population-coverage-atom-v1",
  );
  const membershipPredicateDigest = dependencyForOperation(
    population,
    definitions,
    "population-membership-atom-v1",
  );
  const eligibilityPredicateDigest = dependencyForOperation(
    criterion,
    definitions,
    "criterion-satisfaction-atom-v1",
  );
  const criterionValue = target.criterion.arguments["office"];
  if (
    coveragePredicateDigest === undefined ||
    membershipPredicateDigest === undefined ||
    eligibilityPredicateDigest === undefined ||
    criterionValue?.kind !== "ref"
  ) {
    return undefined;
  }

  return {
    coveragePredicateDigest,
    membershipPredicateDigest,
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
) {
  return {
    format: "wmm.absence-evaluation-receipt/1" as const,
    algorithm: "bundled-absence-point-v1" as const,
    inputSelection,
    inputSelectionDigest: absenceInputSelectionDigest(inputSelection),
    positiveCoverageAssertionIds,
    negativeCoverageAssertionIds,
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

export interface AbsenceReceiptVerificationV1 {
  readonly valid: boolean;
  readonly errors: readonly (
    | "INPUT_SELECTION_DIGEST_MISMATCH"
    | "EVALUATION_DIGEST_MISMATCH"
  )[];
}

export function verifyAbsenceEvaluationReceipt(
  receipt: AbsenceEvaluationReceiptV1,
): AbsenceReceiptVerificationV1 {
  const errors: (
    | "INPUT_SELECTION_DIGEST_MISMATCH"
    | "EVALUATION_DIGEST_MISMATCH"
  )[] = [];
  if (
    receipt.inputSelectionDigest !==
    absenceInputSelectionDigest(receipt.inputSelection)
  ) {
    errors.push("INPUT_SELECTION_DIGEST_MISMATCH");
  }
  const { evaluationDigest, ...body } = receipt;
  if (evaluationDigest !== absenceEvaluationDigest(body as AbsenceEvaluationBodyV1)) {
    errors.push("EVALUATION_DIGEST_MISMATCH");
  }
  return { valid: errors.length === 0, errors };
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

  const classified = classifyAssertions(activeAssertions(snapshot), scope, temporal);
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
      ...receiptBase(inputSelection, [], [], [], []),
      status: "unsupported",
      reason: "unsupported-semantics",
    });
  } else {
    const coverage = classified.filter((value) => {
      const proposition = value.assertion.body.proposition;
      return (
        isNonExcluded(value) &&
        matchingAtom(value, bindings.coveragePredicateDigest) &&
        proposition.kind === "atom" &&
        proposition.subjectId === target.population.descriptorId &&
        proposition.value.kind === "ref" &&
        proposition.value.id === target.population.descriptorId
      );
    });
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

    const candidateIdSet = new Set<string>();
    for (const value of membership) {
      const proposition = value.assertion.body.proposition;
      if (value.assertion.body.polarity === "positive" && proposition.kind === "atom") {
        candidateIdSet.add(proposition.subjectId);
      }
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

      if (
        membershipResult === "member" &&
        (eligibilityResult === "eligible" || eligibilityResult === "conflicting")
      ) {
        candidateIds.push(candidateId);
      } else if (
        (membershipResult === "member" || membershipResult === "possible") &&
        (eligibilityResult === "eligible" || eligibilityResult === "possibly-eligible")
      ) {
        possibleCandidateIds.push(candidateId);
      } else if (
        membershipResult !== "member" ||
        eligibilityResult === "unresolved"
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

    const coveragePositiveDefinite = groupHas(coverage, "positive", "definite");
    const coveragePositiveUncertain =
      groupHas(coverage, "positive", "possible") ||
      groupHas(coverage, "positive", "unresolved");
    const coverageNegativeDefinite = groupHas(coverage, "negative", "definite");
    const coverageNegativeUncertain =
      groupHas(coverage, "negative", "possible") ||
      groupHas(coverage, "negative", "unresolved");
    const membershipConflict = candidateEvaluations.some(
      (candidate) => candidate.membership === "conflicting",
    );
    const membershipUnresolved = candidateEvaluations.some(
      (candidate) => candidate.membership !== "member",
    );
    const eligibilityConflict = candidateEvaluations.some(
      (candidate) => candidate.eligibility === "conflicting",
    );
    const eligibilityUnresolved = candidateEvaluations.some(
      (candidate) => candidate.eligibility !== "ineligible",
    );
    const definiteWitness =
      existentialWitnessIds.length > 0 || candidateIds.length > 0;
    const uncertainWitness =
      possibleExistentialWitnessIds.length > 0 ||
      unresolvedExistentialWitnessIds.length > 0 ||
      possibleCandidateIds.length > 0 ||
      unresolvedCandidateIds.length > 0;

    let status: AbsenceEvaluationBodyV1["status"];
    let reason: AbsenceEvaluationBodyV1["reason"];
    if (!coveragePositiveDefinite && coveragePositiveUncertain) {
      status = "not-established";
      reason = "coverage-unresolved";
    } else if (!coveragePositiveDefinite) {
      status = "not-established";
      reason = "coverage-not-established";
    } else if (coverageNegativeDefinite) {
      status = "not-established";
      reason = "coverage-conflicted";
    } else if (coverageNegativeUncertain) {
      status = "not-established";
      reason = "coverage-unresolved";
    } else if (candidateEvaluations.length === 0) {
      status = "not-established";
      reason = "membership-not-established";
    } else if (membershipConflict) {
      status = "not-established";
      reason = "membership-conflicted";
    } else if (membershipUnresolved) {
      status = "not-established";
      reason = "membership-unresolved";
    } else if (eligibilityConflict) {
      status = "not-established";
      reason = "candidate-eligibility-conflicted";
    } else if (definiteWitness) {
      status = "not-established";
      reason = "recorded-witness";
    } else if (eligibilityUnresolved || uncertainWitness) {
      status = "not-established";
      reason = "candidate-eligibility-unresolved";
    } else {
      status = "established";
      reason = "all-candidates-ineligible";
    }

    derivation = withEvaluationDigest({
      ...receiptBase(
        inputSelection,
        positiveCoverageAssertionIds,
        negativeCoverageAssertionIds,
        eligibilityAssertionIds,
        candidateEvaluations,
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
