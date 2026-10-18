import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyV0Contracts } from "../src/verify-v0.js";

const kitPath = fileURLToPath(
  new URL("../../../wmm-v0.3-contract-kit/", import.meta.url),
);
const casesPath = fileURLToPath(
  new URL("../../../fixtures/v0/semantic-contract-cases.json", import.meta.url),
);

describe("V0 executable contract verifier", () => {
  it("verifies identities and bounded semantic fixtures", () => {
    expect(verifyV0Contracts(kitPath, casesPath)).toMatchObject({
      status: "passed",
      identity: { status: "passed", vectors: 31 },
      scopeCases: 4,
      evidenceCases: 4,
      familyCases: 4,
      temporalCases: 17,
      temporalInvalidCases: 3,
      semanticSchemaNegativeCases: 6,
    });
  });
});
