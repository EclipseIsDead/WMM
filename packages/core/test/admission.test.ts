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
