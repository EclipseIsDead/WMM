import { isDeepStrictEqual } from "node:util";

import { assertValidApplicability } from "@wmm/temporal";
import { populationRosterDigest } from "@wmm/canonical";
import { MAX_ECONOMIC_RECORDS, validateSemanticContract } from "@wmm/wire-contracts";
import { populationCoverageBasis, resolvePopulationSelector } from "./population.js";
import { admitEconomicRecordValue, EconomyError } from "./economy.js";
import { authoringSemantics } from "./authoring-semantics.js";
import type {
  AssertionRecordV1,
  DescriptorRecordV1,
  SemanticDefinitionV1,
  RosterV1,
  SourceRecordV1,
  SupportRecordV1,
  TypedValueV1,
  WorldCatalogV1,
} from "@wmm/wire-contracts";

const AUTHORED_ENTITY_TYPES = ["person", "faction", "place", "item", "event", "concept"] as const;

export type WorldValidationErrorCode =
  | "UNSORTED_SET"
  | "ACTIVE_NOT_CATALOGUED"
  | "WORLD_MISMATCH"
  | "PROFILE_MISMATCH"
  | "UNKNOWN_REFERENCE"
  | "DEFINITION_ROLE_MISMATCH"
  | "INVALID_OPERATION_VALUE"
  | "SOURCE_DIGEST_MISMATCH";

export class WorldValidationError extends Error {
  readonly code: WorldValidationErrorCode;

  constructor(code: WorldValidationErrorCode, message: string) {
    super(message);
    this.name = "WorldValidationError";
    this.code = code;
  }
}

export interface WorldSemanticInput {
  readonly world: WorldCatalogV1;
  readonly definitionsByDigest: Readonly<Record<string, SemanticDefinitionV1>>;
  readonly descriptors: readonly DescriptorRecordV1[];
  readonly sources: readonly SourceRecordV1[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly supports: readonly SupportRecordV1[];
  readonly rosters?: readonly { readonly digest: string; readonly body: RosterV1 }[];
}

function assertSortedUnique(values: readonly string[], name: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] ?? "") >= (values[index] ?? "")) {
      throw new WorldValidationError(
        "UNSORTED_SET",
        `${name} must be strictly ASCII sorted and unique`,
      );
    }
  }
}

function assertSubset(
  active: readonly string[],
  catalog: ReadonlySet<string>,
  name: string,
): void {
  for (const id of active) {
    if (!catalog.has(id)) {
      throw new WorldValidationError(
        "ACTIVE_NOT_CATALOGUED",
        `${name} contains an uncatalogued ID: ${id}`,
      );
    }
  }
}

function requireDefinition(
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
  digest: string,
  kind: SemanticDefinitionV1["kind"],
): SemanticDefinitionV1 {
  const definition = definitions[digest];
  if (definition === undefined) {
    throw new WorldValidationError(
      "UNKNOWN_REFERENCE",
      `Semantic definition is unavailable: ${digest}`,
    );
  }
  if (definition.kind !== kind) {
    throw new WorldValidationError(
      "DEFINITION_ROLE_MISMATCH",
      `Definition ${digest} is ${definition.kind}, expected ${kind}`,
    );
  }
  return definition;
}

function assertDescriptorReference(
  descriptorIds: ReadonlySet<string>,
  id: string,
): void {
  if (!descriptorIds.has(id)) {
    throw new WorldValidationError("UNKNOWN_REFERENCE", `Descriptor is unavailable: ${id}`);
  }
}

function assertDescriptorType(
  descriptors: ReadonlyMap<string, DescriptorRecordV1>,
  id: string,
  expectedDefinitionDigest: string | ReadonlySet<string>,
  message: string,
): void {
  const descriptor = descriptors.get(id);
  if (descriptor === undefined) {
    throw new WorldValidationError("UNKNOWN_REFERENCE", `Descriptor is unavailable: ${id}`);
  }
  const matches = typeof expectedDefinitionDigest === "string"
    ? descriptor.birthTypeDefinitionDigest === expectedDefinitionDigest
    : expectedDefinitionDigest.has(descriptor.birthTypeDefinitionDigest);
  if (!matches) {
    throw new WorldValidationError("INVALID_OPERATION_VALUE", message);
  }
}

