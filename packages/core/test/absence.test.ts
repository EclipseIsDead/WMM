import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  absenceEvaluationDigest,
  absenceInputSelectionDigest,
  coverageInputSelectionDigest,
  descriptorBirthDigest,
  framedJsonDigest,
  populationRosterDigest,
} from "@wmm/canonical";
import type {
  AbsenceEvaluationBodyV1,
  AbsenceQueryResultV1,
  ClaimBodyV1,
  RosterV1,
  JsonValue,
} from "@wmm/wire-contracts";
import { validateSemanticContract } from "@wmm/wire-contracts";
import {
  queryAbsence,
  resolvePopulationSelector,
  selectCoverageInputs,
  verifyAbsenceEvaluationReceipt,
  verifyAbsenceQueryResult,
  verifyAbsenceReceiptIntegrity,
} from "../src/index.js";
import {
  buildSnapshot, findAssertion, operation, originalSnapshot, record, request,
  type AbsenceRequest,
} from "./absence-fixture.js";

interface AbsenceFixtures {
  readonly requests: readonly {
    readonly name: string;
    readonly request: AbsenceRequest;
    readonly expected: {
      readonly conclusion: string;
      readonly bases: readonly string[];
      readonly declaration: string;
      readonly witnesses: string;
      readonly derivation: string;
      readonly derivationReason: string;
      readonly inputSelectionDigest?: string;
      readonly evaluationDigest?: string;
    };
  }[];
}
const fixtures = JSON.parse(readFileSync(
  new URL("../../../fixtures/v2/absence-query-cases.json", import.meta.url), "utf8",
)) as AbsenceFixtures;
const snapshot = buildSnapshot();
const coverage = findAssertion((claim) => operation(claim) === "population-coverage-atom-v1");
const membership = (id: string) => findAssertion((claim) =>
  operation(claim) === "population-membership-atom-v1" &&
  claim.body.proposition.kind === "atom" && claim.body.proposition.subjectId === id,
);
const ineligible = (id: string) => findAssertion((claim) =>
  operation(claim) === "criterion-satisfaction-atom-v1" && claim.body.polarity === "negative" &&
  claim.body.proposition.kind === "atom" && claim.body.proposition.subjectId === id,
);
const declaration = findAssertion((claim) => claim.body.proposition.kind === "exists");
const query = (input = snapshot) => queryAbsence(
  input, request.payload.target, request.payload.scope, request.payload.temporal,
);

function coverageSelection(input: ReturnType<typeof buildSnapshot>, body = coverage.body) {
  const bindings = resolvePopulationSelector(request.payload.target.population.definitionDigest, input.definitionsByDigest);
  if (bindings === undefined) throw new Error("Missing selector");
  const active = new Set(input.activeAssertionIds);
  return selectCoverageInputs(input.worldId, request.payload.target.population.definitionDigest,
    bindings, body.scope, body.applicability,
    input.assertions.filter((assertion) => active.has(assertion.id)), input.descriptors);
}

function coverageFor(input: ReturnType<typeof buildSnapshot>, roster: RosterV1 | undefined = input.rosters[0]?.body, body = coverage.body) {
  const originalValue = coverage.body.proposition.kind === "atom" ? coverage.body.proposition.value : undefined;
  if (originalValue?.kind !== "literal" || roster === undefined) throw new Error("Missing coverage basis or roster");
  const selection = coverageSelection(input, body);
  return record({
    ...body,
    proposition: {
      kind: "atom", subjectId: request.payload.target.population.descriptorId,
      predicateDefinitionDigest: coverage.body.proposition.kind === "atom"
        ? coverage.body.proposition.predicateDefinitionDigest : "",
      value: {
        ...originalValue,
        data: {
          format: "wmm.population-coverage-basis/1",
          populationDefinitionDigest: request.payload.target.population.definitionDigest,
          selectorDefinitionDigest: selection.selectorDefinitionDigest,
          rosterDigest: populationRosterDigest(roster),
          inputSelectionDigest: coverageInputSelectionDigest(selection),
          coverageMethod: "authorAttested",
        },
      },
    },
  });
}

