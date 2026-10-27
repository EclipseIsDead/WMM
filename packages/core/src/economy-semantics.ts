import { semanticDefinitionDigest, semanticProfileDigest } from "@wmm/canonical";
import type { SemanticDefinitionV1, SemanticProfileV1 } from "@wmm/wire-contracts";
import { admitSemanticProfile } from "./admission.js";
import { authoringSemantics } from "./authoring-semantics.js";

function createEconomySemantics() {
  const literal: SemanticDefinitionV1 = {
    format: "wmm.semantic-definition/1", key: "economic_record_value", kind: "literal",
    operation: "economic-record-literal-v1", version: "1", dependencies: [],
  };
  const predicate: SemanticDefinitionV1 = {
    format: "wmm.semantic-definition/1", key: "economic_record", kind: "predicate",
    operation: "economic-record-atom-v1", version: "1", dependencies: [semanticDefinitionDigest(literal)],
  };
  const definitions = [...authoringSemantics().definitions, literal, predicate];
  const digests = definitions.map(semanticDefinitionDigest).sort();
  const profile: SemanticProfileV1 = { ...authoringSemantics().profile, definitions: digests };
  const admitted = admitSemanticProfile({ profile, definitions, trustedDefinitionDigests: new Set(digests), trustedProfileDigests: new Set([semanticProfileDigest(profile)]) });
  return Object.freeze({ ...admitted, definitions: Object.freeze(Object.values(admitted.definitionsByDigest)),
    definitionDigestsByKey: Object.freeze(Object.fromEntries(Object.entries(admitted.definitionsByDigest).map(([digest, definition]) => [definition.key, digest]))),
  });
}
let cached: ReturnType<typeof createEconomySemantics> | undefined;
/** Explicit opt-in; never change authoringSemantics() or its identity. */
export function economySemantics(): ReturnType<typeof createEconomySemantics> { return cached ??= createEconomySemantics(); }
