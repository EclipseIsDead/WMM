import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertionId, semanticDefinitionDigest, semanticProfileDigest } from "@wmm/canonical";
import { validateWorldRecord } from "@wmm/wire-contracts";
import type { AssertionRecordV1, ClaimBodyV1, DescriptorRecordV1, SourceRecordV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import { admitSemanticProfile, authoringSemantics, bundledV1Semantics, compileAuthoringProject, economySemantics, validateWorldSemantics, type WorldSemanticInput } from "../src/index.js";
import { delivery, project as economicProject, stock } from "./helpers/economy.js";

const root = new URL("../../../fixtures/v1/complete-world/payload/", import.meta.url);
function parse<T>(path: string): T { return JSON.parse(readFileSync(new URL(path, root), "utf8")) as T; }
const catalog = parse<WorldCatalogV1>("world.json");
const semantics = bundledV1Semantics();
const definitionsByDigest = Object.fromEntries(semantics.definitions.map((definition) => [semantics.definitionDigestsByKey[definition.key]!, definition]));
const descriptors = catalog.descriptorIds.map((id) => parse<DescriptorRecordV1>(`records/descriptors/${id.replace(":", "/")}.json`));
const claims = catalog.assertionIds.map((id) => parse<AssertionRecordV1>(`records/assertions/${id.slice(5)}.json`).body);
function atom(predicate: string): Extract<ClaimBodyV1["proposition"], { kind: "atom" }> {
  return claims.map((body) => body.proposition).find((proposition) => proposition.kind === "atom" && proposition.predicateDefinitionDigest === semantics.definitionDigestsByKey[predicate])! as Extract<ClaimBodyV1["proposition"], { kind: "atom" }>;
}
const template = claims[0]!;
function input(body: ClaimBodyV1, base: Pick<WorldSemanticInput, "world" | "definitionsByDigest" | "descriptors"> = { world: catalog, definitionsByDigest, descriptors }): WorldSemanticInput {
  const record: AssertionRecordV1 = { format: "wmm.assertion-record/1", id: assertionId(body), body };
  expect(validateWorldRecord(record)).toEqual({ valid: true, errors: [] });
  return {
    ...base, world: { ...base.world, sourceIds: [], assertionIds: [record.id], activeAssertionIds: [record.id], supportIds: [], activeSupportIds: [] },
    sources: [], assertions: [record], supports: [],
  };
}

function authoredInput(project: unknown = JSON.parse(readFileSync(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url), "utf8"))): WorldSemanticInput {
  const compiled = compileAuthoringProject(project);
  const records = <T>(prefix: string): T[] => compiled.payload.filter((file) => file.path.startsWith(prefix)).map((file) => JSON.parse(new TextDecoder().decode(file.bytes)) as T);
  const world = records<WorldCatalogV1>("world.json")[0]!;
  return {
    world: { ...world, supportIds: [], activeSupportIds: [] },
    definitionsByDigest: world.semanticProfileDigest === economySemantics().profileDigest ? economySemantics().definitionsByDigest : authoringSemantics().definitionsByDigest,
    descriptors: records<DescriptorRecordV1>("records/descriptors/"), sources: records<SourceRecordV1>("records/sources/"),
    assertions: records<AssertionRecordV1>("records/assertions/"), supports: [],
  };
}

function changeClaims(base: WorldSemanticInput, change: (body: ClaimBodyV1) => ClaimBodyV1): WorldSemanticInput {
  const ids = new Map<string, string>();
  const assertions = base.assertions.map((record) => {
    const body = change(record.body);
    const id = assertionId(body);
    ids.set(record.id, id);
    expect(validateWorldRecord({ ...record, id, body }).valid).toBe(true);
    return { ...record, id, body };
  });
  return { ...base, assertions, supports: [], world: {
    ...base.world, assertionIds: assertions.map((record) => record.id).sort(),
    activeAssertionIds: base.world.activeAssertionIds.map((id) => ids.get(id)!).sort(), supportIds: [], activeSupportIds: [],
  } };
}