function withApplicability(body: ClaimBodyV1, kind: "possible" | "unresolved"): ClaimBodyV1 {
  return kind === "possible" ? {
    ...body,
    applicability: {
      kind: "point", axisDefinitionDigest: request.payload.temporal.axisDefinitionDigest,
      position: { kind: "boundedUnknown", lowerInclusive: "1000", upperExclusive: "1010" },
    },
  } : { ...body, scope: { ...body.scope, jurisdiction: { kind: "unresolved" } } };
}

describe("bounded absence querying", () => {
  it("rebuilds the unchanged fixture snapshot identity exactly", () => {
    expect(snapshot.snapshotDigest).toBe(originalSnapshot.snapshotDigest);
  });

  for (const fixture of fixtures.requests) {
    it(fixture.name, () => {
      const result = queryAbsence(snapshot, fixture.request.payload.target,
        fixture.request.payload.scope, fixture.request.payload.temporal);
      expect(result.conclusion.status).toBe(fixture.expected.conclusion);
      expect(result.conclusion.bases).toEqual(fixture.expected.bases);
      expect(result.declaration.status).toBe(fixture.expected.declaration);
      expect(result.witnesses.status).toBe(fixture.expected.witnesses);
      expect(result.derivation.status).toBe(fixture.expected.derivation);
      expect(result.derivation.reason).toBe(fixture.expected.derivationReason);
      expect(validateSemanticContract(result).valid).toBe(true);
      if (fixture.expected.inputSelectionDigest !== undefined) {
        expect(result.derivation.inputSelectionDigest).toBe(fixture.expected.inputSelectionDigest);
      }
      if (fixture.expected.evaluationDigest !== undefined) {
        expect(result.derivation.evaluationDigest).toBe(fixture.expected.evaluationDigest);
      }
      expect(result.derivation.inputSelectionDigest).toBe(absenceInputSelectionDigest(result.derivation.inputSelection));
      expect(verifyAbsenceReceiptIntegrity(result.derivation)).toMatchObject({ valid: true, verification: "integrity-only" });
      expect(verifyAbsenceEvaluationReceipt(result.derivation, snapshot)).toEqual({ valid: true, verification: "snapshot-replay", errors: [] });
      expect(verifyAbsenceQueryResult(result, snapshot).valid).toBe(true);
    });
  }

  it("pins the roster, selector, and coverage-input digest migration and birth hash domain", () => {
    const check = query().derivation.coverageChecks[0]!;
    expect(check.basis.rosterDigest).toBe("44e2ececd02a1f2e52acb07259a04eaa07ad29a39e9922798dec4661efd4e686");
    expect(check.basis.selectorDefinitionDigest).toBe("6aabdcf5ab84b1b6b3f2a789da5d36b3485ab26157d8512e36d81dd14e56df29");
    expect(check.inputSelectionDigest).toBe("04039b49eb0c111a866872af56626d1471827510a2ec4b1609f06e9d05dc9d68");
    expect(populationRosterDigest(check.roster!)).toBe(framedJsonDigest("wmm.roster/v1", check.roster as unknown as JsonValue));
    expect(check.inputSelectionDigest).toBe(framedJsonDigest("wmm.coverage-input/v1", check.inputSelection as unknown as JsonValue));
    for (const birth of snapshot.descriptors.filter((descriptor) => descriptor.id.startsWith("person:"))) {
      expect(descriptorBirthDigest(birth)).toBe(framedJsonDigest("wmm.descriptor-birth/v1", birth as unknown as JsonValue));
    }
  });

  it("keeps declarations independent of coverage and eligibility completeness", () => {
    const withoutCoverage = buildSnapshot({ deactivate: [coverage.id] });
    expect(query(withoutCoverage).conclusion).toEqual({ status: "absence-declared", bases: ["declared"] });
    expect(query(withoutCoverage).derivation.reason).toBe("coverage-not-established");
    const missingEligibility = query(buildSnapshot({ deactivate: [ineligible("person:alys").id] }));
    expect(missingEligibility.derivation.reason).toBe("candidate-eligibility-unresolved");
    expect(missingEligibility.conclusion.status).toBe("absence-declared");
    expect(missingEligibility.witnesses.status).toBe("none-recorded");
  });

  it("binds roster inputs independently of coverage, snapshot, and eligibility changes", () => {
    const initial = query();
    const changed = query(buildSnapshot({ deactivate: [coverage.id, ineligible("person:alys").id] }));
    expect(coverageSelection(buildSnapshot({ deactivate: [coverage.id, ineligible("person:alys").id], activeSupportIds: [] })))
      .toEqual(coverageSelection(snapshot));
    expect(changed.derivation.inputSelectionDigest).not.toBe(initial.derivation.inputSelectionDigest);
    const check = initial.derivation.coverageChecks[0];
    expect(check?.basis.rosterDigest).toBe(populationRosterDigest(snapshot.rosters[0]!.body));
    expect(check?.inputSelection.primitiveClaimIds).toHaveLength(2);
    expect(check?.inputSelection.candidateBirthDigests).toHaveLength(2);
  });

  it("does not reuse coverage when a new candidate or membership input is added", () => {
    const alys = membership("person:alys");
    if (alys.body.proposition.kind !== "atom") throw new Error("Missing atom");
    const newMember = record({ ...alys.body, proposition: { ...alys.body.proposition, subjectId: "person:cyra" } });
    const personType = Object.entries(snapshot.definitionsByDigest).find(([, definition]) => definition.key === "person")?.[0];
    if (personType === undefined) throw new Error("Missing person definition");
    const expanded = query(buildSnapshot({
      activate: [newMember],
      descriptors: [{ format: "wmm.descriptor/1", worldId: snapshot.worldId, id: "person:cyra", birthTypeDefinitionDigest: personType }],
    }));
    expect(expanded.derivation).toMatchObject({ status: "not-established", reason: "coverage-input-stale", staleCoverageAssertionIds: [coverage.id] });
    expect(expanded.conclusion.bases).toEqual(["declared"]);
  });

  it("cannot turn a removed eligible member into derived absence using old coverage", () => {
    const branNegative = ineligible("person:bran");
    const branEligible = record({ ...branNegative.body, polarity: "positive" });
    const common = { deactivate: [branNegative.id, declaration.id], activate: [branEligible] };
    expect(query(buildSnapshot(common)).conclusion.status).toBe("witness-recorded");
    const reduced = query(buildSnapshot({ ...common, deactivate: [...common.deactivate, membership("person:bran").id] }));
    expect(reduced.derivation.reason).toBe("coverage-input-stale");
    expect(reduced.conclusion.status).toBe("absence-not-established");
  });

  it("requires explicit renewed coverage after changing the roster", () => {
    const deactivate = [membership("person:bran").id, declaration.id, coverage.id];
    const notMember = record({ ...membership("person:bran").body, polarity: "negative" });
    const roster = { ...snapshot.rosters[0]!.body, memberIds: ["person:alys"] };
    const options = { deactivate, activate: [notMember], rosters: [roster] };
    const changed = buildSnapshot(options);
    const renewed = coverageFor(changed);
    const result = query(buildSnapshot({ ...options, activate: [notMember, renewed] }));
    expect(result.conclusion).toEqual({ status: "absence-derived", bases: ["derived"] });
    expect(result.derivation.positiveCoverageAssertionIds).toEqual([renewed.id]);
  });

  it("does not derive from an empty roster even with renewed coverage", () => {
    const deactivate = [membership("person:alys").id, membership("person:bran").id];
    const roster = { ...snapshot.rosters[0]!.body, memberIds: [] };
    const changed = buildSnapshot({ deactivate, rosters: [roster] });
    expect(query(changed).derivation.reason).toBe("coverage-input-stale");
    const renewed = coverageFor(changed);
    const result = query(buildSnapshot({ deactivate: [...deactivate, coverage.id], activate: [renewed], rosters: [roster] }));
    expect(result.derivation.reason).toBe("membership-not-established");
    expect(result.conclusion.status).toBe("absence-declared");
  });

  it("stales coverage on a new person birth even without any membership claim", () => {
    const born = { ...snapshot.descriptors.find((descriptor) => descriptor.id === "person:alys")!, id: "person:cyra" };
    const changed = buildSnapshot({ descriptors: [born] });
    const result = query(changed);
    expect(result.derivation).toMatchObject({ status: "not-established", reason: "coverage-input-stale", staleCoverageAssertionIds: [coverage.id] });
    expect(result.derivation.coverageChecks[0]?.inputSelection.candidateBirthDigests).toHaveLength(3);
    expect(verifyAbsenceEvaluationReceipt(result.derivation, changed).valid).toBe(true);
  });

  it("retains missing roster references as incomplete proof, with genuine changed snapshot identity", () => {
    const missing = buildSnapshot({ rosters: [] });
    expect(missing.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    const result = query(missing);
    expect(result.derivation).toMatchObject({ status: "not-established", reason: "coverage-roster-missing" });
    expect(result.derivation.coverageChecks[0]).toMatchObject({ status: "roster-missing", roster: null });
    expect(result.conclusion.status).toBe("absence-declared");
    expect(verifyAbsenceQueryResult(result, missing).valid).toBe(true);
  });

  it("renewed coverage cannot eliminate an extra candidate with unresolved membership", () => {
    const born = { ...snapshot.descriptors.find((descriptor) => descriptor.id === "person:alys")!, id: "person:cyra" };
    const changed = buildSnapshot({ descriptors: [born] });
    const renewed = coverageFor(changed);
    const result = query(buildSnapshot({ descriptors: [born], deactivate: [coverage.id], activate: [renewed] }));
    expect(result.derivation.reason).toBe("membership-unresolved");
    expect(result.derivation.candidates.find((candidate) => candidate.candidateId === born.id)?.membership).toBe("unresolved");
    expect(result.conclusion.bases).toEqual(["declared"]);
  });

  it("a definite negative nonmember can eliminate an extra candidate after renewed coverage", () => {
    const born = { ...snapshot.descriptors.find((descriptor) => descriptor.id === "person:alys")!, id: "person:cyra" };
    const original = membership("person:alys");
    if (original.body.proposition.kind !== "atom") throw new Error("Missing membership atom");
    const notMember = record({ ...original.body, polarity: "negative", proposition: { ...original.body.proposition, subjectId: born.id } });
    const options = { descriptors: [born], deactivate: [coverage.id], activate: [notMember] };
    const renewed = coverageFor(buildSnapshot(options));
    const input = buildSnapshot({ ...options, activate: [notMember, renewed] });
    const result = query(input);
    expect(result.derivation.status).toBe("established");
    expect(result.derivation.candidates.find((candidate) => candidate.candidateId === born.id)).toMatchObject({ membership: "nonmember", eligibility: "unresolved" });
    expect(validateSemanticContract(result).valid).toBe(true);
    expect(verifyAbsenceQueryResult(result, input).valid).toBe(true);
  });

  it("does not trust a claimed roster that omits a definite member", () => {
    const roster = { ...snapshot.rosters[0]!.body, memberIds: ["person:alys"] };
    const options = { rosters: [roster], deactivate: [coverage.id] };
    const renewed = coverageFor(buildSnapshot(options));
    const result = query(buildSnapshot({ ...options, activate: [renewed] }));
    expect(result.derivation.reason).toBe("coverage-roster-mismatch");
    expect(result.derivation.coverageChecks[0]?.status).toBe("matched");
  });

  it("selects all primitive membership variants, including other populations and negative claims", () => {
    const original = membership("person:alys");
    if (original.body.proposition.kind !== "atom") throw new Error("Missing membership atom");
    const other = record({ ...original.body, polarity: "negative",
      proposition: { ...original.body.proposition, value: { kind: "ref", id: "population:other" } },
      scope: { ...original.body.scope, jurisdiction: { kind: "unresolved" } },
      applicability: { kind: "invariant" },
    });
    const population = snapshot.descriptors.find((descriptor) => descriptor.id === request.payload.target.population.descriptorId)!;
    const changed = buildSnapshot({ activate: [other], descriptors: [{ ...population, id: "population:other" }] });
    expect(coverageSelection(changed).primitiveClaimIds).toContain(other.id);
    expect(query(changed).derivation.reason).toBe("coverage-input-stale");
  });

  it("binds inputs at the coverage assertion context, not the query point", () => {
    const early = query();
    const later = queryAbsence(snapshot, request.payload.target, request.payload.scope, { ...request.payload.temporal, position: "1035" });
    expect(early.derivation.coverageChecks[0]?.inputSelection).toEqual(later.derivation.coverageChecks[0]?.inputSelection);
    expect(early.derivation.coverageChecks[0]?.inputSelection.applicability).toEqual(coverage.body.applicability);
    expect(early.derivation.coverageChecks[0]?.basis.inputSelectionDigest).toBe(early.derivation.coverageChecks[0]?.inputSelectionDigest);
    const uncertainScope = queryAbsence(snapshot, request.payload.target,
      { ...request.payload.scope, jurisdiction: { kind: "unresolved" } }, request.payload.temporal);
    expect(uncertainScope.derivation.coverageChecks[0]?.inputSelection).toEqual(early.derivation.coverageChecks[0]?.inputSelection);
    expect(uncertainScope.derivation.reason).toBe("coverage-unresolved");
  });

  it("keeps the primitive/birth selection stable under order and identical duplicates", () => {
    const bindings = resolvePopulationSelector(request.payload.target.population.definitionDigest, snapshot.definitionsByDigest)!;
    const active = snapshot.assertions.filter((assertion) => snapshot.activeAssertionIds.includes(assertion.id));
    expect(selectCoverageInputs(snapshot.worldId, request.payload.target.population.definitionDigest,
      bindings, coverage.body.scope, coverage.body.applicability,
      [...active].reverse().concat(active), [...snapshot.descriptors].reverse().concat(snapshot.descriptors)))
      .toEqual(coverageSelection(snapshot));
  });

  it("rejects conflicting duplicate primitive and birth bodies during selection", () => {
    const bindings = resolvePopulationSelector(request.payload.target.population.definitionDigest, snapshot.definitionsByDigest)!;
    const original = membership("person:alys");
    expect(() => selectCoverageInputs(snapshot.worldId, request.payload.target.population.definitionDigest,
      bindings, coverage.body.scope, coverage.body.applicability,
      [original, { ...original, body: { ...original.body, polarity: "negative" } }], snapshot.descriptors)).toThrow(/Conflicting duplicate/);
    const birth = snapshot.descriptors[0]!;
    expect(() => selectCoverageInputs(snapshot.worldId, request.payload.target.population.definitionDigest,
      bindings, coverage.body.scope, coverage.body.applicability, [],
      [birth, { ...birth, birthTypeDefinitionDigest: "0".repeat(64) }])).toThrow(/Conflicting duplicate/);
  });

  it("blocks conflicting coverage without retracting the authorial declaration", () => {
    const negative = record({ ...coverage.body, polarity: "negative" });
    const result = query(buildSnapshot({ activate: [negative] }));
    expect(result.derivation.reason).toBe("coverage-conflicted");
    expect(result.conclusion.bases).toEqual(["declared"]);
  });

  it("a negative coverage tuple does not deny a different valid roster tuple", () => {
    const otherRoster = { ...snapshot.rosters[0]!.body, memberIds: ["person:alys"] };
    const options = { rosters: [snapshot.rosters[0]!.body, otherRoster] };
    const otherCoverage = coverageFor(buildSnapshot(options), otherRoster);
    const denied = record({ ...otherCoverage.body, polarity: "negative" });
    const result = query(buildSnapshot({ ...options, activate: [denied] }));
    expect(result.derivation.status).toBe("established");
    expect(result.derivation.selectedCoverageAssertionId).toBe(coverage.id);
  });

  it("requires every roster member to be a definite member even with renewed coverage", () => {
    const original = membership("person:alys");
    const uncertain = record(withApplicability(original.body, "possible"));
    const options = { deactivate: [coverage.id, original.id], activate: [uncertain] };
    const renewed = coverageFor(buildSnapshot(options));
    const result = query(buildSnapshot({ ...options, activate: [uncertain, renewed] }));
    expect(result.derivation.reason).toBe("membership-unresolved");
  });

  it("preserves a definite positive witness under conflicting membership", () => {
    const eligible = record({ ...ineligible("person:alys").body, polarity: "positive" });
    const notMember = record({ ...membership("person:alys").body, polarity: "negative" });
    const result = query(buildSnapshot({ activate: [eligible, notMember] }));
    expect(result.witnesses.candidateIds).toContain("person:alys");
    expect(result.conclusion.status).toBe("conflicting");
  });

  for (const certainty of ["possible", "unresolved"] as const) {
    it(`preserves positive witnesses under ${certainty} negative eligibility`, () => {
      const negative = ineligible("person:alys");
      const eligible = record({ ...negative.body, polarity: "positive" });
      const uncertainNegative = record(withApplicability(negative.body, certainty));
      const result = query(buildSnapshot({ deactivate: [negative.id], activate: [eligible, uncertainNegative] }));
      expect(result.witnesses.candidateIds).toContain("person:alys");
      expect(result.conclusion.status).toBe("conflicting");
    });

    it(`does not invent an eligible witness from ${certainty} membership and definite ineligibility`, () => {
      const original = membership("person:alys");
      const uncertain = record(withApplicability(original.body, certainty));
      const result = query(buildSnapshot({ deactivate: [original.id], activate: [uncertain] }));
      expect(result.witnesses.status).toBe("none-recorded");
      expect(result.witnesses.unresolvedCandidateIds).toEqual([]);
      expect(result.conclusion.status).toBe("absence-declared");
    });
  }

  it("rejects weakened criteria and interval calls at the core boundary", () => {
    const result = queryAbsence(snapshot, {
      ...request.payload.target,
      criterion: { ...request.payload.target.criterion,
        arguments: { ...request.payload.target.criterion.arguments, rank: { kind: "ref", id: "person:alys" } } },
    }, request.payload.scope, request.payload.temporal);
    expect(result.derivation.status).toBe("unsupported");
    expect(result.conclusion.status).toBe("absence-not-established");
    expect(() => queryAbsence(snapshot, request.payload.target, request.payload.scope, {
      format: "wmm.temporal-query/1", mode: "throughout",
      axisDefinitionDigest: request.payload.temporal.axisDefinitionDigest,
      start: "1000", endExclusive: "1030",
    })).toThrow(/exact point queries only/);
  });
});

describe("receipt integrity versus snapshot-backed verification", () => {
  it("rejects malformed receipts and unrehashed edits", () => {
    expect(verifyAbsenceReceiptIntegrity(null).errors).toEqual(["INVALID_RECEIPT_SHAPE"]);
    const receipt = query().derivation;
    expect(verifyAbsenceReceiptIntegrity({ ...receipt, inputSelectionDigest: "0".repeat(64) }).errors)
      .toEqual(["INPUT_SELECTION_DIGEST_MISMATCH", "EVALUATION_DIGEST_MISMATCH"]);
    expect(verifyAbsenceReceiptIntegrity({ ...receipt, evaluationDigest: "0".repeat(64) }).errors)
      .toEqual(["EVALUATION_DIGEST_MISMATCH"]);
  });

  it("detects rehashed inconsistent coverage checks and missing premise closure", () => {
    const receipt = query().derivation;
    const { evaluationDigest: _digest, ...original } = receipt;
    const inconsistent: AbsenceEvaluationBodyV1 = {
      ...original,
      coverageChecks: original.coverageChecks.map((check) => ({ ...check,
        basis: { ...check.basis, inputSelectionDigest: "0".repeat(64) } })),
    };
    expect(verifyAbsenceReceiptIntegrity({ ...inconsistent, evaluationDigest: absenceEvaluationDigest(inconsistent) }).errors).toContain("COVERAGE_CHECK_MISMATCH");
    const missing: AbsenceEvaluationBodyV1 = { ...original, premiseAssertionIds: [] };
    expect(verifyAbsenceReceiptIntegrity({ ...missing, evaluationDigest: absenceEvaluationDigest(missing) }).errors).toEqual(["PREMISE_SELECTION_MISMATCH"]);
  });

  it("rejects a rehashed false proof even though its shape and hashes are consistent", () => {
    const witnessed = queryAbsence(snapshot, request.payload.target, request.payload.scope, { ...request.payload.temporal, position: "1035" });
    const { evaluationDigest: _digest, ...original } = witnessed.derivation;
    const body: AbsenceEvaluationBodyV1 = {
      ...original,
      status: "established", reason: "all-candidates-ineligible",
      candidates: original.candidates.map((candidate) => ({ ...candidate, eligibility: "ineligible" })),
    };
    const forged = { ...body, evaluationDigest: absenceEvaluationDigest(body) };
    expect(verifyAbsenceReceiptIntegrity(forged).valid).toBe(true);
    expect(verifyAbsenceEvaluationReceipt(forged, snapshot)).toMatchObject({ valid: false, errors: ["EVALUATION_MISMATCH"] });
  });

  it("rejects a rehashed forged roster/input proof against snapshot-backed replay", () => {
    const witnessed = queryAbsence(snapshot, request.payload.target, request.payload.scope, { ...request.payload.temporal, position: "1035" });
    const { evaluationDigest: _digest, ...original } = witnessed.derivation;
    const body: AbsenceEvaluationBodyV1 = {
      ...original, status: "established", reason: "all-candidates-ineligible",
      coverageChecks: original.coverageChecks.map((check) => {
        const roster: RosterV1 = { ...check.roster!, memberIds: ["person:alys"] };
        const inputSelection = { ...check.inputSelection, primitiveClaimIds: [] };
        const digest = coverageInputSelectionDigest(inputSelection);
        return { ...check, roster, inputSelection, inputSelectionDigest: digest,
          basis: { ...check.basis, rosterDigest: populationRosterDigest(roster), inputSelectionDigest: digest } };
      }),
      candidates: original.candidates.map((candidate) => ({ ...candidate, eligibility: "ineligible" })),
    };
    const forged = { ...body, evaluationDigest: absenceEvaluationDigest(body) };
    expect(verifyAbsenceReceiptIntegrity(forged).valid).toBe(true);
    expect(verifyAbsenceEvaluationReceipt(forged, snapshot).errors).toEqual(["EVALUATION_MISMATCH"]);
  });

  it("rejects another snapshot and altered top-level query conclusions", () => {
    const result = query();
    const changed = buildSnapshot({ deactivate: [coverage.id] });
    expect(verifyAbsenceEvaluationReceipt(result.derivation, changed).errors).toEqual(["SNAPSHOT_MISMATCH"]);
    const altered: AbsenceQueryResultV1 = { ...result, conclusion: { status: "absence-not-established", bases: [] } };
    expect(verifyAbsenceQueryResult(altered, snapshot).valid).toBe(false);
  });
});
