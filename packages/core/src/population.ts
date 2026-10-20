import { isDeepStrictEqual } from "node:util";

import { descriptorBirthDigest } from "@wmm/canonical";
import type {
  ApplicabilityV1,
  AssertionRecordV1,
  CoverageInputSelectionV1,
  DescriptorRecordV1,
  PopulationCoverageBasisV1,
  ScopeV1,
  SemanticDefinitionV1,
  TypedValueV1,
} from "@wmm/wire-contracts";
import { validateSemanticContract } from "@wmm/wire-contracts";

export interface PopulationSelectorBindingsV1 {
  readonly selectorDefinitionDigest: string;
  readonly membershipPredicateDigest: string;
  readonly candidateTypeDefinitionDigest: string;
  readonly coveragePredicateDigest: string;
}

export function resolvePopulationSelector(
  populationDefinitionDigest: string,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
): PopulationSelectorBindingsV1 | undefined {
  const population = definitions[populationDefinitionDigest];
  if (population?.kind !== "population" || population.operation !== "bundled-candidate-membership-v1" || population.dependencies.length !== 2) return undefined;
  const selectorDefinitionDigest = population.dependencies.find((digest) => definitions[digest]?.kind === "selector");
  const coveragePredicateDigest = population.dependencies.find((digest) => definitions[digest]?.operation === "population-coverage-atom-v1");
  const selector = selectorDefinitionDigest === undefined ? undefined : definitions[selectorDefinitionDigest];
  if (selector?.operation !== "bundled-candidate-selector-v1" || selector.dependencies.length !== 2 || coveragePredicateDigest === undefined) return undefined;
  const membershipPredicateDigest = selector.dependencies.find((digest) => definitions[digest]?.kind === "predicate" && definitions[digest]?.operation === "population-membership-atom-v1");
  const candidateTypeDefinitionDigest = selector.dependencies.find((digest) => definitions[digest]?.kind === "descriptorType" && definitions[digest]?.operation === "descriptor-type-v1" && definitions[digest]?.key === "person");
  if (selectorDefinitionDigest === undefined || membershipPredicateDigest === undefined || candidateTypeDefinitionDigest === undefined) return undefined;
  return { selectorDefinitionDigest, membershipPredicateDigest, candidateTypeDefinitionDigest, coveragePredicateDigest };
}

/** Coarse primitive-family selection intentionally includes every population, scope and time. */
export function selectCoverageInputs(
  worldId: string,
  populationDefinitionDigest: string,
  bindings: PopulationSelectorBindingsV1,
  scope: ScopeV1,
  applicability: ApplicabilityV1,
  activeAssertions: readonly AssertionRecordV1[],
  descriptors: readonly DescriptorRecordV1[],
): CoverageInputSelectionV1 {
  function uniqueBodies<T>(values: readonly T[], id: (value: T) => string): T[] {
    const byId = new Map<string, T>();
    for (const value of values) {
      const key = id(value);
      if (byId.has(key) && !isDeepStrictEqual(byId.get(key), value)) throw new TypeError(`Conflicting duplicate coverage input: ${key}`);
      byId.set(key, value);
    }
    return [...byId.values()];
  }
  const primitives = uniqueBodies(activeAssertions, (assertion) => assertion.id).filter((assertion) =>
    assertion.body.proposition.kind === "atom" &&
    assertion.body.proposition.predicateDefinitionDigest === bindings.membershipPredicateDigest,
  );
  const candidates = uniqueBodies(descriptors, (descriptor) => descriptor.id).filter((descriptor) =>
    descriptor.birthTypeDefinitionDigest === bindings.candidateTypeDefinitionDigest,
  );
  return {
    format: "wmm.coverage-input/1",
    worldId,
    populationDefinitionDigest,
    selectorDefinitionDigest: bindings.selectorDefinitionDigest,
    scope,
    applicability,
    primitiveClaimIds: primitives.map((assertion) => assertion.id).sort(),
    candidateBirthDigests: candidates.map(descriptorBirthDigest).sort(),
  };
}

export function populationCoverageBasis(
  value: TypedValueV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
): PopulationCoverageBasisV1 | undefined {
  if (
    value.kind !== "literal" ||
    definitions[value.valueDefinitionDigest]?.kind !== "literal" ||
    definitions[value.valueDefinitionDigest]?.operation !== "population-coverage-basis-v1" ||
    !validateSemanticContract(value.data).valid ||
    value.data === null ||
    typeof value.data !== "object" ||
    Array.isArray(value.data) ||
    !("format" in value.data) ||
    value.data["format"] !== "wmm.population-coverage-basis/1"
  ) return undefined;
  return value.data as unknown as PopulationCoverageBasisV1;
}