/** A host-admitted lookalike key is still not the release-owned descriptor type. */
function lookalikeType(base: WorldSemanticInput, key: string): WorldSemanticInput {
  const original = Object.entries(base.definitionsByDigest).find(([, definition]) => definition.key === key)!;
  const replacement = { ...original[1], version: "2" };
  const digest = semanticDefinitionDigest(replacement);
  const definitions = Object.entries(base.definitionsByDigest).map(([id, definition]) => id === original[0] ? replacement : definition);
  const profile = { ...semantics.profile, definitions: definitions.map(semanticDefinitionDigest).sort() };
  const admitted = admitSemanticProfile({ profile, definitions, trustedDefinitionDigests: new Set(profile.definitions), trustedProfileDigests: new Set([semanticProfileDigest(profile)]) });
  return changeClaims({
    ...base, definitionsByDigest: admitted.definitionsByDigest,
    descriptors: base.descriptors.map((record) => record.birthTypeDefinitionDigest === original[0] ? { ...record, birthTypeDefinitionDigest: digest } : record),
    world: { ...base.world, semanticProfileDigest: admitted.profileDigest },
  }, (body) => ({ ...body, semanticProfileDigest: admitted.profileDigest }));
}

function renameReference(body: ClaimBodyV1, from: string, to: string): ClaimBodyV1 {
  const proposition = body.proposition;
  if (proposition.kind === "atom") return { ...body, proposition: {
    ...proposition, subjectId: proposition.subjectId === from ? to : proposition.subjectId,
    value: proposition.value.kind === "ref" && proposition.value.id === from ? { ...proposition.value, id: to } : proposition.value,
  } };
  return { ...body, proposition: {
    ...proposition, population: { ...proposition.population, descriptorId: proposition.population.descriptorId === from ? to : proposition.population.descriptorId },
    criterion: { ...proposition.criterion, arguments: Object.fromEntries(Object.entries(proposition.criterion.arguments).map(([key, value]) => [key, value.kind === "ref" && value.id === from ? { ...value, id: to } : value])) },
  } };
}

describe("reference identity and unchanged claim qualifiers", () => {
  it.each(["person", "office", "population"])("accepts the canonical %s birth type under an account-prefixed ID in all its bundled roles", (type) => {
    const original = descriptors.find((record) => record.birthTypeDefinitionDigest === semantics.definitionDigestsByKey[type])!;
    const alias = "account:typed_alias";
    const base = { world: { ...catalog, descriptorIds: catalog.descriptorIds.map((id) => id === original.id ? alias : id).sort() }, definitionsByDigest,
      descriptors: descriptors.map((record) => record === original ? { ...record, id: alias } : record) };
    for (const body of claims) expect(() => validateWorldSemantics(input(renameReference(body, original.id, alias), base))).not.toThrow();
  });

  it.each(["track", "faction"])("accepts the canonical %s birth type in track roles despite an account-prefixed ID", (type) => {
    const base = authoredInput();
    const original = base.descriptors.find((record) => record.birthTypeDefinitionDigest === authoringSemantics().definitionDigestsByKey[type])!;
    const alias = "account:typed_alias";
    const changed = changeClaims({ ...base, world: { ...base.world, descriptorIds: base.world.descriptorIds.map((id) => id === original.id ? alias : id).sort() },
      descriptors: base.descriptors.map((record) => record === original ? { ...record, id: alias } : record) }, (body) => renameReference(body, original.id, alias));
    expect(() => validateWorldSemantics(changed)).not.toThrow();
  });

  it.each(["office", "place", "faction"])("does not treat an admitted lookalike %s key as the release-owned type", (type) => {
    let base: WorldSemanticInput;
    if (type === "office") base = input(claims.find((body) => body.proposition.kind === "exists")!);
    else {
      const authored = authoredInput();
      const body: ClaimBodyV1 = { ...authored.assertions[0]!.body, proposition: {
        kind: "atom", subjectId: type === "place" ? "faction:lantern_guild" : "place:north_quay", predicateDefinitionDigest: authoringSemantics().definitionDigestsByKey[type === "place" ? "located_in" : "member_of"]!,
        value: { kind: "ref", id: type === "place" ? "place:north_quay" : "faction:lantern_guild" },
      } };
      base = input(body, authored);
    }
    expect(() => validateWorldSemantics(lookalikeType(base, type))).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/office descriptor|place target|faction target/) }));
  });

  it.each(["positive", "negative"] as const)("checks office types without changing %s polarity, recorded time, scope or activation semantics", (polarity) => {
    const original = claims.find((body) => body.proposition.kind === "exists")!;
    const temporal: readonly ClaimBodyV1["applicability"][] = [original.applicability, { kind: "invariant" }, { kind: "point", axisDefinitionDigest: semantics.definitionDigestsByKey["days"]!, position: { kind: "unknown" } }];
    const scopes: readonly ClaimBodyV1["scope"][] = [original.scope, { account: { kind: "unresolved" }, jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "unresolved" } }];
    for (const applicability of temporal) for (const scope of scopes) {
      const valid = input({ ...original, polarity, applicability, scope });
      const before = structuredClone(valid);
      expect(() => validateWorldSemantics(valid)).not.toThrow();
      expect(valid).toEqual(before);
      const wrong = changeClaims(valid, (body) => body.proposition.kind !== "exists" ? body : { ...body, proposition: { ...body.proposition, criterion: { ...body.proposition.criterion, arguments: { office: { kind: "ref", id: "person:alys" } } } } });
      expect(() => validateWorldSemantics({ ...wrong, world: { ...wrong.world, activeAssertionIds: [] } })).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE" }));
    }
  });

  it("does not impose role restrictions on unrelated exact-tuple relations", () => {
    const body: ClaimBodyV1 = { ...template, proposition: { kind: "atom", subjectId: "office:valen-crown", predicateDefinitionDigest: semantics.definitionDigestsByKey["allied_with"]!, value: { kind: "ref", id: "population:succession-candidates" } } };
    expect(() => validateWorldSemantics(input(body))).not.toThrow();
  });
});

