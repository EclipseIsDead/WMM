import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ApiRequestV1,
  AssertionRecordV1,
  SupportRecordV1,
  WorldCatalogV1,
} from "@wmm/wire-contracts";
import { ClaimQueryInputError, queryActiveClaims } from "../src/index.js";

type ClaimsQueryRequest = Extract<ApiRequestV1, { readonly operation: "claims.query" }>;
type ResultGroup = "definite" | "possible" | "unresolved" | "excluded";

interface QueryFixture {
  readonly name: string;
  readonly request: ClaimsQueryRequest;
  readonly expected: Readonly<Record<ResultGroup, readonly string[]>>;
}

interface QueryFixtures {
  readonly requests: readonly QueryFixture[];
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

const world = readJson<WorldCatalogV1>(
  new URL("../../../fixtures/v1/complete-world/payload/world.json", import.meta.url),
);
const assertionDirectory = new URL(
  "../../../fixtures/v1/complete-world/payload/records/assertions/",
  import.meta.url,
);
const supportDirectory = new URL(
  "../../../fixtures/v1/complete-world/payload/records/supports/",
  import.meta.url,
);
const assertions = readdirSync(assertionDirectory)
  .sort()
  .map((name) => readJson<AssertionRecordV1>(new URL(name, assertionDirectory)));
const supports = readdirSync(supportDirectory)
  .sort()
  .map((name) => readJson<SupportRecordV1>(new URL(name, supportDirectory)));
const fixtures = readJson<QueryFixtures>(
  new URL("../../../fixtures/v2/claim-query-cases.json", import.meta.url),
);

const snapshot = {
  activeAssertionIds: world.activeAssertionIds,
  activeSupportIds: world.activeSupportIds,
  assertions,
  supports,
};

function ids(
  result: ReturnType<typeof queryActiveClaims>,
  group: ResultGroup,
): readonly string[] {
  return result[group].map((item) => item.assertionId);
}

describe("active claim querying", () => {
  for (const fixture of fixtures.requests) {
    it(fixture.name, () => {
      const result = queryActiveClaims(
        snapshot,
        fixture.request.payload.scope,
        fixture.request.payload.temporal,
      );
      for (const group of ["definite", "possible", "unresolved", "excluded"] as const) {
        expect(ids(result, group)).toEqual(fixture.expected[group]);
      }
      expect(result.scopeCoverage).toBe("exhaustive");
    });
  }

  it("uses active documentary supports without treating them as logical opposites", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing point-query fixture");
    const result = queryActiveClaims(
      snapshot,
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.definite).toHaveLength(7);
    for (const item of result.definite) {
      expect(item.evidence.status).toBe("supported");
      expect(item.evidence.supportingIds).toHaveLength(1);
      expect(item.familySupport.status).toBe(
        item.polarity === "positive" ? "positive-only" : "negative-only",
      );
    }
  });

  it("classifies uncertain temporal applicability as possible", () => {
    const base = assertions[0];
    if (base === undefined) throw new Error("Missing assertion fixture");
    const uncertain: AssertionRecordV1 = {
      id: `asrt:${"1".repeat(64)}`,
      format: "wmm.assertion-record/1",
      body: {
        ...base.body,
        applicability: {
          kind: "interval",
          axisDefinitionDigest:
            "8c82e615f363d8c4b497b49d497f8cf4f93727f60034ceb471d2bad7382f0667",
          start: {
            kind: "boundedUnknown",
            lowerInclusive: "1000",
            upperExclusive: "1010",
          },
          endExclusive: { kind: "exact", position: "1030" },
        },
      },
    };
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing point-query fixture");
    const result = queryActiveClaims(
      {
        activeAssertionIds: [uncertain.id],
        activeSupportIds: [],
        assertions: [uncertain],
        supports: [],
      },
      fixture.request.payload.scope,
      fixture.request.payload.temporal,
    );
    expect(result.possible.map((item) => item.assertionId)).toEqual([uncertain.id]);
  });

  it("rejects an empty temporal query interval as request input", () => {
    const fixture = fixtures.requests[0];
    if (fixture === undefined) throw new Error("Missing point-query fixture");
    expect(() =>
      queryActiveClaims(snapshot, fixture.request.payload.scope, {
        format: "wmm.temporal-query/1",
        mode: "throughout",
        axisDefinitionDigest:
          "8c82e615f363d8c4b497b49d497f8cf4f93727f60034ceb471d2bad7382f0667",
        start: "1000",
        endExclusive: "1000",
      }),
    ).toThrow(ClaimQueryInputError);
  });
});
