import { createHash } from "node:crypto";
import { types } from "node:util";

import type {
  AbsenceEvaluationBodyV1,
  AbsenceInputSelectionV1,
  IntervalAbsenceEvaluationBodyV1,
  ClaimBodyV1,
  JsonValue,
  CoverageInputSelectionV1,
  DescriptorRecordV1,
  RosterV1,
  RevisionEnvelopeV1,
  SemanticDefinitionV1,
  SemanticProfileV1,
  SnapshotManifestV1,
  SupportBodyV1,
} from "@wmm/wire-contracts";

export type CanonicalizationErrorCode =
  | "DEPTH_LIMIT"
  | "INVALID_UNICODE"
  | "NON_JSON_VALUE"
  | "UNSAFE_NUMBER"
  | "CYCLIC_VALUE"
  | "SPARSE_ARRAY"
  | "NON_PLAIN_OBJECT"
  | "HIDDEN_PROPERTY";

export class CanonicalizationError extends TypeError {
  readonly code: CanonicalizationErrorCode;

  constructor(code: CanonicalizationErrorCode, message: string) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const DEFAULT_MAX_DEPTH = 128;

function quoteScalarString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError("INVALID_UNICODE", "Lone high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalizationError("INVALID_UNICODE", "Lone low surrogate");
    }
  }
  return JSON.stringify(value);
}

function canonicalize(
  value: unknown,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
): string {
  if (depth > maxDepth) {
    throw new CanonicalizationError(
      "DEPTH_LIMIT",
      `Canonical JSON nesting exceeds ${maxDepth}`,
    );
  }

  if (value === null) return "null";
  if (typeof value === "string") return quoteScalarString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        "UNSAFE_NUMBER",
        "The WMM v1 hash profile accepts only safe JSON integers",
      );
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new CanonicalizationError(
      "NON_JSON_VALUE",
      `Unsupported JSON value type: ${typeof value}`,
    );
  }

  if (types.isProxy(value)) {
    throw new CanonicalizationError(
      "NON_PLAIN_OBJECT",
      "Proxies are outside the canonical JSON profile",
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalizationError("CYCLIC_VALUE", "Cyclic values are not JSON");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const length = value.length;
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= length
        ) {
          throw new CanonicalizationError(
            "HIDDEN_PROPERTY",
            "Arrays may not contain non-index properties",
          );
        }
      }

      const elements: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) {
          throw new CanonicalizationError(
            "SPARSE_ARRAY",
            "Sparse arrays are outside the canonical JSON profile",
          );
        }
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new CanonicalizationError(
            "HIDDEN_PROPERTY",
            "Arrays may contain only enumerable data elements",
          );
        }
        elements.push(canonicalize(descriptor.value, depth + 1, maxDepth, ancestors));
      }
      return `[${elements.join(",")}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new CanonicalizationError(
        "NON_PLAIN_OBJECT",
        "Only ordinary JSON objects are accepted",
      );
    }

    const ownKeys = Reflect.ownKeys(value);
    const stringKeys = Object.keys(value);
    if (ownKeys.length !== stringKeys.length) {
      throw new CanonicalizationError(
        "HIDDEN_PROPERTY",
        "Objects may not contain symbols or non-enumerable properties",
      );
    }

    stringKeys.sort();
    const properties = stringKeys.map((key) => {
      const quotedKey = quoteScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new CanonicalizationError(
          "HIDDEN_PROPERTY",
          "Objects may contain only enumerable data properties",
        );
      }
      return `${quotedKey}:${canonicalize(descriptor.value, depth + 1, maxDepth, ancestors)}`;
    });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: JsonValue, maxDepth = DEFAULT_MAX_DEPTH): string {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError("maxDepth must be a nonnegative safe integer");
  }
  return canonicalize(value, 0, maxDepth, new Set<object>());
}

export function canonicalJsonBytes(
  value: JsonValue,
  maxDepth = DEFAULT_MAX_DEPTH,
): Uint8Array {
  return encoder.encode(canonicalJson(value, maxDepth));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDomainLabel(label: string): void {
  if (label.length === 0) throw new TypeError("Hash domain label must not be empty");
  for (const character of label) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 0 || codePoint > 0x7f) {
      throw new TypeError("Hash domain label must be non-NUL ASCII");
    }
  }
}

export function framedSha256Hex(label: string, payloadBytes: Uint8Array): string {
  assertDomainLabel(label);
  const hash = createHash("sha256");
  hash.update(encoder.encode(label));
  hash.update(Uint8Array.of(0));
  hash.update(payloadBytes);
  return hash.digest("hex");
}

export function framedJsonDigest(label: string, payload: JsonValue): string {
  return framedSha256Hex(label, canonicalJsonBytes(payload));
}

export function assertionId(body: ClaimBodyV1): string {
  return `asrt:${framedJsonDigest("wmm.assertion/v1", body as unknown as JsonValue)}`;
}

export function snapshotDigest(manifest: SnapshotManifestV1): string {
  return framedJsonDigest("wmm.snapshot/v1", manifest as unknown as JsonValue);
}

export function revisionId(envelope: RevisionEnvelopeV1): string {
  return `rev:${framedJsonDigest("wmm.revision/v1", envelope as unknown as JsonValue)}`;
}

export function semanticDefinitionDigest(definition: SemanticDefinitionV1): string {
  return framedJsonDigest(
    "wmm.semantic-definition/v1",
    definition as unknown as JsonValue,
  );
}

export function semanticProfileDigest(profile: SemanticProfileV1): string {
  return framedJsonDigest("wmm.semantic-profile/v1", profile as unknown as JsonValue);
}

export function supportDigest(support: SupportBodyV1): string {
  return framedJsonDigest("wmm.support/v1", support as unknown as JsonValue);
}

export function populationRosterDigest(roster: RosterV1): string {
  return framedJsonDigest("wmm.roster/v1", roster as unknown as JsonValue);
}

export function descriptorBirthDigest(descriptor: DescriptorRecordV1): string {
  return framedJsonDigest("wmm.descriptor-birth/v1", descriptor as unknown as JsonValue);
}

export function coverageInputSelectionDigest(selection: CoverageInputSelectionV1): string {
  return framedJsonDigest("wmm.coverage-input/v1", selection as unknown as JsonValue);
}

export function absenceInputSelectionDigest(
  selection: AbsenceInputSelectionV1,
): string {
  return framedJsonDigest(
    "wmm.absence-input-selection/v1",
    selection as unknown as JsonValue,
  );
}

export function absenceEvaluationDigest(evaluation: AbsenceEvaluationBodyV1): string {
  return framedJsonDigest(
    "wmm.absence-evaluation/v1",
    evaluation as unknown as JsonValue,
  );
}

export function intervalAbsenceEvaluationDigest(evaluation: IntervalAbsenceEvaluationBodyV1): string {
  return framedJsonDigest(
    "wmm.interval-absence-evaluation/v1",
    evaluation as unknown as JsonValue,
  );
}

export function supportId(support: SupportBodyV1): string {
  return `sup:${supportDigest(support)}`;
}

export function propositionFamilyDigest(body: ClaimBodyV1): string {
  const { polarity: _polarity, ...familyBody } = body;
  return framedJsonDigest(
    "wmm.proposition-family/v1",
    familyBody as unknown as JsonValue,
  );
}