describe("economic reference birth-type admission", () => {
  it.each(["location", "destination"] as const)("does not accept a same-key lookalike place type for an economic %s", (role) => {
    const base = lookalikeType(authoredInput(economicProject([role === "location" ? stock() : delivery()])), "place");
    expect(() => validateWorldSemantics(base)).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE" }));
  });

  it.each(["place:reedbank", "item:grain"])("rejects an entity-looking ID with an account birth type: %s", (id) => {
    const base = authoredInput(economicProject());
    const descriptors = base.descriptors.map((record) => record.id !== id ? record : { ...record, birthTypeDefinitionDigest: authoringSemantics().definitionDigestsByKey["account"]! });
    expect(() => validateWorldSemantics({ ...base, descriptors })).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/authored entity|Unknown economic entity/) }));
  });

  it("accepts an economic subject with an entity birth type despite a misleading account prefix", () => {
    const base = authoredInput(economicProject());
    const original = base.descriptors.find((record) => record.id === "place:reedbank")!;
    const descriptor = { ...original, id: "account:entity_alias" };
    const changed = changeClaims({ ...base, descriptors: [...base.descriptors, descriptor], world: { ...base.world, descriptorIds: [...base.world.descriptorIds, descriptor.id].sort() } }, (body) => body.proposition.kind !== "atom" ? body : { ...body, proposition: { ...body.proposition, subjectId: descriptor.id } });
    expect(() => validateWorldSemantics(changed)).not.toThrow();
  });
});

