import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateWorldRecord } from "../src/index.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/v1/complete-world/", import.meta.url),
);
const snapshot = JSON.parse(readFileSync(`${fixtureRoot}/snapshot.json`, "utf8")) as {
  manifest: { files: readonly { path: string }[] };
};
const recordPaths = snapshot.manifest.files
  .map((entry) => entry.path)
  .filter((path) => path === "world.json" || path.startsWith("records/"));

describe("production V1 world record schema", () => {
  it("accepts the snapshot wrapper and every catalogued record", () => {
    const records = [
      JSON.parse(readFileSync(`${fixtureRoot}/snapshot.json`, "utf8")) as unknown,
      ...recordPaths.map(
        (path) => JSON.parse(readFileSync(`${fixtureRoot}/payload/${path}`, "utf8")) as unknown,
      ),
    ];
    expect(records).toHaveLength(14);
    for (const record of records) {
      const result = validateWorldRecord(record);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });

  it("rejects malformed support IDs and open record shapes", () => {
    const supportPath = recordPaths.find((path) => path.startsWith("records/supports/"));
    if (supportPath === undefined) throw new Error("Support fixture is missing");
    const support = JSON.parse(
      readFileSync(`${fixtureRoot}/payload/${supportPath}`, "utf8"),
    ) as Record<string, unknown>;
    expect(validateWorldRecord({ ...support, id: "support:not-content-addressed" }).valid).toBe(
      false,
    );
    expect(validateWorldRecord({ ...support, extra: true }).valid).toBe(false);
  });
});
