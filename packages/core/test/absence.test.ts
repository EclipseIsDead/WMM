import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  absenceEvaluationDigest,
  absenceInputSelectionDigest,
} from "@wmm/canonical";
import type {
  ApiRequestV1,
  AssertionRecordV1,
  SemanticDefinitionV1,
  SnapshotRecordV1,
  WorldCatalogV1,
} from "@wmm/wire-contracts";
import {
  queryAbsence,
  verifyAbsenceEvaluationReceipt,
} from "../src/index.js";

type AbsenceQueryRequest = Extract<ApiRequestV1, { readonly operation: "absence.query" }>;

interface AbsenceFixture {
  readonly name: string;
  readonly request: AbsenceQueryRequest;
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
}

interface AbsenceFixtures {
  readonly requests: readonly AbsenceFixture[];
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function readJsonDirectory<T>(url: URL): T[] {
  return readdirSync(url)
    .sort()
    .map((name) => readJson<T>(new URL(name, url)));
}

const payload = new URL("../../../fixtures/v1/complete-world/payload/", import.meta.url);
const world = readJson<WorldCatalogV1>(new URL("world.json", payload));
const snapshotRecord = readJson<SnapshotRecordV1>(
  new URL("../../../fixtures/v1/complete-world/snapshot.json", import.meta.url),
);
const assertions = readJsonDirectory<AssertionRecordV1>(
  new URL("records/assertions/", payload),
);
const typeDirectory = new URL("types/", payload);
const definitionsByDigest = Object.fromEntries(
  readdirSync(typeDirectory)
    .sort()
    .map((name) => ({
      digest: name.slice(0, -".json".length),
      record: readJson<SemanticDefinitionV1 | { readonly format: string }>(
        new URL(name, typeDirectory),
      ),
    }))
    .filter(
      (entry): entry is { readonly digest: string; readonly record: SemanticDefinitionV1 } =>
        entry.record.format === "wmm.semantic-definition/1",
    )
    .map((entry) => [entry.digest, entry.record]),
);
const fixtures = readJson<AbsenceFixtures>(
  new URL("../../../fixtures/v2/absence-query-cases.json", import.meta.url),
);

const querySnapshot = {
  worldId: world.worldId,
  snapshotDigest: snapshotRecord.snapshotDigest,
  activeAssertionIds: world.activeAssertionIds,
  assertions,
  definitionsByDigest,
};

describe("bounded absence querying", () => {
  for (const fixture of fixtures.requests) {
    it(fixture.name, () => {
      const result = queryAbsence(
        querySnapshot,
        fixture.request.payload.target,
        fixture.request.payload.scope,
        fixture.request.payload.temporal,
      );
      expect(result.conclusion.status).toBe(fixture.expected.conclusion);
      expect(result.conclusion.bases).toEqual(fixture.expected.bases);
      expect(result.declaration.status).toBe(fixture.expected.declaration);
      expect(result.witnesses.status).toBe(fixture.expected.witnesses);
      expect(result.derivation.status).toBe(fixture.expected.derivation);
      expect(result.derivation.reason).toBe(fixture.expected.derivationReason);
      if (fixture.expected.inputSelectionDigest !== undefined) {
        expect(result.derivation.inputSelectionDigest).toBe(
          fixture.expected.inputSelectionDigest,
        );
      }
      if (fixture.expected.evaluationDigest !== undefined) {
        expect(result.derivation.evaluationDigest).toBe(
          fixture.expected.evaluationDigest,
        );
      }
      expect(result.derivation.inputSelectionDigest).toBe(
        absenceInputSelectionDigest(result.derivation.inputSelection),
      );
      const { evaluationDigest: _digest, ...evaluationBody } = result.derivation;
      expect(result.derivation.evaluationDigest).toBe(
        absenceEvaluationDigest(evaluationBody),
      );
      expect(verifyAbsenceEvaluationReceipt(result.derivation)).toEqual({
        valid: true,
        errors: [],
      });
    });
  }

  it("detects tampering in either receipt digest boundary", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const result = queryAbsence(
      querySnapshot,
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(
      verifyAbsenceEvaluationReceipt({
        ...result.derivation,
        inputSelectionDigest: "0".repeat(64),
      }),
    ).toEqual({
      valid: false,
      errors: [
        "INPUT_SELECTION_DIGEST_MISMATCH",
        "EVALUATION_DIGEST_MISMATCH",
      ],
    });
    expect(
      verifyAbsenceEvaluationReceipt({
        ...result.derivation,
        positiveCoverageAssertionIds: [],
      }),
    ).toEqual({
      valid: false,
      errors: ["EVALUATION_DIGEST_MISMATCH"],
    });
  });

  it("keeps declaration independent when coverage is unavailable", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const withoutCoverage = assertions.filter((assertion) => {
      if (assertion.body.proposition.kind !== "atom") return true;
      return (
        definitionsByDigest[assertion.body.proposition.predicateDefinitionDigest]
          ?.operation !== "population-coverage-atom-v1"
      );
    });
    const activeIds = new Set(withoutCoverage.map((assertion) => assertion.id));
    const result = queryAbsence(
      {
        ...querySnapshot,
        activeAssertionIds: world.activeAssertionIds.filter((id) => activeIds.has(id)),
        assertions: withoutCoverage,
      },
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.conclusion).toEqual({
      status: "absence-declared",
      bases: ["declared"],
    });
    expect(result.derivation).toMatchObject({
      status: "not-established",
      reason: "coverage-not-established",
    });
  });

  it("binds the exact membership premises without including coverage in the input digest", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const result = queryAbsence(
      querySnapshot,
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.derivation.inputSelection.membershipAssertionIds).toHaveLength(2);
    expect(result.derivation.positiveCoverageAssertionIds).toHaveLength(1);
    expect(result.derivation.inputSelection.membershipAssertionIds).not.toContain(
      result.derivation.positiveCoverageAssertionIds[0],
    );
    expect(result.derivation.candidates).toEqual([
      expect.objectContaining({
        candidateId: "person:alys",
        membership: "member",
        eligibility: "ineligible",
      }),
      expect.objectContaining({
        candidateId: "person:bran",
        membership: "member",
        eligibility: "ineligible",
      }),
    ]);
  });

