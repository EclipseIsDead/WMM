import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ClaimBodyV1,
  SemanticDefinitionV1,
  SemanticProfileV1,
} from "@wmm/wire-contracts";
import {
  propositionFamilyDigest,
  semanticDefinitionDigest,
  semanticProfileDigest,
} from "../src/index.js";

const kitUrl = new URL("../../../wmm-v0.3-contract-kit/", import.meta.url);
const positiveClaim = JSON.parse(
  readFileSync(
    new URL(
      "fixture-payload/records/assertions/ef2bd1b1c292116ea078c3e3afa91317bd4396fb45df56e2b6d34bf3bc8228ee.json",
      kitUrl,
    ),
    "utf8",
  ),
) as ClaimBodyV1;

describe("semantic identity helpers", () => {
  it("matches semantic definition and profile filenames", () => {
    const definition = JSON.parse(
      readFileSync(
        new URL(
          "fixture-payload/types/a745a6be62e742b7b0b946ba7ac9428ca509ee5d146789e93cc40089326e3a23.json",
          kitUrl,
        ),
        "utf8",
      ),
    ) as SemanticDefinitionV1;
    const profile = JSON.parse(
      readFileSync(
        new URL(
          "fixture-payload/types/f8261941017e82915cb9be65e1bc0d86fa6c894a0d81bb8d925350d9e4daed26.json",
          kitUrl,
        ),
        "utf8",
      ),
    ) as SemanticProfileV1;

    expect(semanticDefinitionDigest(definition)).toBe(
      "a745a6be62e742b7b0b946ba7ac9428ca509ee5d146789e93cc40089326e3a23",
    );
    expect(semanticProfileDigest(profile)).toBe(
      "f8261941017e82915cb9be65e1bc0d86fa6c894a0d81bb8d925350d9e4daed26",
    );
  });

  it("groups opposite polarities into the same exact proposition family", () => {
    const negativeClaim: ClaimBodyV1 = { ...positiveClaim, polarity: "negative" };
    expect(propositionFamilyDigest(positiveClaim)).toBe(
      propositionFamilyDigest(negativeClaim),
    );
  });
});
