import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  canonicalJsonBytes,
  framedSha256Hex,
  sha256Hex,
} from "@wmm/canonical";
import {
  type JsonValue,
  type SnapshotManifestV1,
  validateCoreContract,
} from "@wmm/wire-contracts";

interface SeedVector {
  readonly name: string;
  readonly kind: string;
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
  readonly schemaNegativeCases: readonly {
    readonly name: string;
    readonly payload: unknown;
  }[];
}

export interface ContractKitVerificationReport {
  readonly status: "passed";
  readonly vectors: number;
  readonly schemaPositiveCases: number;
  readonly schemaNegativeCases: number;
  readonly identityRelations: number;
  readonly manifestFilesChecked: number;
}

function assertEqual(actual: string, expected: string | undefined, context: string): void {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${expected ?? "<missing>"}, received ${actual}`);
  }
}

export function verifyContractKit(kitPath: string): ContractKitVerificationReport {
  const kitRoot = resolve(kitPath);
  const document = JSON.parse(
    readFileSync(resolve(kitRoot, "golden-vectors.json"), "utf8"),
  ) as SeedDocument;
  const byName = new Map<string, SeedVector>();
  let schemaPositiveCases = 0;

  for (const vector of document.vectors) {
    let digest: string;
    if (vector.algorithm === "sha256-raw") {
      const bytes = Buffer.from(vector.payloadHex ?? "", "hex");
      assertEqual(bytes.toString("hex"), vector.payloadHex, `${vector.name} raw bytes`);
      digest = sha256Hex(bytes);
    } else {
      if (vector.payload === undefined) throw new Error(`${vector.name}: missing payload`);
      const canonicalBytes = canonicalJsonBytes(vector.payload);
      assertEqual(
        Buffer.from(canonicalBytes).toString("hex"),
        vector.canonicalUtf8Hex,
        `${vector.name} canonical bytes`,
      );
      const preimage = Buffer.concat([
        Buffer.from(vector.label, "ascii"),
        Buffer.from([0]),
        Buffer.from(canonicalBytes),
      ]);
      assertEqual(preimage.toString("hex"), vector.preimageHex, `${vector.name} preimage`);
      digest = framedSha256Hex(vector.label, canonicalBytes);
    }

    assertEqual(digest, vector.digest, `${vector.name} digest`);
    assertEqual(`${vector.idPrefix}${digest}`, vector.expectedId, `${vector.name} ID`);

    if (["claim", "snapshot", "revision"].includes(vector.kind)) {
      const validation = validateCoreContract(vector.payload);
      if (!validation.valid) {
        throw new Error(`${vector.name}: core schema rejected a positive vector`);
      }
      schemaPositiveCases += 1;
    }

    if (byName.has(vector.name)) throw new Error(`Duplicate vector name: ${vector.name}`);
    byName.set(vector.name, vector);
  }

  for (const relation of document.relations) {
    if (relation.kind !== "different") throw new Error("Unsupported identity relation");
    if (byName.get(relation.left)?.expectedId === byName.get(relation.right)?.expectedId) {
      throw new Error(`Expected different identities: ${relation.left}, ${relation.right}`);
    }
  }

  for (const testCase of document.schemaNegativeCases) {
    if (validateCoreContract(testCase.payload).valid) {
      throw new Error(`${testCase.name}: negative schema case was accepted`);
    }
  }

  const snapshotVector = byName.get("snapshot_lf");
  if (snapshotVector?.payload === undefined) throw new Error("Missing snapshot_lf vector");
  const snapshot = snapshotVector.payload as unknown as SnapshotManifestV1;
  const fixtureRoot = resolve(kitRoot, "fixture-payload");
  let previousPath = "";
  for (const entry of snapshot.files) {
    if (entry.path <= previousPath) throw new Error("Manifest paths are not strictly sorted");
    previousPath = entry.path;

    const filePath = resolve(fixtureRoot, entry.path);
    if (!filePath.startsWith(`${fixtureRoot}${sep}`)) {
      throw new Error(`Fixture path escapes payload root: ${entry.path}`);
    }
    const bytes = readFileSync(filePath);
    assertEqual(String(bytes.length), entry.byteLength, `${entry.path} byte length`);
    assertEqual(sha256Hex(bytes), entry.sha256, `${entry.path} digest`);
  }

  return {
    status: "passed",
    vectors: document.vectors.length,
    schemaPositiveCases,
    schemaNegativeCases: document.schemaNegativeCases.length,
    identityRelations: document.relations.length,
    manifestFilesChecked: snapshot.files.length,
  };
}
