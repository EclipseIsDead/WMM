import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  absenceEvaluationDigest,
  absenceInputSelectionDigest,
  coverageInputSelectionDigest,
  descriptorBirthDigest,
  populationRosterDigest,
} from "../packages/canonical/dist/index.js";
import {
  loadBundledV1WorldBundle,
  validateWorldBundle,
} from "../packages/exchange/dist/index.js";
import {
  validateApiRequest,
  validateSemanticContract,
} from "../packages/wire-contracts/dist/index.js";

const bundlePath = "fixtures/v1/complete-world";
const bundle = loadBundledV1WorldBundle(
  fileURLToPath(new URL(`../${bundlePath}/`, import.meta.url)),
);
const report = validateWorldBundle(bundle);
assert.equal(report.status, "valid");
assert.equal(report.files, 45);
assert.equal(report.assertions, 8);
assert.equal(report.activeAssertions, 8);
const { world } = bundle;
const ids = (records) => records.map((record) => record.id).sort();
const activeIds = new Set(world.activeAssertionIds);
const assertions = bundle.assertions.filter((record) => activeIds.has(record.id));

function only(records, role) {
  assert.equal(records.length, 1, `Expected exactly one ${role}`);
  return records[0];
}

function operation(record) {
  const proposition = record.body.proposition;
  return proposition.kind === "atom"
    ? bundle.definitionsByDigest[proposition.predicateDefinitionDigest]?.operation
    : undefined;
}

const declaration = only(
  assertions.filter((record) => record.body.proposition.kind === "exists"),
  "absence declaration",
);
assert.equal(declaration.body.polarity, "negative");
const target = declaration.body.proposition;
const scope = declaration.body.scope;
assert.equal(declaration.body.applicability.kind, "interval");
const { axisDefinitionDigest } = declaration.body.applicability;
const invariant = only(
  assertions.filter((record) => record.body.applicability.kind === "invariant"),
  "invariant claim",
);
const memberships = assertions.filter(
  (record) => operation(record) === "population-membership-atom-v1",
);
const eligibility = assertions.filter(
  (record) => operation(record) === "criterion-satisfaction-atom-v1",
);
const ineligible = eligibility.filter((record) => record.body.polarity === "negative");
const laterEligible = only(
  eligibility.filter((record) => record.body.polarity === "positive"),
  "later positive eligibility claim",
);
const coverage = only(
  assertions.filter((record) => operation(record) === "population-coverage-atom-v1"),
  "coverage claim",
);

// These are independent expectations for this exact fixture, not a query oracle.
// Fail before writing if the known roles, scopes, or exact intervals have changed.
assert.equal(memberships.length, 2);
assert.equal(ineligible.length, 2);
assert.deepEqual(
  ids([invariant, declaration, ...memberships, ...ineligible, laterEligible, coverage]),
  [...world.activeAssertionIds].sort(),
);
for (const record of assertions) assert.deepEqual(record.body.scope, scope);
function expectInterval(record, start, endExclusive) {
  assert.deepEqual(record.body.applicability, {
    kind: "interval",
    axisDefinitionDigest,
    start: { kind: "exact", position: start },
    endExclusive: { kind: "exact", position: endExclusive },
  });
}
expectInterval(declaration, "1000", "1030");
for (const record of [...memberships, coverage]) expectInterval(record, "1000", "1040");
for (const record of ineligible) expectInterval(record, "1000", "1030");
expectInterval(laterEligible, "1030", "1040");
const candidateIds = memberships.map((record) => record.body.proposition.subjectId).sort();
assert.deepEqual(candidateIds, ["person:alys", "person:bran"]);
for (const record of memberships) {
  assert.equal(record.body.polarity, "positive");
  assert.deepEqual(record.body.proposition.value, {
    kind: "ref",
    id: target.population.descriptorId,
  });
}
for (const record of eligibility) {
  assert.deepEqual(record.body.proposition.value, target.criterion.arguments.office);
}
assert.equal(laterEligible.body.proposition.subjectId, "person:bran");

