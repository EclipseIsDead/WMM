import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import {
  AdmissionError,
  admitSemanticProfile,
  aggregateEvidenceStatus,
  aggregateFamilySupport,
  compareScope,
  type EvidenceContribution,
  type FamilyContribution,
} from "@wmm/core";
import {
  TemporalInputError,
  evaluateApplicability,
} from "@wmm/temporal";
import {
  type ApplicabilityV1,
  type ScopeV1,
  type SemanticDefinitionV1,
  type SemanticProfileV1,
  type TemporalComparisonV1,
  type TemporalQueryV1,
  validateSemanticContract,
} from "@wmm/wire-contracts";

import {
  type ContractKitVerificationReport,
  verifyContractKit,
} from "./verify-contract-kit.js";

interface SemanticCases {
  readonly scopeCases: readonly {
    readonly name: string;
    readonly left: ScopeV1;
    readonly right: ScopeV1;
    readonly expected: unknown;
  }[];
  readonly evidenceCases: readonly {
    readonly name: string;
    readonly contributions: readonly EvidenceContribution[];
    readonly expected: unknown;
  }[];
  readonly familyCases: readonly {
    readonly name: string;
    readonly contributions: readonly FamilyContribution[];
    readonly expected: unknown;
  }[];
  readonly temporalCases: readonly {
    readonly name: string;
    readonly applicability: ApplicabilityV1;
    readonly query: TemporalQueryV1;
    readonly expected: TemporalComparisonV1;
  }[];
  readonly temporalInvalidCases: readonly {
    readonly name: string;
    readonly applicability: ApplicabilityV1;
    readonly query: TemporalQueryV1;
    readonly errorCode: string;
  }[];
  readonly semanticSchemaPositiveCases: readonly unknown[];
  readonly semanticSchemaNegativeCases: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
}

export interface V0VerificationReport {
  readonly status: "passed";
  readonly identity: ContractKitVerificationReport;
  readonly scopeCases: number;
  readonly evidenceCases: number;
  readonly familyCases: number;
  readonly temporalCases: number;
  readonly temporalInvalidCases: number;
  readonly semanticSchemaPositiveCases: number;
  readonly semanticSchemaNegativeCases: number;
  readonly admittedFixtureDefinitions: number;
  readonly ordinaryRuntimeRejectedFixtureProfile: true;
}

function assertDeepEqual(actual: unknown, expected: unknown, name: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${name}: semantic output differs from its golden result`);
  }
}

function verifyFixtureAdmission(kitPath: string): number {
  const typesPath = resolve(kitPath, "fixture-payload/types");
  const artifacts = readdirSync(typesPath)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(typesPath, name), "utf8")) as unknown);
  const definitions = artifacts.filter(
    (artifact): artifact is SemanticDefinitionV1 =>
      (artifact as { format?: unknown }).format === "wmm.semantic-definition/1",
  );
  const profile = artifacts.find(
    (artifact): artifact is SemanticProfileV1 =>
      (artifact as { format?: unknown }).format === "wmm.semantic-profile/1",
  );
  if (profile === undefined) throw new Error("Fixture semantic profile is missing");

  const request = {
    profile,
    definitions,
    trustedDefinitionDigests: new Set(definitions.map(semanticDefinitionDigest)),
    trustedProfileDigests: new Set([semanticProfileDigest(profile)]),
  } as const;

  const admitted = admitSemanticProfile({ ...request, allowFixtureOnly: true });
  if (Object.keys(admitted.definitionsByDigest).length !== definitions.length) {
    throw new Error("Fixture semantic admission lost a definition");
  }

  try {
    admitSemanticProfile(request);
    throw new Error("Ordinary runtime admission accepted fixture-only semantics");
  } catch (error) {
    if (!(error instanceof AdmissionError) || error.code !== "FIXTURE_ONLY") throw error;
  }

  return definitions.length;
}

export function verifyV0Contracts(
  kitPath: string,
  semanticCasesPath: string,
): V0VerificationReport {
  const identity = verifyContractKit(kitPath);
  const admittedFixtureDefinitions = verifyFixtureAdmission(kitPath);
  const cases = JSON.parse(readFileSync(semanticCasesPath, "utf8")) as SemanticCases;
  const generatedPositiveCases: unknown[] = [];

  for (const testCase of cases.scopeCases) {
    const result = compareScope(testCase.left, testCase.right);
    assertDeepEqual(result, testCase.expected, testCase.name);
    generatedPositiveCases.push(result);
  }

  for (const testCase of cases.evidenceCases) {
    const result = aggregateEvidenceStatus(testCase.contributions);
    assertDeepEqual(result, testCase.expected, testCase.name);
    generatedPositiveCases.push(result);
  }

  for (const testCase of cases.familyCases) {
    const result = aggregateFamilySupport(testCase.contributions);
    assertDeepEqual(result, testCase.expected, testCase.name);
    generatedPositiveCases.push(result);
  }

  for (const testCase of cases.temporalCases) {
    const result = evaluateApplicability(testCase.applicability, testCase.query);
    assertDeepEqual(result, testCase.expected, testCase.name);
    generatedPositiveCases.push(testCase.query, result);
  }

  for (const testCase of cases.temporalInvalidCases) {
    try {
      evaluateApplicability(testCase.applicability, testCase.query);
      throw new Error(`${testCase.name}: expected temporal input rejection`);
    } catch (error) {
      if (!(error instanceof TemporalInputError) || error.code !== testCase.errorCode) {
        throw error;
      }
    }
  }

  const positiveCases = [...cases.semanticSchemaPositiveCases, ...generatedPositiveCases];
  for (const payload of positiveCases) {
    const validation = validateSemanticContract(payload);
    if (!validation.valid) {
      throw new Error(`Positive semantic schema case failed: ${JSON.stringify(validation.errors)}`);
    }
  }

  for (const testCase of cases.semanticSchemaNegativeCases) {
    if (validateSemanticContract(testCase.payload).valid) {
      throw new Error(`${testCase.name}: forbidden semantic shape was accepted`);
    }
  }

  return {
    status: "passed",
    identity,
    scopeCases: cases.scopeCases.length,
    evidenceCases: cases.evidenceCases.length,
    familyCases: cases.familyCases.length,
    temporalCases: cases.temporalCases.length,
    temporalInvalidCases: cases.temporalInvalidCases.length,
    semanticSchemaPositiveCases: positiveCases.length,
    semanticSchemaNegativeCases: cases.semanticSchemaNegativeCases.length,
    admittedFixtureDefinitions,
    ordinaryRuntimeRejectedFixtureProfile: true,
  };
}
