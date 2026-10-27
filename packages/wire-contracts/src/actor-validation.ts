import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AnySchema, KeywordDefinition, ValidateFunction } from "ajv/dist/2020.js";

import type { ActorBrief, ActorContextPacket, ActorDecisionDraft, ActorDecisionReview } from "./actor.js";
import { jsonDataError } from "./json-data.js";
import type { CoreContractValidationResult } from "./validator.js";

interface AjvLike {
  addKeyword(definition: KeywordDefinition): AjvLike;
  addSchema(schema: AnySchema): AjvLike;
  compile<T>(schema: AnySchema): ValidateFunction<T>;
}
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020") as new (options: Readonly<Record<string, unknown>>) => AjvLike;
const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });
ajv.addKeyword({ keyword: "maxUtf16Length", type: "string", schemaType: "number", metaSchema: { type: "integer", minimum: 0 }, validate: (limit: number, value: string) => value.length <= limit, errors: false });
ajv.addSchema(JSON.parse(readFileSync(new URL("../schemas/authoring.schema.json", import.meta.url), "utf8")) as AnySchema);
export const actorWorkflowSchema = JSON.parse(readFileSync(new URL("../schemas/actor.schema.json", import.meta.url), "utf8")) as AnySchema;
ajv.addSchema(actorWorkflowSchema);
const brief = ajv.compile<ActorBrief>({ $ref: "urn:wmm:actor#/$defs/Brief" });
const context = ajv.compile<ActorContextPacket>({ $ref: "urn:wmm:actor#/$defs/Context" });
const decision = ajv.compile<ActorDecisionDraft>({ $ref: "urn:wmm:actor#/$defs/Decision" });
const review = ajv.compile<ActorDecisionReview>({ $ref: "urn:wmm:actor#/$defs/Review" });

function validate<T>(input: unknown, validator: ValidateFunction<T>): CoreContractValidationResult {
  const message = jsonDataError(input);
  if (message !== undefined) return { valid: false, errors: [{ keyword: "jsonData", instancePath: "", schemaPath: "#/jsonData", params: {}, message }] };
  const valid = validator(input);
  return { valid, errors: valid ? [] : structuredClone(validator.errors ?? []) };
}
/** Shape/plain-data admission only; core checks binding, references and budgets. */
export function validateActorBrief(input: unknown): CoreContractValidationResult { return validate(input, brief); }
export function validateActorContextPacket(input: unknown): CoreContractValidationResult { return validate(input, context); }
export function validateActorDecisionDraft(input: unknown): CoreContractValidationResult { return validate(input, decision); }
export function validateActorDecisionReview(input: unknown): CoreContractValidationResult { return validate(input, review); }
