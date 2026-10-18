export type DigestHex = string;
export type WorldId = string;
export type RecordId = string;
export type AssertionId = string;
export type SupportId = string;
export type RevisionId = string;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ExactPositionV1 = {
  readonly kind: "exact";
  readonly position: string;
};

export type BoundedUnknownPositionV1 = {
  readonly kind: "boundedUnknown";
  readonly lowerInclusive: string;
  readonly upperExclusive: string;
};

export type UnknownPositionV1 = {
  readonly kind: "unknown";
};

export type InstantPositionV1 =
  | ExactPositionV1
  | BoundedUnknownPositionV1
  | UnknownPositionV1;

export type StartEndpointV1 =
  | InstantPositionV1
  | { readonly kind: "unboundedPast" };

export type EndEndpointV1 =
  | InstantPositionV1
  | { readonly kind: "unboundedFuture" };

export type ApplicabilityV1 =
  | { readonly kind: "invariant" }
  | {
      readonly kind: "point";
      readonly axisDefinitionDigest: DigestHex;
      readonly position: InstantPositionV1;
    }
  | {
      readonly kind: "interval";
      readonly axisDefinitionDigest: DigestHex;
      readonly start: StartEndpointV1;
      readonly endExclusive: EndEndpointV1;
    };

export type ScopeValueV1 =
  | { readonly kind: "ref"; readonly id: RecordId }
  | { readonly kind: "notApplicable" }
  | { readonly kind: "unresolved" };

export interface ScopeV1 {
  readonly account: ScopeValueV1;
  readonly jurisdiction: ScopeValueV1;
  readonly recognitionFrame: ScopeValueV1;
}

export type TypedValueV1 =
  | { readonly kind: "ref"; readonly id: RecordId }
  | {
      readonly kind: "literal";
      readonly valueDefinitionDigest: DigestHex;
      readonly data: JsonValue;
    };

export interface AtomV1 {
  readonly kind: "atom";
  readonly subjectId: RecordId;
  readonly predicateDefinitionDigest: DigestHex;
  readonly value: TypedValueV1;
}

export interface ExistsV1 {
  readonly kind: "exists";
  readonly population: {
    readonly descriptorId: RecordId;
    readonly definitionDigest: DigestHex;
  };
  readonly criterion: {
    readonly definitionDigest: DigestHex;
    readonly arguments: Readonly<Record<string, TypedValueV1>>;
  };
}

export interface ClaimBodyV1 {
  readonly format: "wmm.claim/1";
  readonly worldId: WorldId;
  readonly semanticProfileDigest: DigestHex;
  readonly proposition: AtomV1 | ExistsV1;
  readonly polarity: "positive" | "negative";
  readonly scope: ScopeV1;
  readonly applicability: ApplicabilityV1;
}

export interface SnapshotFileEntryV1 {
  readonly path: string;
  readonly mediaType:
    | "application/json"
    | "text/markdown"
    | "application/octet-stream";
  readonly byteLength: string;
  readonly sha256: DigestHex;
}

export interface SnapshotManifestV1 {
  readonly format: "wmm.snapshot-manifest/1";
  readonly worldId: WorldId;
  readonly files: readonly SnapshotFileEntryV1[];
}

export interface RevisionEnvelopeV1 {
  readonly format: "wmm.revision/1";
  readonly worldId: WorldId;
  readonly kind: "genesis" | "commit";
  readonly snapshotDigest: DigestHex;
  readonly parents: readonly RevisionId[];
  readonly operationsDigest: DigestHex;
  readonly rationale: string;
  readonly actorId: RecordId;
  readonly recordedAt: string;
  readonly approvalReceiptDigest: DigestHex;
  readonly idempotencyIntentDigest: DigestHex;
  readonly semanticProfileDigest: DigestHex;
  readonly validationReceiptDigest: DigestHex;
}

export interface SupportBodyV1 {
  readonly format: "wmm.support/1";
  readonly worldId: WorldId;
  readonly claimId: AssertionId;
  readonly sourceId: RecordId;
  readonly stance: "supports" | "challenges";
  readonly locator: {
    readonly definitionDigest: DigestHex;
    readonly data: JsonValue;
  };
  readonly interpretationMethodDefinitionDigest: DigestHex;
  readonly sourceContentDigest?: DigestHex;
}

export type ScopeComparisonValue = "same" | "different" | "unresolved";

export interface ScopeComparisonV1 {
  readonly format: "wmm.scope-comparison/1";
  readonly result: ScopeComparisonValue;
  readonly components: {
    readonly account: ScopeComparisonValue;
    readonly jurisdiction: ScopeComparisonValue;
    readonly recognitionFrame: ScopeComparisonValue;
  };
}

export interface EvidenceStatusV1 {
  readonly format: "wmm.evidence-status/1";
  readonly status:
    | "supported"
    | "challenged"
    | "supported-and-challenged"
    | "unsupported";
  readonly supportingIds: readonly RecordId[];
  readonly challengingIds: readonly RecordId[];
}

export interface FamilySupportV1 {
  readonly format: "wmm.family-support/1";
  readonly status: "positive-only" | "negative-only" | "both" | "neither";
  readonly positiveIds: readonly RecordId[];
  readonly negativeIds: readonly RecordId[];
}

