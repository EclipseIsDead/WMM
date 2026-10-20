import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { JsonValue } from "@wmm/wire-contracts";
import {
  CanonicalizationError,
  canonicalJson,
  canonicalJsonBytes,
  framedSha256Hex,
  sha256Hex,
} from "../src/index.js";

interface SeedVector {
  readonly name: string;
  readonly algorithm: string;
  readonly label: string;
  readonly payload?: JsonValue;
  readonly payloadHex?: string;
  readonly canonicalUtf8Hex?: string;
  readonly preimageHex?: string;
  readonly digest: string;
  readonly idPrefix: string;
  readonly expectedId: string;
}

interface SeedDocument {
  readonly vectors: readonly SeedVector[];
  readonly relations: readonly {
    readonly kind: "different";
    readonly left: string;
    readonly right: string;
  }[];
}

const kitUrl = new URL("../../../wmm-v0.3-contract-kit/", import.meta.url);
const document = JSON.parse(
  readFileSync(new URL("golden-vectors.json", kitUrl), "utf8"),
) as SeedDocument;

describe("WMM v0.3 identity vectors", () => {
  it("matches all canonical bytes, framed preimages, digests, and typed IDs", () => {
    expect(document.vectors).toHaveLength(31);

    for (const vector of document.vectors) {
      let digest: string;
      if (vector.algorithm === "sha256-raw") {
        const bytes = Buffer.from(vector.payloadHex ?? "", "hex");
        expect(bytes.toString("hex"), vector.name).toBe(vector.payloadHex);
        digest = sha256Hex(bytes);
      } else {
        expect(vector.payload, vector.name).toBeDefined();
        const canonicalBytes = canonicalJsonBytes(vector.payload as JsonValue);
        expect(Buffer.from(canonicalBytes).toString("hex"), vector.name).toBe(
          vector.canonicalUtf8Hex,
        );
        const preimage = Buffer.concat([
          Buffer.from(vector.label, "ascii"),
          Buffer.from([0]),
          Buffer.from(canonicalBytes),
        ]);
        expect(preimage.toString("hex"), vector.name).toBe(vector.preimageHex);
        digest = framedSha256Hex(vector.label, canonicalBytes);
      }

      expect(digest, vector.name).toBe(vector.digest);
      expect(`${vector.idPrefix}${digest}`, vector.name).toBe(vector.expectedId);
    }
  });

  it("preserves every expected identity distinction", () => {
    const byName = new Map(document.vectors.map((vector) => [vector.name, vector]));
    expect(document.relations).toHaveLength(8);
    for (const relation of document.relations) {
      expect(relation.kind).toBe("different");
      expect(byName.get(relation.left)?.expectedId).not.toBe(
        byName.get(relation.right)?.expectedId,
      );
    }
  });
});

describe("restricted canonical JSON profile", () => {
  it("orders keys by UTF-16 code units", () => {
    expect(canonicalJson({ "\ue000": 1, "😀": 2 })).toBe('{"😀":2,"":1}');
    expect(canonicalJson({ "2": 2, "10": 10 })).toBe('{"10":10,"2":2}');
  });

  it("rejects array accessors repeatedly without invoking or mutating them", () => {
    const value: JsonValue[] = [0];
    let reads = 0;
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        reads += 1;
        value.push(reads);
        return reads;
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => canonicalJson(value)).toThrow(/enumerable data elements/);
    }
    expect(reads).toBe(0);
    expect(value.length).toBe(1);
  });

  it("rejects non-enumerable array elements", () => {
    const value = [1];
    Object.defineProperty(value, "0", { enumerable: false });
    expect(() => canonicalJson(value)).toThrow(/enumerable data elements/);
  });

  it.each(["4294967295", "4294967296", "9007199254740993"])(
    "rejects numeric array property %s outside the array-index range",
    (key) => {
      const value = [1];
      Object.defineProperty(value, key, { value: 2, enumerable: true });
      expect(value.length).toBe(1);
      expect(() => canonicalJson(value)).toThrow(/non-index properties/);
    },
  );

  it("rejects object accessors without invoking them", () => {
    let reads = 0;
    const value = {
      get changing() { return ++reads; },
    };
    expect(() => canonicalJson(value)).toThrow(/enumerable data properties/);
    expect(reads).toBe(0);
  });

  it.each([[], {}])("rejects proxies without invoking their traps", (target) => {
    let traps = 0;
    const value = new Proxy(target, {
      get() { traps += 1; return traps; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys() { traps += 1; return []; },
      getOwnPropertyDescriptor() { traps += 1; return undefined; },
    });
    expect(() => canonicalJson(value)).toThrow(/Proxies/);
    expect(traps).toBe(0);
  });

  it("keeps dense plain data deterministic, including shared non-cyclic values", () => {
    const shared = Object.freeze({ z: 2, a: 1 });
    const value = Object.freeze([shared, shared]);
    expect(canonicalJson(value)).toBe('[{"a":1,"z":2},{"a":1,"z":2}]');
    expect(canonicalJson(value)).toBe(canonicalJson(value));
  });

  it("rejects values outside the v1 profile", () => {
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalizationError);
    expect(() => canonicalJson(2 ** 53)).toThrow(/safe JSON integers/);
    expect(() => canonicalJson(0.5)).toThrow(/safe JSON integers/);

    const sparse: JsonValue[] = [];
    sparse.length = 1;
    expect(() => canonicalJson(sparse)).toThrow(/Sparse arrays/);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic as JsonValue)).toThrow(/Cyclic/);
  });
});
