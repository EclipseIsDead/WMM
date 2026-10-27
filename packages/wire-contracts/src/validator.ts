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
import type { AuthoringIndex, AuthoringProject } from "./authoring.js";
import type { EntityContextPacket, EntityContextRequest } from "./entity-context.js";
import type { Atlas, WorkspaceMapView } from "./atlas.js";
import type { ActorBrief, ActorContextPacket, ActorDecisionDraft, ActorDecisionReview } from "./actor.js";
import type { ExactRational, Quantity, QuantityMagnitude } from "./measurement.js";
import type { AuthoringEconomy, EconomicRecordValue, EconomyView, WorkspaceEconomyView } from "./economy.js";

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
const atlasSchema = JSON.parse(readFileSync(new URL("../schemas/atlas.schema.json", import.meta.url), "utf8")) as AnySchema;
const apiSchema = JSON.parse(readFileSync(apiSchemaUrl, "utf8")) as AnySchema;
const authoringSchema = JSON.parse(readFileSync(new URL("../schemas/authoring.schema.json", import.meta.url), "utf8")) as AnySchema;
export const measurementSchema = JSON.parse(readFileSync(new URL("../schemas/measurement.schema.json", import.meta.url), "utf8")) as AnySchema;
export const economySchema = JSON.parse(readFileSync(new URL("../schemas/economy.schema.json", import.meta.url), "utf8")) as AnySchema;

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
// These resource limits apply wherever an Atlas is nested (API and authoring too).
// Public validators run the plain-data preflight before invoking these keywords.
ajv.addKeyword({
  keyword: "maxJsonBytes", type: "object", schemaType: "number",
  metaSchema: { type: "integer", minimum: 0 },
  validate: (limit: number, value: object): boolean => Buffer.byteLength(JSON.stringify(value), "utf8") <= limit,
  errors: false,
});
ajv.addKeyword({
  keyword: "maxAtlasVertices", type: "object", schemaType: "number",
  metaSchema: { type: "integer", minimum: 0 },
  validate: (limit: number, value: Record<string, unknown>): boolean => {
    let vertices = 0;
    for (const field of ["physicalCoverage", "features"]) {
      const records = value[field];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const geometry = record?.geometry;
        if (geometry?.kind === "polygon" && Array.isArray(geometry.vertices)) vertices += geometry.vertices.length;
        else if (geometry?.kind === "point") vertices += 1;
        if (vertices > limit) return false;
      }
    }
    return true;
  },
  errors: false,
});

const validateCore: ValidateFunction<CoreContractV1> = ajv.compile(coreSchema);
const validateSemantic: ValidateFunction<SemanticContractV1> =
  ajv.compile(semanticSchema);
const validateWorld: ValidateFunction<WorldRecordV1> = ajv.compile(worldSchema);
// Register shared measurements before all potential authoring/API consumers.
ajv.addSchema(measurementSchema);
const validateRationalShape = ajv.compile<ExactRational>({ $ref: "urn:wmm:measurement#/$defs/ExactRational" });
const validateMagnitudeShape = ajv.compile<QuantityMagnitude>({ $ref: "urn:wmm:measurement#/$defs/QuantityMagnitude" });
const validateQuantityShape = ajv.compile<Quantity>({ $ref: "urn:wmm:measurement#/$defs/Quantity" });
// Workspace assertions reference world records, never API definitions.
ajv.addSchema(workspaceSchema);
// Atlas must precede both API and the optional authoring-project atlas reference.
ajv.addSchema(atlasSchema);
// Register the complete cyclic authoring/economy registry before compiling consumers.
ajv.addSchema(authoringSchema);
ajv.addSchema(economySchema);
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
const validateAtlasRecord = ajv.compile<Atlas>({ $ref: "urn:wmm:atlas:v1#/$defs/Atlas" });
const validateMapView = ajv.compile<WorkspaceMapView>({ $ref: "urn:wmm:atlas:v1#/$defs/WorkspaceMapView" });
const validateProject = ajv.compile<AuthoringProject>({ $ref: "urn:wmm:authoring#/$defs/Project" });
const validateEconomy = ajv.compile<AuthoringEconomy>({ $ref: "urn:wmm:economy#/$defs/AuthoringEconomy" });
const validateEconomicValue = ajv.compile<EconomicRecordValue>({ $ref: "urn:wmm:economy#/$defs/EconomicRecordValue" });
const validateEconomicView = ajv.compile<EconomyView>({ $ref: "urn:wmm:economy#/$defs/EconomyView" });
const validateWorkspaceEconomicView = ajv.compile<WorkspaceEconomyView>({ $ref: "urn:wmm:economy#/$defs/WorkspaceEconomyView" });
const validateIndex = ajv.compile<AuthoringIndex>({ $ref: "urn:wmm:authoring#/$defs/Index" });
const entityContextSchema = JSON.parse(readFileSync(new URL("../schemas/entity-context.schema.json", import.meta.url), "utf8")) as AnySchema;
ajv.addSchema(entityContextSchema);
const validateContextRequest = ajv.compile<EntityContextRequest>({ $ref: "urn:wmm:entity-context#/$defs/Request" });
const validateContextPacket = ajv.compile<EntityContextPacket>({ $ref: "urn:wmm:entity-context#/$defs/Packet" });
export const actorWorkflowSchema = JSON.parse(readFileSync(new URL("../schemas/actor.schema.json", import.meta.url), "utf8")) as AnySchema;
ajv.addSchema(actorWorkflowSchema);
const validateActorBriefRecord = ajv.compile<ActorBrief>({ $ref: "urn:wmm:actor#/$defs/Brief" });
const validateActorContextRecord = ajv.compile<ActorContextPacket>({ $ref: "urn:wmm:actor#/$defs/Context" });
const validateActorDecisionRecord = ajv.compile<ActorDecisionDraft>({ $ref: "urn:wmm:actor#/$defs/Decision" });
const validateActorReviewRecord = ajv.compile<ActorDecisionReview>({ $ref: "urn:wmm:actor#/$defs/Review" });

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