export type TemporalQueryV1 =
  | {
      readonly format: "wmm.temporal-query/1";
      readonly mode: "at";
      readonly axisDefinitionDigest: DigestHex;
      readonly position: string;
    }
  | {
      readonly format: "wmm.temporal-query/1";
      readonly mode: "intersects" | "throughout";
      readonly axisDefinitionDigest: DigestHex;
      readonly start: string;
      readonly endExclusive: string;
    };

export type TemporalComparisonV1 =
  | {
      readonly format: "wmm.temporal-comparison/1";
      readonly kind: "comparable";
      readonly truth: "always" | "never" | "sometimes";
    }
  | {
      readonly format: "wmm.temporal-comparison/1";
      readonly kind: "incomparable";
      readonly reason: "unmappedAxis" | "missingBounds" | "unsupportedRelation";
    }
  | {
      readonly format: "wmm.temporal-comparison/1";
      readonly kind: "excluded";
      readonly reason: "applicabilityType";
    };

export interface DiagnosticV1 {
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "blocker";
  readonly message: string;
}

interface ResponseBaseV1 {
  readonly format: "wmm.response/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string;
  readonly diagnostics: readonly DiagnosticV1[];
}

export type CommonResponseV1 =
  | (ResponseBaseV1 & {
      readonly outcome: "success";
      readonly execution: "completed";
      readonly data: JsonValue;
    })
  | (ResponseBaseV1 & {
      readonly outcome: "partial";
      readonly execution: "incomplete";
      readonly data: JsonValue;
    })
  | (ResponseBaseV1 & {
      readonly outcome: "error";
      readonly execution: "completed" | "incomplete";
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    });

export type ValidationStatusV1 =
  | {
      readonly format: "wmm.validation-status/1";
      readonly execution: "completed";
      readonly validity: "valid" | "invalid";
    }
  | {
      readonly format: "wmm.validation-status/1";
      readonly execution: "incomplete";
      readonly validity: "invalid" | "undetermined";
    };

export type SemanticDefinitionKindV1 =
  | "predicate"
  | "literal"
  | "population"
  | "criterion"
  | "axis"
  | "descriptorType"
  | "locator"
  | "interpretation";

export type SemanticOperationV1 =
  | "exact-tuple-multivalue-v1"
  | "text-value-v1"
  | "population-coverage-atom-v1"
  | "retained-unicode-v1"
  | "bundled-candidate-membership-v1"
  | "bundled-eligibility-v1"
  | "integer-chronon-half-open-v1"
  | "descriptor-type-v1"
  | "author-stipulation-locator-v1"
  | "author-stipulation-interpretation-v1";

export interface SemanticDefinitionV1 {
  readonly format: "wmm.semantic-definition/1";
  readonly key: string;
  readonly kind: SemanticDefinitionKindV1;
  readonly operation: SemanticOperationV1;
  readonly version: string;
  readonly dependencies: readonly DigestHex[];
  readonly fixtureOnly?: boolean;
}

export interface SemanticProfileV1 {
  readonly format: "wmm.semantic-profile/1";
  readonly version: string;
  readonly definitions: readonly DigestHex[];
  readonly numericProfile: "safe-integer-json-v1";
  readonly propositionGrammar: "explicit-polarity-atom-exists-v1";
  readonly fixtureOnly?: boolean;
}

export interface DescriptorRecordV1 {
  readonly format: "wmm.descriptor/1";
  readonly worldId: WorldId;
  readonly id: RecordId;
  readonly birthTypeDefinitionDigest: DigestHex;
}

export type SourceContentV1 =
  | {
      readonly availability: "bundled";
      readonly path: string;
      readonly sha256: DigestHex;
    }
  | {
      readonly availability: "unavailable";
      readonly sha256: DigestHex;
    }
  | {
      readonly availability: "none";
    };

export interface SourceRecordV1 {
  readonly format: "wmm.source/1";
  readonly worldId: WorldId;
  readonly id: RecordId;
  readonly sourceType: "document" | "authorStipulation";
  readonly content: SourceContentV1;
}

export interface AssertionRecordV1 {
  readonly format: "wmm.assertion-record/1";
  readonly id: AssertionId;
  readonly body: ClaimBodyV1;
}

export interface SupportRecordV1 {
  readonly format: "wmm.support-record/1";
  readonly id: SupportId;
  readonly body: SupportBodyV1;
}

export interface WorldCatalogV1 {
  readonly format: "wmm.world/1";
  readonly worldId: WorldId;
  readonly semanticProfileDigest: DigestHex;
  readonly descriptorIds: readonly RecordId[];
  readonly sourceIds: readonly RecordId[];
  readonly assertionIds: readonly AssertionId[];
  readonly activeAssertionIds: readonly AssertionId[];
  readonly supportIds: readonly SupportId[];
  readonly activeSupportIds: readonly SupportId[];
}

export interface SnapshotRecordV1 {
  readonly format: "wmm.snapshot-record/1";
  readonly snapshotDigest: DigestHex;
  readonly manifest: SnapshotManifestV1;
}

export type WorldRecordV1 =
  | DescriptorRecordV1
  | SourceRecordV1
  | AssertionRecordV1
  | SupportRecordV1
  | WorldCatalogV1
  | SnapshotRecordV1;

export type CoreContractV1 = ClaimBodyV1 | SnapshotManifestV1 | RevisionEnvelopeV1;

export type SemanticContractV1 =
  | SupportBodyV1
  | ScopeComparisonV1
  | EvidenceStatusV1
  | FamilySupportV1
  | TemporalQueryV1
  | TemporalComparisonV1
  | CommonResponseV1
  | ValidationStatusV1;
