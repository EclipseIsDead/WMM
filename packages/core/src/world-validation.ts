import { isDeepStrictEqual } from "node:util";

import { assertValidApplicability } from "@wmm/temporal";
import type {
  AssertionRecordV1,
  DescriptorRecordV1,
  SemanticDefinitionV1,
  SourceRecordV1,
  SupportRecordV1,
  TypedValueV1,
  WorldCatalogV1,
} from "@wmm/wire-contracts";

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

function assertTypedValue(
  value: TypedValueV1,
  definitions: Readonly<Record<string, SemanticDefinitionV1>>,
  descriptorIds: ReadonlySet<string>,
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
  if (definition.operation === "retained-unicode-v1" && typeof value.data !== "string") {
    throw new WorldValidationError(
      "INVALID_OPERATION_VALUE",
      "retained-unicode-v1 requires a string literal",
    );
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

  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  for (const source of sources) {
    if (source.worldId !== world.worldId) {
      throw new WorldValidationError("WORLD_MISMATCH", `Source world mismatch: ${source.id}`);
    }
  }

  const assertionsById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
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
      assertTypedValue(body.proposition.value, definitionsByDigest, descriptorIds);
      if (
        (
          predicate.operation === "exact-tuple-multivalue-v1" ||
          predicate.operation === "population-coverage-atom-v1" ||
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
      if (
        predicate.operation === "population-coverage-atom-v1" &&
        body.proposition.value.kind === "ref" &&
        body.proposition.subjectId !== body.proposition.value.id
      ) {
        throw new WorldValidationError(
          "INVALID_OPERATION_VALUE",
          "population-coverage-atom-v1 requires a self-referential population value",
        );
      }
    } else {
      assertDescriptorReference(descriptorIds, body.proposition.population.descriptorId);
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
