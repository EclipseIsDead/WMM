import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  AnySchema,
  ErrorObject,
  KeywordDefinition,
  ValidateFunction,
} from "ajv/dist/2020.js";

import { jsonDataError } from "./json-data.js";

import type {
  ApiContractV1,
  ApiRequestV1,
  ApiResponseV1,
  CoreContractV1,
  SemanticContractV1,
  WorldRecordV1,
} from "./types.js";
import type { WorkspaceReviewV1 } from "./workspace.js";

export interface CoreContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

const coreSchemaUrl = new URL("../schemas/core-contracts.schema.json", import.meta.url);
const semanticSchemaUrl = new URL(
  "../schemas/semantic-contracts.schema.json",
  import.meta.url,
);
const worldSchemaUrl = new URL(
  "../schemas/world-records.schema.json",
  import.meta.url,
);
const workspaceSchemaUrl = new URL("../schemas/workspace-v1.schema.json", import.meta.url);
const apiSchemaUrl = new URL("../schemas/api-v1.schema.json", import.meta.url);
const coreSchema = JSON.parse(readFileSync(coreSchemaUrl, "utf8")) as AnySchema;
const semanticSchema = JSON.parse(readFileSync(semanticSchemaUrl, "utf8")) as AnySchema;
const worldSchema = JSON.parse(readFileSync(worldSchemaUrl, "utf8")) as AnySchema;
const workspaceSchema = JSON.parse(readFileSync(workspaceSchemaUrl, "utf8")) as AnySchema;
const apiSchema = JSON.parse(readFileSync(apiSchemaUrl, "utf8")) as AnySchema;

interface AjvLike {
  addKeyword(definition: KeywordDefinition): AjvLike;
  addSchema(schema: AnySchema): AjvLike;
  compile<T>(schema: AnySchema): ValidateFunction<T>;
}

type AjvConstructor = new (options: Readonly<Record<string, unknown>>) => AjvLike;
type AddFormats = (ajv: AjvLike) => unknown;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as AjvConstructor;
const addFormats = require("ajv-formats") as AddFormats;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // The seed schema's conditional parent-count subschema inherits its array
  // constraint from RevisionEnvelope instead of repeating it locally.
  strictTypes: false,
  validateFormats: true,
  ownProperties: true,
});
addFormats(ajv);
// JSON Schema maxLength counts code points; authoring limits also bound JS string length.
ajv.addKeyword({
  keyword: "maxUtf16Length",
  type: "string",
  schemaType: "number",
  metaSchema: { type: "integer", minimum: 0 },
  validate: (limit: number, value: string): boolean => value.length <= limit,
  errors: false,
});

const validateCore: ValidateFunction<CoreContractV1> = ajv.compile(coreSchema);
const validateSemantic: ValidateFunction<SemanticContractV1> =
  ajv.compile(semanticSchema);
const validateWorld: ValidateFunction<WorldRecordV1> = ajv.compile(worldSchema);
// Workspace assertions reference world records, never API definitions.
ajv.addSchema(workspaceSchema);
const validateApi: ValidateFunction<ApiContractV1> = ajv.compile(apiSchema);
const validateRequest: ValidateFunction<ApiRequestV1> = ajv.compile({
  $ref: "urn:wmm:api:v1#/$defs/Request",
});
const validateResponse: ValidateFunction<ApiResponseV1> = ajv.compile({
  $ref: "urn:wmm:api:v1#/$defs/Response",
});
const validateReviewReceipt: ValidateFunction<WorkspaceReviewV1> = ajv.compile({
  $ref: "urn:wmm:workspace:v1#/$defs/WorkspaceReview",
});

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

function preflight(input: unknown): CoreContractValidationResult | undefined {
  const message = jsonDataError(input);
  return message === undefined ? undefined : {
    valid: false,
    errors: [{ keyword: "jsonData", instancePath: "", schemaPath: "#/jsonData", params: {}, message }],
  };
}

export function validateSemanticContract(input: unknown): CoreContractValidationResult {
  return preflight(input) ?? validationResult(validateSemantic(input), validateSemantic.errors);
}

export function validateWorldRecord(input: unknown): CoreContractValidationResult {
  return validationResult(validateWorld(input), validateWorld.errors);
}

export function validateApiContract(input: unknown): CoreContractValidationResult {
  return preflight(input) ?? validationResult(validateApi(input), validateApi.errors);
}

export function validateApiRequest(input: unknown): CoreContractValidationResult {
  return preflight(input) ?? validationResult(validateRequest(input), validateRequest.errors);
}

export function validateApiResponse(input: unknown): CoreContractValidationResult {
  return preflight(input) ?? validationResult(validateResponse(input), validateResponse.errors);
}

/** Shape only; digest integrity, check identity and binding freshness are verified by core. */
export function validateWorkspaceReviewReceipt(input: unknown): CoreContractValidationResult {
  return preflight(input) ?? validationResult(validateReviewReceipt(input), validateReviewReceipt.errors);
}

export function isCoreContract(input: unknown): input is CoreContractV1 {
  return validateCoreContract(input).valid;
}

export const coreContractsSchema = coreSchema;
export const semanticContractsSchema = semanticSchema;
export const worldRecordsSchema = worldSchema;
export const workspaceV1Schema = workspaceSchema;
export const apiV1Schema = apiSchema;