// Construct the asserted census and primitive/birth selection from known fixture roles.
const membershipAssertionIds = ids(memberships);
const roster = {
  format: "wmm.roster/1", worldId: world.worldId,
  populationDefinitionDigest: target.population.definitionDigest, memberIds: candidateIds,
};
const rosterDigest = populationRosterDigest(roster);
assert.deepEqual(bundle.rosters, [{ digest: rosterDigest, body: roster }]);
const selectorDefinitionDigest = only(Object.entries(bundle.definitionsByDigest)
  .filter(([, definition]) => definition.key === "candidate_selector"), "candidate selector")[0];
const candidateBirths = bundle.descriptors.filter((descriptor) => candidateIds.includes(descriptor.id));
assert.equal(candidateBirths.length, 2);
const coverageInputSelection = {
  format: "wmm.coverage-input/1", worldId: world.worldId,
  populationDefinitionDigest: target.population.definitionDigest, selectorDefinitionDigest,
  scope: coverage.body.scope, applicability: coverage.body.applicability,
  primitiveClaimIds: membershipAssertionIds,
  candidateBirthDigests: candidateBirths.map(descriptorBirthDigest).sort(),
};
const coverageInputDigest = coverageInputSelectionDigest(coverageInputSelection);
assert.equal(coverage.body.polarity, "positive");
assert.equal(coverage.body.proposition.subjectId, target.population.descriptorId);
const coverageValue = coverage.body.proposition.value;
assert.equal(coverageValue.kind, "literal");
assert.equal(
  bundle.definitionsByDigest[coverageValue.valueDefinitionDigest]?.operation,
  "population-coverage-basis-v1",
);
assert.deepEqual(coverageValue.data, {
  format: "wmm.population-coverage-basis/1",
  populationDefinitionDigest: target.population.definitionDigest,
  selectorDefinitionDigest, rosterDigest, inputSelectionDigest: coverageInputDigest,
  coverageMethod: "authorAttested",
});

const temporal = (position) => ({
  format: "wmm.temporal-query/1",
  mode: "at",
  axisDefinitionDigest,
  position,
});
function request(operation, requestId, payload) {
  return {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId,
    operation,
    payload: { bundlePath, ...payload },
  };
}
const claimRequest = (requestId, position, queryScope = scope) =>
  request("claims.query", requestId, { scope: queryScope, temporal: temporal(position) });
const absenceRequest = (position) =>
  request("absence.query", `absence-at-${position}`, { target, scope, temporal: temporal(position) });
const groups = (definite = [], unresolved = [], excluded = []) => ({
  definite,
  possible: [],
  unresolved,
  excluded,
});
const at1005 = ids(assertions.filter((record) => record.id !== laterEligible.id));
const claimFixtures = {
  format: "wmm.claim-query-fixtures/1",
  requests: [
    {
      name: "applicable at 1005",
      request: claimRequest("claims-at-1005", "1005"),
      expected: groups(at1005, [], [laterEligible.id]),
    },
    {
      name: "outside interval at 2000",
      request: claimRequest("claims-at-2000", "2000"),
      expected: groups([invariant.id], [], ids(assertions.filter((record) => record.id !== invariant.id))),
    },
    {
      name: "different recognition frame",
      request: claimRequest("claims-rival-frame", "1005", {
        ...scope,
        recognitionFrame: { kind: "ref", id: "frame:rival-court" },
      }),
      expected: groups([], [], ids(assertions)),
    },
    {
      name: "unresolved recognition frame",
      request: claimRequest("claims-unresolved-frame", "1005", {
        ...scope,
        recognitionFrame: { kind: "unresolved" },
      }),
      expected: groups([], at1005, [laterEligible.id]),
    },
  ],
};

