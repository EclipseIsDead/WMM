import { readFileSync } from "node:fs";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type {
  SemanticDefinitionKindV1,
  SemanticDefinitionV1,
  SemanticOperationV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";

export interface DefinitionValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export type DefinitionSemanticErrorCode =
  | "KIND_OPERATION_MISMATCH"
  | "UNSORTED_DEPENDENCIES"
  | "UNSORTED_PROFILE_DEFINITIONS";

export class DefinitionSemanticError extends TypeError {
  readonly code: DefinitionSemanticErrorCode;

  constructor(code: DefinitionSemanticErrorCode, message: string) {
    super(message);
    this.name = "DefinitionSemanticError";
    this.code = code;
  }
}

const allowedOperations: Readonly<
  Record<SemanticDefinitionKindV1, ReadonlySet<SemanticOperationV1>>
> = {
  predicate: new Set([
    "exact-tuple-multivalue-v1",
    "text-value-v1",
    "integer-value-v1",
    "economic-record-atom-v1",
    "population-coverage-atom-v1",
    "population-membership-atom-v1",
    "criterion-satisfaction-atom-v1",
  ]),
  literal: new Set(["retained-unicode-v1", "safe-integer-literal-v1", "population-coverage-basis-v1", "economic-record-literal-v1"]),
  population: new Set(["bundled-candidate-membership-v1"]),
  selector: new Set(["bundled-candidate-selector-v1"]),
  criterion: new Set(["bundled-eligibility-v1"]),
  axis: new Set(["integer-chronon-half-open-v1"]),
  descriptorType: new Set(["descriptor-type-v1"]),
  locator: new Set(["author-stipulation-locator-v1"]),
  interpretation: new Set(["author-stipulation-interpretation-v1"]),
};

const schemaUrl = new URL(
  "../schemas/semantic-definitions.schema.json",
  import.meta.url,
);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as AnySchema;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate: ValidateFunction<SemanticDefinitionV1 | SemanticProfileV1> =
  ajv.compile(schema);

export function validateDefinitionContract(input: unknown): DefinitionValidationResult {
  const valid = validate(input);
  return {
    valid,
    errors: valid ? [] : structuredClone(validate.errors ?? []),
  };
}

function isStrictlySorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
}

export function assertSemanticDefinition(
  definition: SemanticDefinitionV1,
): void {
  const validation = validateDefinitionContract(definition);
  if (!validation.valid) {
    throw new TypeError(`Invalid semantic definition shape: ${JSON.stringify(validation.errors)}`);
  }
  if (!allowedOperations[definition.kind].has(definition.operation)) {
    throw new DefinitionSemanticError(
      "KIND_OPERATION_MISMATCH",
      `Operation ${definition.operation} is not admitted for ${definition.kind}`,
    );
  }
  if (!isStrictlySorted(definition.dependencies)) {
    throw new DefinitionSemanticError(
      "UNSORTED_DEPENDENCIES",
      "Definition dependencies must be strictly ASCII sorted",
    );
  }
}

export function assertSemanticProfile(profile: SemanticProfileV1): void {
  const validation = validateDefinitionContract(profile);
  if (!validation.valid) {
    throw new TypeError(`Invalid semantic profile shape: ${JSON.stringify(validation.errors)}`);
  }
  if (!isStrictlySorted(profile.definitions)) {
    throw new DefinitionSemanticError(
      "UNSORTED_PROFILE_DEFINITIONS",
      "Profile definitions must be strictly ASCII sorted",
    );
  }
}

export const semanticDefinitionsSchema = schema;
