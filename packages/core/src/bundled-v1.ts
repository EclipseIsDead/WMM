import {
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import type {
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";

import { admitSemanticProfile } from "./admission.js";

const candidateMembershipDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "candidate_membership",
  kind: "predicate",
  operation: "population-membership-atom-v1",
  version: "1",
  dependencies: [],
};

const eligibilitySatisfactionDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "eligibility_satisfaction",
  kind: "predicate",
  operation: "criterion-satisfaction-atom-v1",
  version: "1",
  dependencies: [],
};

const personDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "person",
  kind: "descriptorType",
  operation: "descriptor-type-v1",
  version: "1",
  dependencies: [],
};

const candidateSelectorDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "candidate_selector",
  kind: "selector",
  operation: "bundled-candidate-selector-v1",
  version: "1",
  dependencies: [
    semanticDefinitionDigest(candidateMembershipDefinition),
    semanticDefinitionDigest(personDefinition),
  ].sort(),
};

const populationCoverageBasisDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "population_coverage_basis",
  kind: "literal",
  operation: "population-coverage-basis-v1",
  version: "1",
  dependencies: [],
};

const populationCoverageDefinition: SemanticDefinitionV1 = {
  format: "wmm.semantic-definition/1",
  key: "population_coverage",
  kind: "predicate",
  operation: "population-coverage-atom-v1",
  version: "2",
  dependencies: [semanticDefinitionDigest(populationCoverageBasisDefinition)],
};

const definitions: readonly SemanticDefinitionV1[] = [
  {
    format: "wmm.semantic-definition/1",
    key: "account",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "allied_with",
    kind: "predicate",
    operation: "exact-tuple-multivalue-v1",
    version: "1",
    dependencies: [],
  },
  candidateMembershipDefinition,
  candidateSelectorDefinition,
  eligibilitySatisfactionDefinition,
  populationCoverageBasisDefinition,
  populationCoverageDefinition,
  {
    format: "wmm.semantic-definition/1",
    key: "author_stipulation_interpretation",
    kind: "interpretation",
    operation: "author-stipulation-interpretation-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "author_stipulation_locator",
    kind: "locator",
    operation: "author-stipulation-locator-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "candidates",
    kind: "population",
    operation: "bundled-candidate-membership-v1",
    version: "1",
    dependencies: [
      semanticDefinitionDigest(candidateSelectorDefinition),
      semanticDefinitionDigest(populationCoverageDefinition),
    ].sort(),
  },
  {
    format: "wmm.semantic-definition/1",
    key: "days",
    kind: "axis",
    operation: "integer-chronon-half-open-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "eligible",
    kind: "criterion",
    operation: "bundled-eligibility-v1",
    version: "1",
    dependencies: [semanticDefinitionDigest(eligibilitySatisfactionDefinition)],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "office",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
  personDefinition,
  {
    format: "wmm.semantic-definition/1",
    key: "polity",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "population",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "recognition_frame",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
];

export interface BundledV1Semantics {
  readonly definitions: readonly SemanticDefinitionV1[];
  readonly definitionsByKey: Readonly<Record<string, SemanticDefinitionV1>>;
  readonly definitionDigestsByKey: Readonly<Record<string, string>>;
  readonly profile: SemanticProfileV1;
  readonly profileDigest: string;
  readonly trustedDefinitionDigests: ReadonlySet<string>;
  readonly trustedProfileDigests: ReadonlySet<string>;
}

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const backing = new Set(values);
  const view: ReadonlySet<T> = Object.freeze({
    get size() { return backing.size; },
    has(value: T) { return backing.has(value); },
    entries() { return backing.entries(); },
    keys() { return backing.keys(); },
    values() { return backing.values(); },
    [Symbol.iterator]() { return backing[Symbol.iterator](); },
    forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) {
      backing.forEach((value) => callback.call(thisArg, value, value, view));
    },
  });
  return view;
}

let cached: BundledV1Semantics | undefined;

export function bundledV1Semantics(): BundledV1Semantics {
  if (cached !== undefined) return cached;

  const definitionDigests = definitions.map(semanticDefinitionDigest).sort();
  const profile: SemanticProfileV1 = {
    format: "wmm.semantic-profile/1",
    version: "1",
    definitions: definitionDigests,
    numericProfile: "safe-integer-json-v1",
    propositionGrammar: "explicit-polarity-atom-exists-v1",
  };
  const profileDigest = semanticProfileDigest(profile);
  const trustedDefinitionDigests = readonlySet(definitionDigests);
  const trustedProfileDigests = readonlySet([profileDigest]);

  const admitted = admitSemanticProfile({
    profile,
    definitions,
    trustedDefinitionDigests,
    trustedProfileDigests,
  });

  const definitionsByKey: Record<string, SemanticDefinitionV1> = Object.create(null);
  const definitionDigestsByKey: Record<string, string> = Object.create(null);
  for (const [digest, definition] of Object.entries(admitted.definitionsByDigest)) {
    definitionsByKey[definition.key] = definition;
    definitionDigestsByKey[definition.key] = digest;
  }

  cached = Object.freeze({
    definitions: Object.freeze(Object.values(admitted.definitionsByDigest)),
    definitionsByKey: Object.freeze(definitionsByKey),
    definitionDigestsByKey: Object.freeze(definitionDigestsByKey),
    profile: admitted.profile,
    profileDigest: admitted.profileDigest,
    trustedDefinitionDigests,
    trustedProfileDigests,
  });
  return cached;
}
