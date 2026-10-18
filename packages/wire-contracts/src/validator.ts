import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

import type { CoreContractV1, SemanticContractV1 } from "./types.js";

export interface CoreContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

const coreSchemaUrl = new URL("../schemas/core-contracts.schema.json", import.meta.url);
const semanticSchemaUrl = new URL(
  "../schemas/semantic-contracts.schema.json",
  import.meta.url,
);
const coreSchema = JSON.parse(readFileSync(coreSchemaUrl, "utf8")) as AnySchema;
const semanticSchema = JSON.parse(readFileSync(semanticSchemaUrl, "utf8")) as AnySchema;

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // The seed schema's conditional parent-count subschema inherits its array
  // constraint from RevisionEnvelope instead of repeating it locally.
  strictTypes: false,
  validateFormats: true,
});
addFormats(ajv);

const validateCore: ValidateFunction<CoreContractV1> = ajv.compile(coreSchema);
const validateSemantic: ValidateFunction<SemanticContractV1> =
  ajv.compile(semanticSchema);

function validationResult(
  valid: boolean,
  errors: readonly ErrorObject[] | null | undefined,
): CoreContractValidationResult {
  return {
    valid,
    errors: valid ? [] : structuredClone(errors ?? []),
  };
}

export function validateCoreContract(input: unknown): CoreContractValidationResult {
  return validationResult(validateCore(input), validateCore.errors);
}

export function validateSemanticContract(input: unknown): CoreContractValidationResult {
  return validationResult(validateSemantic(input), validateSemantic.errors);
}

export function isCoreContract(input: unknown): input is CoreContractV1 {
  return validateCoreContract(input).valid;
}

export const coreContractsSchema = coreSchema;
export const semanticContractsSchema = semanticSchema;
