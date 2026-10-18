import {
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import type {
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";

import { admitSemanticProfile } from "./admission.js";

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
    dependencies: [],
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
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "office",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
  {
    format: "wmm.semantic-definition/1",
    key: "person",
    kind: "descriptorType",
    operation: "descriptor-type-v1",
    version: "1",
    dependencies: [],
  },
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

let cached: BundledV1Semantics | undefined;

export function bundledV1Semantics(): BundledV1Semantics {
  if (cached !== undefined) return cached;

  const definitionsByKey: Record<string, SemanticDefinitionV1> = Object.create(null);
  const definitionDigestsByKey: Record<string, string> = Object.create(null);
  for (const definition of definitions) {
    definitionsByKey[definition.key] = definition;
    definitionDigestsByKey[definition.key] = semanticDefinitionDigest(definition);
  }

  const definitionDigests = Object.values(definitionDigestsByKey).sort();
  const profile: SemanticProfileV1 = {
    format: "wmm.semantic-profile/1",
    version: "1",
    definitions: definitionDigests,
    numericProfile: "safe-integer-json-v1",
    propositionGrammar: "explicit-polarity-atom-exists-v1",
  };
  const profileDigest = semanticProfileDigest(profile);
  const trustedDefinitionDigests = new Set(definitionDigests);
  const trustedProfileDigests = new Set([profileDigest]);

  admitSemanticProfile({
    profile,
    definitions,
    trustedDefinitionDigests,
    trustedProfileDigests,
  });

  cached = Object.freeze({
    definitions: Object.freeze([...definitions]),
    definitionsByKey: Object.freeze(definitionsByKey),
    definitionDigestsByKey: Object.freeze(definitionDigestsByKey),
    profile: Object.freeze(profile),
    profileDigest,
    trustedDefinitionDigests,
    trustedProfileDigests,
  });
  return cached;
}