/** @internal Shared compiler/ordinary-admission policy, pinned to release-owned identities. */
export function assertAuthoringRelationReferences(
  subjectId: string,
  predicateDefinitionDigest: string,
  value: TypedValueV1,
  descriptors: ReadonlyMap<string, DescriptorRecordV1>,
): void {
  const definitions = authoringSemantics().definitionDigestsByKey;
  const type = predicateDefinitionDigest === definitions["located_in"] ? "place"
    : predicateDefinitionDigest === definitions["member_of"] ? "faction" : undefined;
  if (type === undefined) return;
  const relation = type === "place" ? "located_in" : "member_of";
  assertDescriptorType(descriptors, subjectId, new Set(AUTHORED_ENTITY_TYPES.map((key) => definitions[key]!)), `${relation} requires an authored entity subject`);
  const message = `${relation} requires a ${type} target`;
  if (value.kind !== "ref") throw new WorldValidationError("INVALID_OPERATION_VALUE", message);
  assertDescriptorType(descriptors, value.id, definitions[type]!, message);
}

function assertTypedValue(
  value: TypedValueV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
  descriptorIds: ReadonlySet<string>,
  economicPredicate = false,
): void {
  if (value.kind === "ref") {
    assertDescriptorReference(descriptorIds, value.id);
    return;
  }
  const definition = requireDefinition(
    definitions,
    value.valueDefinitionDigest,
    "literal",
  );
  if (definition.operation === "economic-record-literal-v1" && !economicPredicate) throw new WorldValidationError("INVALID_OPERATION_VALUE", "Economic literal requires its economic predicate");
  if (definition.operation === "retained-unicode-v1" && typeof value.data !== "string") {
    throw new WorldValidationError(
      "INVALID_OPERATION_VALUE",
      "retained-unicode-v1 requires a string literal",
    );
  }
  if (definition.operation === "safe-integer-literal-v1" && !Number.isSafeInteger(value.data)) {
    throw new WorldValidationError("INVALID_OPERATION_VALUE", "safe-integer-literal-v1 requires a safe integer");
  }
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  context: string,
): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new WorldValidationError(
      "INVALID_OPERATION_VALUE",
      `${context} has unexpected arguments`,
    );
  }
}

