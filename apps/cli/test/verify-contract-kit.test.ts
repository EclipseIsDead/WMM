import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyContractKit } from "../src/verify-contract-kit.js";

const kitPath = fileURLToPath(
  new URL("../../../wmm-v0.3-contract-kit/", import.meta.url),
);

describe("contract-kit verifier", () => {
  it("verifies the complete supplied seed kit", () => {
    expect(verifyContractKit(kitPath)).toEqual({
      status: "passed",
      vectors: 31,
      schemaPositiveCases: 15,
      schemaNegativeCases: 7,
      identityRelations: 8,
      manifestFilesChecked: 12,
    });
  });
});
