import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import type {
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";
import {
  AdmissionError,
  admitSemanticProfile,
  type SemanticAdmissionRequest,
} from "../src/index.js";

const typesUrl = new URL(
  "../../../wmm-v0.3-contract-kit/fixture-payload/types/",
  import.meta.url,
);
const files = readdirSync(typesUrl).filter((name) => name.endsWith(".json"));
const artifacts = files.map((name) => ({
  name,
  value: JSON.parse(readFileSync(new URL(name, typesUrl), "utf8")) as unknown,
}));
const definitions = artifacts
  .filter(
    (artifact): artifact is { name: string; value: SemanticDefinitionV1 } =>
      (artifact.value as { format?: unknown }).format === "wmm.semantic-definition/1",
  )
  .map((artifact) => artifact.value);
const profileArtifact = artifacts.find(
  (artifact): artifact is { name: string; value: SemanticProfileV1 } =>
    (artifact.value as { format?: unknown }).format === "wmm.semantic-profile/1",
);
if (profileArtifact === undefined) throw new Error("Seed profile fixture is missing");
const profile = profileArtifact.value;
const definitionDigests = definitions.map(semanticDefinitionDigest);
const profileDigest = semanticProfileDigest(profile);

function request(overrides: Partial<SemanticAdmissionRequest> = {}): SemanticAdmissionRequest {
  return {
    profile,
    definitions,
    trustedDefinitionDigests: new Set(definitionDigests),
    trustedProfileDigests: new Set([profileDigest]),
    allowFixtureOnly: true,
    ...overrides,
  };
}

function expectAdmissionCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail(`Expected admission error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AdmissionError);
    expect((error as AdmissionError).code).toBe(code);
  }
}

describe("trusted semantic-profile admission", () => {
  it("recomputes the exact seed digests and admits them only in fixture mode", () => {
    for (const artifact of artifacts) {
      const digest =
        (artifact.value as { format?: string }).format === "wmm.semantic-profile/1"
          ? semanticProfileDigest(artifact.value as SemanticProfileV1)
          : semanticDefinitionDigest(artifact.value as SemanticDefinitionV1);
      expect(`${digest}.json`).toBe(artifact.name);
    }

    const admitted = admitSemanticProfile(request());
    expect(admitted.profileDigest).toBe(profileDigest);
    expect(Object.keys(admitted.definitionsByDigest).sort()).toEqual(
      [...definitionDigests].sort(),
    );
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.profile)).toBe(true);
  });

  it("rejects a mutating request profile getter without reading it", () => {
    const supplied = request();
    let reads = 0;
    Object.defineProperty(supplied, "profile", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? profile : { ...profile, version: "changed" };
      },
    });

    expect(() => admitSemanticProfile(supplied)).toThrow(/enumerable data properties/);
    expect(reads).toBe(0);
  });

  it.each(["version", "definitions", "fixtureOnly"] as const)(
    "rejects a profile %s getter before schema validation can invoke it",
    (key) => {
      const suppliedProfile = structuredClone(profile);
      let reads = 0;
      Object.defineProperty(suppliedProfile, key, {
        enumerable: true,
        get() {
          reads += 1;
          Reflect.set(suppliedProfile, "numericProfile", "changed");
          return profile[key];
        },
      });

      expect(() => admitSemanticProfile(request({ profile: suppliedProfile })))
        .toThrow(/enumerable data properties/);
      expect(reads).toBe(0);
      expect(suppliedProfile.numericProfile).toBe(profile.numericProfile);
    },
  );

  it("rejects definition and dependency accessors without invoking them", () => {
    const suppliedDefinitions = structuredClone(definitions);
    const first = suppliedDefinitions[0];
    if (first === undefined) throw new Error("Definition fixture is missing");
    let reads = 0;
    Object.defineProperty(first, "dependencies", {
      enumerable: true,
      get() { reads += 1; return []; },
    });
    expect(() => admitSemanticProfile(request({ definitions: suppliedDefinitions })))
      .toThrow(/enumerable data properties/);
    expect(reads).toBe(0);

    Object.defineProperty(first, "dependencies", { value: ["0".repeat(64)] });
    Object.defineProperty(first.dependencies, "0", {
      enumerable: true,
      get() { reads += 1; return "0".repeat(64); },
    });
    expect(() => admitSemanticProfile(request({ definitions: suppliedDefinitions })))
      .toThrow(/enumerable data elements/);
    expect(reads).toBe(0);
  });

  it("rejects proxied profile data without invoking traps", () => {
    let traps = 0;
    const suppliedProfile = new Proxy(profile, {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
    });
    expect(() => admitSemanticProfile(request({ profile: suppliedProfile })))
      .toThrow(/Proxies/);
    expect(traps).toBe(0);
  });

  it("validates, hashes, and returns one snapshot despite trust callback mutations", () => {
    const suppliedProfile = structuredClone(profile);
    const suppliedDefinitions = structuredClone(definitions);
    const trustedProfileDigests = new Set([profileDigest]);
    trustedProfileDigests.has = (digest) => {
      Reflect.set(suppliedProfile, "version", "changed");
      (suppliedProfile.definitions as string[]).length = 0;
      for (const definition of suppliedDefinitions) {
        Reflect.set(definition, "version", "changed");
        (definition.dependencies as string[]).push("0".repeat(64));
      }
      suppliedDefinitions.length = 0;
      return Set.prototype.has.call(trustedProfileDigests, digest) as boolean;
    };

    const admitted = admitSemanticProfile(request({
      profile: suppliedProfile,
      definitions: suppliedDefinitions,
      trustedProfileDigests,
    }));
    expect(suppliedProfile.version).toBe("changed");
    expect(suppliedDefinitions).toHaveLength(0);
    expect(admitted.profile).toEqual(profile);
    expect(admitted.profile).not.toBe(suppliedProfile);
    expect(admitted.profileDigest).toBe(profileDigest);
    expect(semanticProfileDigest(admitted.profile)).toBe(admitted.profileDigest);
    for (const [digest, definition] of Object.entries(admitted.definitionsByDigest)) {
      expect(semanticDefinitionDigest(definition)).toBe(digest);
      expect(definition).toEqual(definitions.find((value) => value.key === definition.key));
    }
  });

  it("deeply freezes private profile and definition data without freezing the caller", () => {
    const suppliedProfile = structuredClone(profile);
    const suppliedDefinitions = structuredClone(definitions);
    const admitted = admitSemanticProfile(request({
      profile: suppliedProfile,
      definitions: suppliedDefinitions,
    }));
    const digest = definitionDigests[0];
    if (digest === undefined) throw new Error("Definition fixture is missing");
    const definition = admitted.definitionsByDigest[digest];
    if (definition === undefined) throw new Error("Admitted definition is missing");
    expect(definition).not.toBe(suppliedDefinitions[0]);
    expect(Object.isFrozen(admitted.definitionsByDigest)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.dependencies)).toBe(true);
    expect(Object.isFrozen(admitted.profile.definitions)).toBe(true);
    expect(Object.isFrozen(suppliedProfile)).toBe(false);
    expect(Object.isFrozen(suppliedDefinitions[0])).toBe(false);
    expect(Reflect.set(definition, "version", "changed")).toBe(false);
    expect(() => (definition.dependencies as string[]).push("0".repeat(64))).toThrow(TypeError);
    expect(Reflect.set(admitted.profile, "version", "changed")).toBe(false);
    expect(() => (admitted.profile.definitions as string[]).pop()).toThrow(TypeError);

    Reflect.set(suppliedProfile, "version", "changed");
    (suppliedProfile.definitions as string[]).length = 0;
    Reflect.set(suppliedDefinitions[0]!, "version", "changed");
    (suppliedDefinitions[0]!.dependencies as string[]).push("0".repeat(64));
    expect(admitted.profile).toEqual(profile);
    expect(semanticProfileDigest(admitted.profile)).toBe(admitted.profileDigest);
    expect(semanticDefinitionDigest(definition)).toBe(digest);
  });

  it("rejects fixture-only artifacts in ordinary runtime admission", () => {
    expectAdmissionCode(
      () => admitSemanticProfile(request({ allowFixtureOnly: false })),
      "FIXTURE_ONLY",
    );
  });

  it("rejects a self-consistent but non-allowlisted profile", () => {
    expectAdmissionCode(
      () => admitSemanticProfile(request({ trustedProfileDigests: new Set() })),
      "UNTRUSTED_PROFILE",
    );
  });

  it("rejects modified or non-allowlisted definition bytes", () => {
    const first = definitions[0];
    if (first === undefined) throw new Error("Definition fixture is missing");
    const changed: SemanticDefinitionV1 = { ...first, version: "2" };
    const changedDefinitions = [changed, ...definitions.slice(1)];
    expectAdmissionCode(
      () => admitSemanticProfile(request({ definitions: changedDefinitions })),
      "UNTRUSTED_DEFINITION",
    );
  });

  it("requires every profile definition and rejects undeclared extras", () => {
    expectAdmissionCode(
      () => admitSemanticProfile(request({ definitions: definitions.slice(1) })),
      "MISSING_PROFILE_DEFINITION",
    );

    const first = definitions[0];
    if (first === undefined) throw new Error("Definition fixture is missing");
    const extra: SemanticDefinitionV1 = { ...first, key: "extra", version: "2" };
    const extraDigest = semanticDefinitionDigest(extra);
    expectAdmissionCode(
      () =>
        admitSemanticProfile(
          request({
            definitions: [...definitions, extra],
            trustedDefinitionDigests: new Set([...definitionDigests, extraDigest]),
          }),
        ),
      "UNDECLARED_DEFINITION",
    );
  });
});
