import { types } from "node:util";

import {
  canonicalJson,
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import {
  assertSemanticDefinition,
  assertSemanticProfile,
} from "@wmm/schema";
import type {
  JsonValue,
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";

export type AdmissionErrorCode =
  | "FIXTURE_ONLY"
  | "UNTRUSTED_DEFINITION"
  | "UNTRUSTED_PROFILE"
  | "DUPLICATE_DEFINITION"
  | "DUPLICATE_DEFINITION_KEY"
  | "MISSING_PROFILE_DEFINITION"
  | "UNDECLARED_DEFINITION"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_CYCLE";

export class AdmissionError extends Error {
  readonly code: AdmissionErrorCode;

  constructor(code: AdmissionErrorCode, message: string) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
  }
}

export interface SemanticAdmissionRequest {
  readonly profile: SemanticProfileV1;
  readonly definitions: readonly SemanticDefinitionV1[];
  readonly trustedDefinitionDigests: ReadonlySet<string>;
  readonly trustedProfileDigests: ReadonlySet<string>;
  readonly allowFixtureOnly?: boolean;
}

export interface AdmittedSemanticProfile {
  readonly profileDigest: string;
  readonly profile: SemanticProfileV1;
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPlainDataRequest(request: SemanticAdmissionRequest): void {
  if (
    request === null ||
    typeof request !== "object" ||
    types.isProxy(request) ||
    Object.getPrototypeOf(request) !== Object.prototype
  ) {
    throw new TypeError("Semantic admission request must be an ordinary data object");
  }
  for (const key of Reflect.ownKeys(request)) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError("Semantic admission request may contain only enumerable data properties");
    }
  }
}

function assertAcyclic(
  definitions: ReadonlyMap<string, SemanticDefinitionV1>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(digest: string): void {
    if (visited.has(digest)) return;
    if (visiting.has(digest)) {
      throw new AdmissionError(
        "DEPENDENCY_CYCLE",
        `Semantic definition dependency cycle includes ${digest}`,
      );
    }

    const definition = definitions.get(digest);
    if (definition === undefined) {
      throw new AdmissionError(
        "MISSING_DEPENDENCY",
        `Semantic definition dependency is unavailable: ${digest}`,
      );
    }

    visiting.add(digest);
    for (const dependency of definition.dependencies) visit(dependency);
    visiting.delete(digest);
    visited.add(digest);
  }

  for (const digest of definitions.keys()) visit(digest);
}

export function admitSemanticProfile(
  request: SemanticAdmissionRequest,
): AdmittedSemanticProfile {
  assertPlainDataRequest(request);
  const { trustedDefinitionDigests, trustedProfileDigests, allowFixtureOnly } = request;
  // Canonicalization rejects accessors and proxies before validation or trust callbacks.
  const { profile, definitions: suppliedDefinitions } = deepFreeze(
    JSON.parse(canonicalJson({
      profile: request.profile,
      definitions: request.definitions,
    } as unknown as JsonValue)) as Pick<SemanticAdmissionRequest, "profile" | "definitions">,
  );

  assertSemanticProfile(profile);
  if (profile.fixtureOnly === true && allowFixtureOnly !== true) {
    throw new AdmissionError("FIXTURE_ONLY", "Fixture-only semantic profile is not admissible");
  }

  const profileDigest = semanticProfileDigest(profile);
  if (!trustedProfileDigests.has(profileDigest)) {
    throw new AdmissionError(
      "UNTRUSTED_PROFILE",
      `Semantic profile digest is not release-allowlisted: ${profileDigest}`,
    );
  }

  const definitions = new Map<string, SemanticDefinitionV1>();
  const definitionKeys = new Set<string>();
  for (const definition of suppliedDefinitions) {
    assertSemanticDefinition(definition);
    if (definition.fixtureOnly === true && allowFixtureOnly !== true) {
      throw new AdmissionError(
        "FIXTURE_ONLY",
        `Fixture-only semantic definition is not admissible: ${definition.key}`,
      );
    }

    const digest = semanticDefinitionDigest(definition);
    if (!trustedDefinitionDigests.has(digest)) {
      throw new AdmissionError(
        "UNTRUSTED_DEFINITION",
        `Semantic definition digest is not release-allowlisted: ${digest}`,
      );
    }
    if (definitions.has(digest)) {
      throw new AdmissionError(
        "DUPLICATE_DEFINITION",
        `Semantic definition supplied more than once: ${digest}`,
      );
    }
    if (definitionKeys.has(definition.key)) {
      throw new AdmissionError(
        "DUPLICATE_DEFINITION_KEY",
        `Semantic definition key is ambiguous: ${definition.key}`,
      );
    }

    definitionKeys.add(definition.key);
    definitions.set(digest, definition);
  }

  const declared = new Set(profile.definitions);
  for (const digest of declared) {
    if (!definitions.has(digest)) {
      throw new AdmissionError(
        "MISSING_PROFILE_DEFINITION",
        `Profile definition was not supplied: ${digest}`,
      );
    }
  }
  for (const digest of definitions.keys()) {
    if (!declared.has(digest)) {
      throw new AdmissionError(
        "UNDECLARED_DEFINITION",
        `Supplied definition is not part of the profile: ${digest}`,
      );
    }
  }

  assertAcyclic(definitions);

  const definitionsByDigest = Object.create(null) as Record<
    string,
    SemanticDefinitionV1
  >;
  for (const [digest, definition] of definitions) {
    definitionsByDigest[digest] = definition;
  }

  return deepFreeze({
    profileDigest,
    profile,
    definitionsByDigest,
  });
}
