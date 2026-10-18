import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";
import {
  DefinitionSemanticError,
  assertSemanticDefinition,
  assertSemanticProfile,
  validateDefinitionContract,
} from "../src/index.js";

const typesUrl = new URL(
  "../../../wmm-v0.3-contract-kit/fixture-payload/types/",
  import.meta.url,
);
const artifacts = readdirSync(typesUrl)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, typesUrl), "utf8")) as unknown);
const definitions = artifacts.filter(
  (artifact): artifact is SemanticDefinitionV1 =>
    (artifact as { format?: unknown }).format === "wmm.semantic-definition/1",
);
const profile = artifacts.find(
  (artifact): artifact is SemanticProfileV1 =>
    (artifact as { format?: unknown }).format === "wmm.semantic-profile/1",
);

if (profile === undefined) throw new Error("Seed profile fixture is missing");

describe("semantic definition contracts", () => {
  it("accepts every bounded seed definition and profile shape", () => {
    expect(definitions).toHaveLength(7);
    for (const definition of definitions) {
      expect(validateDefinitionContract(definition)).toEqual({ valid: true, errors: [] });
      expect(() => assertSemanticDefinition(definition)).not.toThrow();
    }
    expect(validateDefinitionContract(profile)).toEqual({ valid: true, errors: [] });
    expect(() => assertSemanticProfile(profile)).not.toThrow();
  });

  it("rejects unknown operations and extension fields structurally", () => {
    const unknownOperation = { ...definitions[0], operation: "run-user-code-v1" };
    expect(validateDefinitionContract(unknownOperation).valid).toBe(false);

    const extension = { ...definitions[0], remoteSchema: "https://example.invalid" };
    expect(validateDefinitionContract(extension).valid).toBe(false);
  });

  it("rejects operation and kind mismatches semantically", () => {
    const predicate = definitions.find((definition) => definition.kind === "predicate");
    if (predicate === undefined) throw new Error("Predicate fixture is missing");
    const mismatch: SemanticDefinitionV1 = {
      ...predicate,
      kind: "axis",
    };
    expect(() => assertSemanticDefinition(mismatch)).toThrowError(
      expect.objectContaining<Partial<DefinitionSemanticError>>({
        code: "KIND_OPERATION_MISMATCH",
      }),
    );
  });

  it("requires canonical ordering for dependency and profile sets", () => {
    const base = definitions[0];
    if (base === undefined) throw new Error("Definition fixture is missing");
    const unsortedDefinition: SemanticDefinitionV1 = {
      ...base,
      dependencies: ["b".repeat(64), "a".repeat(64)],
    };
    expect(() => assertSemanticDefinition(unsortedDefinition)).toThrowError(
      expect.objectContaining<Partial<DefinitionSemanticError>>({
        code: "UNSORTED_DEPENDENCIES",
      }),
    );

    const unsortedProfile: SemanticProfileV1 = {
      ...profile,
      definitions: [...profile.definitions].reverse(),
    };
    expect(() => assertSemanticProfile(unsortedProfile)).toThrowError(
      expect.objectContaining<Partial<DefinitionSemanticError>>({
        code: "UNSORTED_PROFILE_DEFINITIONS",
      }),
    );
  });
});