// At 1005 both members have only negative eligibility, with matching coverage.
// Hash the explicit known receipt rather than executing the absence algorithm.
const inputSelection = {
  format: "wmm.absence-input-selection/1",
  worldId: world.worldId,
  snapshotDigest: bundle.snapshot.snapshotDigest,
  target,
  scope,
  temporal: temporal("1005"),
  membershipAssertionIds,
};
const evaluationBody = {
  format: "wmm.absence-evaluation-receipt/1",
  algorithm: "bundled-absence-point-v3",
  inputSelection,
  inputSelectionDigest: absenceInputSelectionDigest(inputSelection),
  positiveCoverageAssertionIds: [coverage.id],
  negativeCoverageAssertionIds: [],
  staleCoverageAssertionIds: [],
  selectedCoverageAssertionId: coverage.id,
  coverageChecks: [{
    assertionId: coverage.id, basis: coverageValue.data,
    inputSelection: coverageInputSelection, inputSelectionDigest: coverageInputDigest,
    roster, status: "matched",
  }],
  premiseAssertionIds: ids([declaration, coverage, ...memberships, ...ineligible]),
  eligibilityAssertionIds: ids(ineligible),
  candidates: candidateIds.map((candidateId) => ({
    candidateId,
    membershipAssertionIds: [only(
      memberships.filter((record) => record.body.proposition.subjectId === candidateId),
      `membership for ${candidateId}`,
    ).id],
    membership: "member",
    eligibilityAssertionIds: [only(
      ineligible.filter((record) => record.body.proposition.subjectId === candidateId),
      `negative eligibility for ${candidateId}`,
    ).id],
    eligibility: "ineligible",
  })),
  status: "established",
  reason: "all-candidates-ineligible",
};
const receipt = { ...evaluationBody, evaluationDigest: absenceEvaluationDigest(evaluationBody) };
assert.deepEqual(validateSemanticContract(receipt), { valid: true, errors: [] });
const absenceFixtures = {
  format: "wmm.absence-query-fixtures/1",
  requests: [
    {
      name: "declared and derived absence at 1005",
      request: absenceRequest("1005"),
      expected: {
        conclusion: "absence-declared-and-derived",
        bases: ["declared", "derived"],
        declaration: "recorded",
        witnesses: "none-recorded",
        derivation: "established",
        derivationReason: "all-candidates-ineligible",
        inputSelectionDigest: receipt.inputSelectionDigest,
        evaluationDigest: receipt.evaluationDigest,
      },
    },
    {
      name: "recorded witness at 1035",
      request: absenceRequest("1035"),
      expected: {
        conclusion: "witness-recorded",
        bases: [],
        declaration: "not-recorded",
        witnesses: "recorded",
        derivation: "not-established",
        derivationReason: "recorded-witness",
      },
    },
    {
      name: "empty search does not establish absence at 2000",
      request: absenceRequest("2000"),
      expected: {
        conclusion: "absence-not-established",
        bases: [],
        declaration: "not-recorded",
        witnesses: "none-recorded",
        derivation: "not-established",
        derivationReason: "coverage-not-established",
      },
    },
  ],
};
for (const fixture of [...claimFixtures.requests, ...absenceFixtures.requests]) {
  assert.deepEqual(validateApiRequest(fixture.request), { valid: true, errors: [] });
}
const outputs = {
  "claim-query-cases.json": claimFixtures,
  "absence-query-cases.json": absenceFixtures,
  "query-request.json": claimFixtures.requests[0].request,
  "absence-request.json": absenceFixtures.requests[0].request,
};
for (const [name, value] of Object.entries(outputs)) {
  writeFileSync(new URL(`../fixtures/v2/${name}`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(JSON.stringify({
  status: "generated",
  snapshotDigest: report.snapshotDigest,
  files: Object.keys(outputs),
  populationDefinitionDigest: target.population.definitionDigest,
  invariantAssertionId: invariant.id,
  laterEligibleAssertionId: laterEligible.id,
  declarationAssertionId: declaration.id,
  membershipAssertionIds,
  eligibilityAssertionIds: receipt.eligibilityAssertionIds,
  coverageAssertionId: coverage.id,
  rosterDigest,
  selectorDefinitionDigest,
  coverageInputDigest,
  inputSelectionDigest: receipt.inputSelectionDigest,
  evaluationDigest: receipt.evaluationDigest,
}));
