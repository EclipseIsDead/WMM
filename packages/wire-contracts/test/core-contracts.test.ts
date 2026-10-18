import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateCoreContract } from "../src/index.js";

interface SeedDocument {
  readonly vectors: readonly {
    readonly kind: string;
    readonly payload: unknown;
  }[];
  readonly schemaNegativeCases: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
}

const kitUrl = new URL("../../../wmm-v0.3-contract-kit/", import.meta.url);
const runtimeSchemaUrl = new URL("../schemas/core-contracts.schema.json", import.meta.url);
const seedSchemaUrl = new URL("core-contracts.schema.json", kitUrl);
const vectorsUrl = new URL("golden-vectors.json", kitUrl);

const document = JSON.parse(readFileSync(vectorsUrl, "utf8")) as SeedDocument;

describe("core contract schema", () => {
  it("is copied byte-for-byte from the v0.3 seed kit", () => {
    expect(readFileSync(runtimeSchemaUrl)).toEqual(readFileSync(seedSchemaUrl));
    expect(fileURLToPath(runtimeSchemaUrl)).toContain("packages/wire-contracts/schemas");
  });

  it("accepts every core identity vector", () => {
    const coreVectors = document.vectors.filter((vector) =>
      ["claim", "snapshot", "revision"].includes(vector.kind),
    );
    expect(coreVectors).toHaveLength(15);
    for (const vector of coreVectors) {
      expect(validateCoreContract(vector.payload)).toEqual({ valid: true, errors: [] });
    }
  });

  it("rejects every supplied negative shape", () => {
    expect(document.schemaNegativeCases).toHaveLength(7);
    for (const testCase of document.schemaNegativeCases) {
      const result = validateCoreContract(testCase.payload);
      expect(result.valid, testCase.name).toBe(false);
      expect(result.errors.length, testCase.name).toBeGreaterThan(0);
    }
  });
});
