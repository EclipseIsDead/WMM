import { semanticDefinitionDigest, semanticProfileDigest } from "@wmm/canonical";
import type { SemanticDefinitionV1, SemanticOperationV1, SemanticDefinitionKindV1, SemanticProfileV1 } from "@wmm/wire-contracts";
import { admitSemanticProfile } from "./admission.js";
import { bundledV1Semantics } from "./bundled-v1.js";

function definition(key: string, kind: SemanticDefinitionKindV1, operation: SemanticOperationV1): SemanticDefinitionV1 {
  return { format: "wmm.semantic-definition/1", key, kind, operation, version: "1", dependencies: [] };
}

const additions = [
  ...["faction", "place", "item", "event", "concept", "campaign", "track"].map((key) => definition(key, "descriptorType", "descriptor-type-v1")),
  ...["related_to", "located_in", "member_of", "opposed_to", "track_subject"].map((key) => definition(key, "predicate", "exact-tuple-multivalue-v1")),
  definition("safe_integer", "literal", "safe-integer-literal-v1"),
  ...["track_value", "track_minimum", "track_maximum"].map((key) => definition(key, "predicate", "integer-value-v1")),
];

function createAuthoringSemantics() {
  // Additive release-owned vocabulary. Never change the existing profile or trust imported definitions.
  const definitions = [...bundledV1Semantics().definitions, ...additions];
  const digests = definitions.map(semanticDefinitionDigest).sort();
  const profile: SemanticProfileV1 = {
    format: "wmm.semantic-profile/1", version: "1", definitions: digests,
    numericProfile: "safe-integer-json-v1", propositionGrammar: "explicit-polarity-atom-exists-v1",
  };
  const admitted = admitSemanticProfile({
    profile, definitions, trustedDefinitionDigests: new Set(digests),
    trustedProfileDigests: new Set([semanticProfileDigest(profile)]),
  });
  return Object.freeze({
    ...admitted,
    definitions: Object.freeze(Object.values(admitted.definitionsByDigest)),
    definitionDigestsByKey: Object.freeze(Object.fromEntries(Object.entries(admitted.definitionsByDigest).map(([digest, body]) => [body.key, digest]))),
  });
}

let cached: ReturnType<typeof createAuthoringSemantics> | undefined;
export function authoringSemantics(): ReturnType<typeof createAuthoringSemantics> {
  return cached ??= createAuthoringSemantics();
}