function validatePlainData(input: unknown, validate: ValidateFunction): CoreContractValidationResult {
  const failure = preflight(input);
  if (failure !== undefined) return failure;
  // Only clone after descriptor-safe admission. Ajv and resource keywords must
  // inspect indexed array data, not caller-owned inherited hooks or iterators.
  return validationResult(validate(structuredClone(input)), validate.errors);
}

export function validateSemanticContract(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateSemantic);
}

/** Plain-data shape only; core checks canonical reduction (including zero 0/1). */
export function validateExactRational(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateRationalShape);
}

/** Plain-data shape only; core checks inclusive endpoint ordering. */
export function validateQuantityMagnitude(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateMagnitudeShape);
}

/** Plain-data shape only; not arithmetic validity or release-owned unit admission. */
export function validateQuantity(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateQuantityShape);
}

export function validateWorldRecord(input: unknown): CoreContractValidationResult {
  return validationResult(validateWorld(input), validateWorld.errors);
}

export function validateApiContract(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateApi);
}

export function validateApiRequest(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateRequest);
}

export function validateApiResponse(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateResponse);
}

/** Shape only; digest integrity, check identity and binding freshness are verified by core. */
export function validateWorkspaceReviewReceipt(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateReviewReceipt);
}

export function validateAuthoringProject(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateProject);
}

export function validateAuthoringIndex(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateIndex);
}

/** Shape/resource admission only; core separately verifies geometry and captured-world references. */
export function validateAtlas(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateAtlasRecord);
}

export function validateWorkspaceMapView(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateMapView);
}

export const authoringProjectSchema = authoringSchema;

/** Shape/plain-data only; core admits quantities, references and domain meaning. */
export function validateAuthoringEconomy(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateEconomy);
}
export function validateEconomicRecordValue(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateEconomicValue);
}
export function validateEconomyView(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateEconomicView);
}
/** Shape/plain-data only; the application binds the exact retained workspace base. */
export function validateWorkspaceEconomyView(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateWorkspaceEconomicView);
}

export function validateEntityContextRequest(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateContextRequest);
}

/** Shape only; packet identity, selection and provenance require integrity/replay checks. */
export function validateEntityContextPacket(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateContextPacket);
}

export const entityContextPacketSchema = entityContextSchema;

/** Shape/plain-data admission only; core checks binding, references and budgets. */
export function validateActorBrief(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateActorBriefRecord);
}
export function validateActorContextPacket(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateActorContextRecord);
}
export function validateActorDecisionDraft(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateActorDecisionRecord);
}
export function validateActorDecisionReview(input: unknown): CoreContractValidationResult {
  return validatePlainData(input, validateActorReviewRecord);
}

export function isCoreContract(input: unknown): input is CoreContractV1 {
  return validateCoreContract(input).valid;
}

export const coreContractsSchema = coreSchema;
export const semanticContractsSchema = semanticSchema;
export const worldRecordsSchema = worldSchema;
export const workspaceV1Schema = workspaceSchema;
export const apiV1Schema = apiSchema;
export { atlasSchema };