export function validateWorldSemantics(input: WorldSemanticInput): void {
  const {
    world,
    definitionsByDigest,
    descriptors,
    sources,
    assertions,
    supports,
  } = input;

  const setNames: readonly (keyof Pick<
    WorldCatalogV1,
    | "descriptorIds"
    | "sourceIds"
    | "assertionIds"
    | "activeAssertionIds"
    | "supportIds"
    | "activeSupportIds"
  >)[] = [
    "descriptorIds",
    "sourceIds",
    "assertionIds",
    "activeAssertionIds",
    "supportIds",
    "activeSupportIds",
  ];
  for (const name of setNames) assertSortedUnique(world[name], name);

  const descriptorIds = new Set(world.descriptorIds);
  const sourceIds = new Set(world.sourceIds);
  const assertionIds = new Set(world.assertionIds);
  const supportIds = new Set(world.supportIds);
  assertSubset(world.activeAssertionIds, assertionIds, "activeAssertionIds");
  assertSubset(world.activeSupportIds, supportIds, "activeSupportIds");

  for (const descriptor of descriptors) {
    if (descriptor.worldId !== world.worldId) {
      throw new WorldValidationError("WORLD_MISMATCH", `Descriptor world mismatch: ${descriptor.id}`);
    }
    requireDefinition(
      definitionsByDigest,
      descriptor.birthTypeDefinitionDigest,
      "descriptorType",
    );
  }

  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const authoringTypes = authoringSemantics().definitionDigestsByKey;
  const entityTypeDigests = new Set(AUTHORED_ENTITY_TYPES.map((key) => authoringTypes[key]!));
  const trackPredicates = new Set(["track_subject", "track_value", "track_minimum", "track_maximum"].map((key) => authoringTypes[key]!));
  const rosterDigests = (input.rosters ?? []).map((roster) => roster.digest);
  assertSortedUnique(rosterDigests, "roster digests");
  for (const { digest, body: roster } of input.rosters ?? []) {
    if (!validateSemanticContract(roster).valid || roster.format !== "wmm.roster/1" || populationRosterDigest(roster) !== digest) {
      throw new WorldValidationError("INVALID_OPERATION_VALUE", "Invalid roster artifact identity or shape");
    }
    if (roster.worldId !== world.worldId) throw new WorldValidationError("WORLD_MISMATCH", "Roster world mismatch");
    requireDefinition(definitionsByDigest, roster.populationDefinitionDigest, "population");
    assertSortedUnique(roster.memberIds, "roster memberIds");
    for (const memberId of roster.memberIds) assertDescriptorReference(descriptorIds, memberId);
  }

  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  for (const source of sources) {
    if (source.worldId !== world.worldId) {
      throw new WorldValidationError("WORLD_MISMATCH", `Source world mismatch: ${source.id}`);
    }
  }

  const assertionsById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
  const economicReferences = {
    entityIds: new Set(descriptors.filter((record) => entityTypeDigests.has(record.birthTypeDefinitionDigest)).map((record) => record.id)),
    placeIds: new Set(descriptors.filter((record) => record.birthTypeDefinitionDigest === authoringTypes["place"]).map((record) => record.id)),
    sourceIds: new Set(sourcesById.keys()), definitionsByDigest,
  };
  const economicIds = new Set<string>();
  for (const assertion of assertions) {
    const body = assertion.body;
    if (body.worldId !== world.worldId) {
      throw new WorldValidationError("WORLD_MISMATCH", `Assertion world mismatch: ${assertion.id}`);
    }
    if (body.semanticProfileDigest !== world.semanticProfileDigest) {
      throw new WorldValidationError(
        "PROFILE_MISMATCH",
        `Assertion profile mismatch: ${assertion.id}`,
      );
    }

    assertValidApplicability(body.applicability);
    if (body.applicability.kind !== "invariant") {
      requireDefinition(
        definitionsByDigest,
        body.applicability.axisDefinitionDigest,
        "axis",
      );
    }
    for (const scopeValue of Object.values(body.scope)) {
      if (scopeValue.kind === "ref") assertDescriptorReference(descriptorIds, scopeValue.id);
    }

    if (body.proposition.kind === "atom") {
      assertDescriptorReference(descriptorIds, body.proposition.subjectId);
      const predicate = requireDefinition(
        definitionsByDigest,
        body.proposition.predicateDefinitionDigest,
        "predicate",
      );
      assertTypedValue(body.proposition.value, definitionsByDigest, descriptorIds, predicate.operation === "economic-record-atom-v1");
      if (predicate.operation === "economic-record-atom-v1") {
        if (!economicReferences.entityIds.has(body.proposition.subjectId)) throw new WorldValidationError("INVALID_OPERATION_VALUE", "Economic subject must be an authored entity");
        if (body.polarity !== "positive" || body.applicability.kind !== "invariant") throw new WorldValidationError("INVALID_OPERATION_VALUE", "Economic records require positive polarity and invariant applicability");
        const value = body.proposition.value;
        if (value.kind !== "literal" || definitionsByDigest[value.valueDefinitionDigest]?.operation !== "economic-record-literal-v1" || !predicate.dependencies.includes(value.valueDefinitionDigest)) {
          throw new WorldValidationError("INVALID_OPERATION_VALUE", "Economic record requires its pinned economic literal");
        }
        try {
          const economic = admitEconomicRecordValue(value.data, economicReferences);
          if (economicIds.has(economic.id)) throw new EconomyError(`Duplicate economic entry ID: ${economic.id}`);
          economicIds.add(economic.id);
          if (economicIds.size > MAX_ECONOMIC_RECORDS) throw new EconomyError(`Too many economic records; maximum ${MAX_ECONOMIC_RECORDS}`);
        } catch (error) {
          if (error instanceof EconomyError) throw new WorldValidationError("INVALID_OPERATION_VALUE", error.message);
          throw error;
        }
      }
      if (predicate.operation === "integer-value-v1" && (
        body.proposition.value.kind !== "literal" ||
        definitionsByDigest[body.proposition.value.valueDefinitionDigest]?.operation !== "safe-integer-literal-v1"
      )) {
        throw new WorldValidationError("INVALID_OPERATION_VALUE", "integer-value-v1 requires a safe-integer literal");
      }
      if (
        (
          predicate.operation === "exact-tuple-multivalue-v1" ||
          predicate.operation === "population-membership-atom-v1" ||
          predicate.operation === "criterion-satisfaction-atom-v1"
        ) &&
        body.proposition.value.kind !== "ref"
      ) {
        throw new WorldValidationError(
          "INVALID_OPERATION_VALUE",
          `${predicate.operation} requires a descriptor reference value`,
        );
      }
      assertAuthoringRelationReferences(body.proposition.subjectId, body.proposition.predicateDefinitionDigest, body.proposition.value, descriptorsById);
      if (trackPredicates.has(body.proposition.predicateDefinitionDigest)) {
        assertDescriptorType(descriptorsById, body.proposition.subjectId, authoringTypes["track"]!, "Track predicates require a track subject");
        if (body.proposition.predicateDefinitionDigest === authoringTypes["track_subject"] && body.proposition.value.kind === "ref") {
          assertDescriptorType(descriptorsById, body.proposition.value.id, entityTypeDigests, "Track subject reference requires an authored entity");
        }
      }
      // These primitives constrain the reference value, not every possible subject's type.
      if (body.proposition.value.kind === "ref") {
        if (predicate.operation === "population-membership-atom-v1") {
          assertDescriptorType(descriptorsById, body.proposition.value.id, authoringTypes["population"]!, "Candidate membership requires a population descriptor reference");
        } else if (predicate.operation === "criterion-satisfaction-atom-v1") {
          assertDescriptorType(descriptorsById, body.proposition.value.id, authoringTypes["office"]!, "Eligibility satisfaction requires an office descriptor reference");
        }
      }
      if (predicate.operation === "population-coverage-atom-v1") {
        assertDescriptorType(descriptorsById, body.proposition.subjectId, authoringTypes["population"]!, "Population coverage requires a population descriptor subject");
        const basis = populationCoverageBasis(body.proposition.value, definitionsByDigest);
        if (
          basis === undefined ||
          body.proposition.value.kind !== "literal" ||
          !predicate.dependencies.includes(body.proposition.value.valueDefinitionDigest)
        ) {
          throw new WorldValidationError(
            "INVALID_OPERATION_VALUE",
            "Population coverage requires its pinned roster-bound coverage basis literal",
          );
        }
        const population = requireDefinition(
          definitionsByDigest,
          basis.populationDefinitionDigest,
          "population",
        );
        requireDefinition(definitionsByDigest, basis.selectorDefinitionDigest, "selector");
        const selector = resolvePopulationSelector(basis.populationDefinitionDigest, definitionsByDigest);
        if (!population.dependencies.includes(body.proposition.predicateDefinitionDigest) ||
          selector?.selectorDefinitionDigest !== basis.selectorDefinitionDigest) {
          throw new WorldValidationError(
            "INVALID_OPERATION_VALUE",
            "Coverage predicate or selector is not pinned by its population definition",
          );
        }
      }
    } else {
      assertDescriptorReference(descriptorIds, body.proposition.population.descriptorId);
      assertDescriptorType(descriptorsById, body.proposition.population.descriptorId, authoringTypes["population"]!, "Existential population requires a population descriptor reference");
      requireDefinition(
        definitionsByDigest,
        body.proposition.population.definitionDigest,
        "population",
      );
      const criterion = requireDefinition(
        definitionsByDigest,
        body.proposition.criterion.definitionDigest,
        "criterion",
      );
      for (const value of Object.values(body.proposition.criterion.arguments)) {
        assertTypedValue(value, definitionsByDigest, descriptorIds);
      }
      if (criterion.operation === "bundled-eligibility-v1") {
        assertExactKeys(body.proposition.criterion.arguments, ["office"], "Eligibility criterion");
        const office = body.proposition.criterion.arguments["office"];
        if (office?.kind !== "ref") {
          throw new WorldValidationError(
            "INVALID_OPERATION_VALUE",
            "Eligibility criterion requires an office descriptor reference",
          );
        }
        assertDescriptorType(
          descriptorsById, office.id, authoringTypes["office"]!,
          "Eligibility criterion requires an office descriptor reference",
        );
      }
    }
  }

  for (const support of supports) {
    const body = support.body;
    if (body.worldId !== world.worldId) {
      throw new WorldValidationError("WORLD_MISMATCH", `Support world mismatch: ${support.id}`);
    }
    if (!assertionsById.has(body.claimId)) {
      throw new WorldValidationError(
        "UNKNOWN_REFERENCE",
        `Support claim is unavailable: ${body.claimId}`,
      );
    }
    const source = sourcesById.get(body.sourceId);
    if (source === undefined) {
      throw new WorldValidationError(
        "UNKNOWN_REFERENCE",
        `Support source is unavailable: ${body.sourceId}`,
      );
    }
    const locator = requireDefinition(
      definitionsByDigest,
      body.locator.definitionDigest,
      "locator",
    );
    requireDefinition(
      definitionsByDigest,
      body.interpretationMethodDefinitionDigest,
      "interpretation",
    );
    if (
      locator.operation === "author-stipulation-locator-v1" &&
      !isDeepStrictEqual(body.locator.data, { kind: "authorStipulation" })
    ) {
      throw new WorldValidationError(
        "INVALID_OPERATION_VALUE",
        "Author stipulation locator has an invalid value",
      );
    }

    if (body.sourceContentDigest !== undefined) {
      if (source.content.availability === "none") {
        throw new WorldValidationError(
          "SOURCE_DIGEST_MISMATCH",
          "Support cannot bind content for a source with no content",
        );
      }
      if (body.sourceContentDigest !== source.content.sha256) {
        throw new WorldValidationError(
          "SOURCE_DIGEST_MISMATCH",
          `Support content digest differs from source ${source.id}`,
        );
      }
    }
  }
}