  it("does not derive from definite coverage and an empty selected roster", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const withoutMembership = assertions.filter((assertion) => {
      if (assertion.body.proposition.kind !== "atom") return true;
      return (
        definitionsByDigest[assertion.body.proposition.predicateDefinitionDigest]
          ?.operation !== "population-membership-atom-v1"
      );
    });
    const activeIds = new Set(withoutMembership.map((assertion) => assertion.id));
    const result = queryAbsence(
      {
        ...querySnapshot,
        activeAssertionIds: world.activeAssertionIds.filter((id) => activeIds.has(id)),
        assertions: withoutMembership,
      },
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.derivation).toMatchObject({
      status: "not-established",
      reason: "membership-not-established",
    });
    expect(result.conclusion).toEqual({
      status: "absence-declared",
      bases: ["declared"],
    });
  });

  it("blocks derivation when coverage claims conflict", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const coverage = assertions.find((assertion) => {
      if (assertion.body.proposition.kind !== "atom") return false;
      return (
        definitionsByDigest[assertion.body.proposition.predicateDefinitionDigest]
          ?.operation === "population-coverage-atom-v1"
      );
    });
    if (coverage === undefined) throw new Error("Missing coverage fixture");
    const negativeCoverage: AssertionRecordV1 = {
      ...coverage,
      id: `asrt:${"f".repeat(64)}`,
      body: { ...coverage.body, polarity: "negative" },
    };
    const result = queryAbsence(
      {
        ...querySnapshot,
        activeAssertionIds: [...world.activeAssertionIds, negativeCoverage.id],
        assertions: [...assertions, negativeCoverage],
      },
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.derivation).toMatchObject({
      status: "not-established",
      reason: "coverage-conflicted",
    });
    expect(result.conclusion.bases).toEqual(["declared"]);
  });

  it("blocks derivation when a roster member has unresolved eligibility", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const withoutAlysEligibility = assertions.filter((assertion) => {
      if (assertion.body.proposition.kind !== "atom") return true;
      const operation =
        definitionsByDigest[assertion.body.proposition.predicateDefinitionDigest]
          ?.operation;
      return !(
        operation === "criterion-satisfaction-atom-v1" &&
        assertion.body.proposition.subjectId === "person:alys"
      );
    });
    const activeIds = new Set(withoutAlysEligibility.map((assertion) => assertion.id));
    const result = queryAbsence(
      {
        ...querySnapshot,
        activeAssertionIds: world.activeAssertionIds.filter((id) => activeIds.has(id)),
        assertions: withoutAlysEligibility,
      },
      fixture.request.payload.target,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.derivation).toMatchObject({
      status: "not-established",
      reason: "candidate-eligibility-unresolved",
    });
    expect(result.derivation.candidates).toContainEqual(
      expect.objectContaining({
        candidateId: "person:alys",
        eligibility: "unresolved",
      }),
    );
  });

  it("does not weaken a bundled criterion by ignoring extra arguments", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    const result = queryAbsence(
      querySnapshot,
      {
        ...fixture.request.payload.target,
        criterion: {
          ...fixture.request.payload.target.criterion,
          arguments: {
            ...fixture.request.payload.target.criterion.arguments,
            rank: { kind: "ref", id: "person:alys" },
          },
        },
      },
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.derivation).toMatchObject({
      status: "unsupported",
      reason: "unsupported-semantics",
    });
    expect(result.conclusion.status).toBe("absence-not-established");
  });

  it("rejects interval queries at the core boundary", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing absence fixture");
    expect(() =>
      queryAbsence(
        querySnapshot,
        fixture.request.payload.target,
        fixture.request.payload.scope,
        {
          format: "wmm.temporal-query/1",
          mode: "throughout",
          axisDefinitionDigest: fixture.request.payload.temporal.axisDefinitionDigest,
          start: "1000",
          endExclusive: "1030",
        },
      ),
    ).toThrow(/exact point queries only/);
  });
});