describe("authored relation reference-type contracts", () => {
  it.each(["person", "faction", "place", "item", "event", "concept"])("accepts an account-prefixed %s subject in both authored relation domains", (type) => {
    const base = authoredInput();
    const descriptor: DescriptorRecordV1 = { format: "wmm.descriptor/1", worldId: base.world.worldId, id: "account:entity_alias", birthTypeDefinitionDigest: authoringSemantics().definitionDigestsByKey[type]! };
    const withAlias = { ...base, descriptors: [...base.descriptors, descriptor], world: { ...base.world, descriptorIds: [...base.world.descriptorIds, descriptor.id].sort() } };
    for (const predicate of ["located_in", "member_of"] as const) {
      const body: ClaimBodyV1 = { ...base.assertions[0]!.body, proposition: { kind: "atom", subjectId: descriptor.id, predicateDefinitionDigest: authoringSemantics().definitionDigestsByKey[predicate]!, value: { kind: "ref", id: predicate === "located_in" ? "place:north_quay" : "faction:lantern_guild" } } };
      expect(() => validateWorldSemantics(input(body, withAlias))).not.toThrow();
    }
  });

  it.each(["located_in", "member_of"] as const)("rejects a nonentity %s subject just as the compiler does", (predicate) => {
    const base = authoredInput();
    const body: ClaimBodyV1 = { ...base.assertions[0]!.body, proposition: {
      kind: "atom", subjectId: "account:setting", predicateDefinitionDigest: authoringSemantics().definitionDigestsByKey[predicate]!,
      value: { kind: "ref", id: predicate === "located_in" ? "place:north_quay" : "faction:lantern_guild" },
    } };
    expect(() => validateWorldSemantics(input(body, base))).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/authored entity subject/) }));
  });
});

describe("authored track reference-type contracts", () => {
  it.each(["track_subject", "track_value", "track_minimum", "track_maximum"] as const)("rejects a nontrack subject for %s", (predicate) => {
    const base = authoredInput();
    const digest = authoringSemantics().definitionDigestsByKey[predicate];
    const changed = changeClaims(base, (body) => body.proposition.kind !== "atom" || body.proposition.predicateDefinitionDigest !== digest ? body : {
      ...body, proposition: { ...body.proposition, subjectId: "faction:lantern_guild" },
    });
    expect(() => validateWorldSemantics(changed)).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/track subject/) }));
  });

  it("rejects a nonentity track subject reference", () => {
    const base = authoredInput();
    const digest = authoringSemantics().definitionDigestsByKey["track_subject"];
    const changed = changeClaims(base, (body) => body.proposition.kind !== "atom" || body.proposition.predicateDefinitionDigest !== digest ? body : {
      ...body, proposition: { ...body.proposition, value: { kind: "ref", id: "account:setting" } },
    });
    expect(() => validateWorldSemantics(changed)).toThrow(expect.objectContaining({ code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/authored entity/) }));
  });
});

describe("bundled primitive reference-type contracts", () => {
  it.each(["candidate_membership", "eligibility_satisfaction"])("retains the existing unconstrained %s subject domain", (predicate) => {
    const body: ClaimBodyV1 = { ...template, proposition: { ...atom(predicate), subjectId: "office:valen-crown" } };
    expect(() => validateWorldSemantics(input(body))).not.toThrow();
  });

  it.each(["coverage", "existential"] as const)("rejects a nonpopulation descriptor in the %s population role", (role) => {
    const exists = claims.map((body) => body.proposition).find((proposition) => proposition.kind === "exists")!;
    const body: ClaimBodyV1 = { ...template, proposition: role === "coverage"
      ? { ...atom("population_coverage"), subjectId: "person:alys" }
      : { ...exists, population: { ...exists.population, descriptorId: "person:alys" } } };
    expect(() => validateWorldSemantics(input(body))).toThrow(expect.objectContaining({
      code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/population descriptor/),
    }));
  });

  it("rejects the wrong candidate membership population birth type", () => {
    const proposition = atom("candidate_membership");
    const body: ClaimBodyV1 = { ...template, proposition: { ...proposition, value: { kind: "ref", id: "person:alys" } } };
    expect(() => validateWorldSemantics(input(body))).toThrow(expect.objectContaining({
      code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/population/),
    }));
  });

  it("rejects the wrong eligibility satisfaction office birth type", () => {
    const proposition = atom("eligibility_satisfaction");
    const body: ClaimBodyV1 = { ...template, proposition: { ...proposition, value: { kind: "ref", id: "person:alys" } } };
    expect(() => validateWorldSemantics(input(body))).toThrow(expect.objectContaining({
      code: "INVALID_OPERATION_VALUE", message: expect.stringMatching(/office/),
    }));
  });
});
