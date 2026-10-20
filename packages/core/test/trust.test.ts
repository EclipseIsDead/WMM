import { describe, expect, it } from "vitest";

import {
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "@wmm/canonical";
import type { SemanticDefinitionV1 } from "@wmm/wire-contracts";
import { admitSemanticProfile, bundledV1Semantics } from "../src/index.js";

describe("bundled semantic trust", () => {
  it("retains deeply frozen admitted definitions and profile data in the cache", () => {
    const bundled = bundledV1Semantics();
    expect(Object.isFrozen(bundled)).toBe(true);
    expect(Object.isFrozen(bundled.definitions)).toBe(true);
    expect(Object.isFrozen(bundled.definitionsByKey)).toBe(true);
    expect(Object.isFrozen(bundled.definitionDigestsByKey)).toBe(true);
    expect(Object.isFrozen(bundled.profile)).toBe(true);
    expect(Object.isFrozen(bundled.profile.definitions)).toBe(true);

    for (const definition of bundled.definitions) {
      expect(bundled.definitionsByKey[definition.key]).toBe(definition);
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.dependencies)).toBe(true);
      expect(semanticDefinitionDigest(definition))
        .toBe(bundled.definitionDigestsByKey[definition.key]);
      expect(Reflect.set(definition, "operation", "tampered")).toBe(false);
      expect(() => (definition.dependencies as string[]).push("0".repeat(64)))
        .toThrow(TypeError);
    }
    expect(Reflect.set(bundled.definitionsByKey, "tampered", bundled.definitions[0]))
      .toBe(false);
    expect(Reflect.set(bundled.definitionDigestsByKey, "tampered", "0".repeat(64)))
      .toBe(false);
    expect(() => (bundled.definitions as SemanticDefinitionV1[]).pop()).toThrow(TypeError);
    expect(Reflect.set(bundled.profile, "version", "tampered")).toBe(false);
    expect(() => (bundled.profile.definitions as string[]).pop()).toThrow(TypeError);

    const cached = bundledV1Semantics();
    expect(cached).toBe(bundled);
    expect(semanticProfileDigest(cached.profile)).toBe(cached.profileDigest);
    expect(admitSemanticProfile(cached).profileDigest).toBe(cached.profileDigest);
  });

  it("exposes complete read-only Set views without leaking their backing sets", () => {
    const bundled = bundledV1Semantics();
    for (const trusted of [bundled.trustedDefinitionDigests, bundled.trustedProfileDigests]) {
      const values = [...trusted];
      expect(trusted.size).toBe(values.length);
      expect([...trusted.keys()]).toEqual(values);
      expect([...trusted.values()]).toEqual(values);
      expect([...trusted.entries()]).toEqual(values.map((value) => [value, value]));
      for (const value of values) expect(trusted.has(value)).toBe(true);

      const receiver = {};
      const visited: string[] = [];
      trusted.forEach(function (this: object, value, key, set) {
        expect(this).toBe(receiver);
        expect(key).toBe(value);
        expect(set).toBe(trusted);
        expect(Reflect.get(set, "add")).toBeUndefined();
        expect(() => Set.prototype.add.call(set, "tampered")).toThrow(TypeError);
        visited.push(value);
      }, receiver);
      expect(visited).toEqual(values);
    }
  });

  it("cannot poison cached trust through add, delete, clear, or borrowed Set methods", () => {
    const bundled = bundledV1Semantics();
    const first = bundled.definitions[0];
    if (first === undefined) throw new Error("Bundled semantic definition is missing");
    const changedDefinition = { ...first, version: "2" };
    const changedProfile = { ...bundled.profile, version: "2" };
    const changedDefinitionDigest = semanticDefinitionDigest(changedDefinition);
    const changedProfileDigest = semanticProfileDigest(changedProfile);
    const cases = [
      { trusted: bundled.trustedDefinitionDigests, injected: changedDefinitionDigest },
      { trusted: bundled.trustedProfileDigests, injected: changedProfileDigest },
    ];

    for (const { trusted, injected } of cases) {
      const original = [...trusted];
      const existing = original[0];
      if (existing === undefined) throw new Error("Bundled trust allowlist is empty");
      const mutable = trusted as Set<string>;
      expect(() => mutable.add(injected)).toThrow(TypeError);
      expect(() => mutable.delete(existing)).toThrow(TypeError);
      expect(() => mutable.clear()).toThrow(TypeError);
      expect(() => Set.prototype.add.call(trusted, injected)).toThrow(TypeError);
      expect(() => Set.prototype.delete.call(trusted, existing)).toThrow(TypeError);
      expect(() => Set.prototype.clear.call(trusted)).toThrow(TypeError);
      expect(trusted.has(injected)).toBe(false);
      expect([...trusted]).toEqual(original);
    }

    const cached = bundledV1Semantics();
    expect(admitSemanticProfile(cached).profileDigest).toBe(cached.profileDigest);
    expect(() => admitSemanticProfile({ ...cached, profile: changedProfile }))
      .toThrow(/Semantic profile digest is not release-allowlisted/);
    expect(() => admitSemanticProfile({
      ...cached,
      definitions: [changedDefinition, ...cached.definitions.slice(1)],
    })).toThrow(/Semantic definition digest is not release-allowlisted/);
  });
});
