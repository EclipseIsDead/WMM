import type { WorkspaceErrorCodeV1, WorkspaceRequestV1, WorkspaceViewV1 } from "./workspace.js";

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

export interface PointTemporalQueryV1 {
  readonly format: "wmm.temporal-query/1";
  readonly mode: "at";
  readonly axisDefinitionDigest: DigestHex;
  readonly position: string;
}

export interface IntervalTemporalQueryV1 {
  readonly format: "wmm.temporal-query/1";
  readonly mode: "intersects" | "throughout";
  readonly axisDefinitionDigest: DigestHex;
  readonly start: string;
  readonly endExclusive: string;
}

export type ThroughoutTemporalQueryV1 = IntervalTemporalQueryV1 & {
  readonly mode: "throughout";
};

export type TemporalQueryV1 = PointTemporalQueryV1 | IntervalTemporalQueryV1;

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

export interface ClaimQueryItemV1 {
  readonly assertionId: AssertionId;
  readonly polarity: "positive" | "negative";
  readonly scope: ScopeComparisonV1;
  readonly temporal: TemporalComparisonV1;
  readonly evidence: EvidenceStatusV1;
  readonly familySupport: FamilySupportV1;
}

export interface ClaimQueryResultV1 {
  readonly format: "wmm.claim-query-result/1";
  readonly scope: ScopeV1;
  readonly temporal: TemporalQueryV1;
  readonly definite: readonly ClaimQueryItemV1[];
  readonly possible: readonly ClaimQueryItemV1[];
  readonly unresolved: readonly ClaimQueryItemV1[];
  readonly excluded: readonly ClaimQueryItemV1[];
  readonly scopeCoverage: "exhaustive";
}

export interface RosterV1 {
  readonly format: "wmm.roster/1";
  readonly worldId: WorldId;
  readonly populationDefinitionDigest: DigestHex;
  readonly memberIds: readonly RecordId[];
}

export interface CoverageInputSelectionV1 {
  readonly format: "wmm.coverage-input/1";
  readonly worldId: WorldId;
  readonly populationDefinitionDigest: DigestHex;
  readonly selectorDefinitionDigest: DigestHex;
  readonly scope: ScopeV1;
  readonly applicability: ApplicabilityV1;
  readonly primitiveClaimIds: readonly AssertionId[];
  readonly candidateBirthDigests: readonly DigestHex[];
}

export interface AbsenceCoverageCheckV1 {
  readonly assertionId: AssertionId;
  readonly basis: PopulationCoverageBasisV1;
  readonly inputSelection: CoverageInputSelectionV1;
  readonly inputSelectionDigest: DigestHex;
  readonly roster: RosterV1 | null;
  readonly status: "matched" | "selector-mismatch" | "input-stale" | "roster-missing" | "roster-mismatch";
}

export interface PopulationCoverageBasisV1 {
  readonly format: "wmm.population-coverage-basis/1";
  readonly populationDefinitionDigest: DigestHex;
  readonly selectorDefinitionDigest: DigestHex;
  readonly rosterDigest: DigestHex;
  readonly inputSelectionDigest: DigestHex;
  readonly coverageMethod: "authorAttested" | "sourceEnumeration";
}

export interface AbsenceInputSelectionV1 {
  readonly format: "wmm.absence-input-selection/1";
  readonly worldId: WorldId;
  readonly snapshotDigest: DigestHex;
  readonly target: ExistsV1;
  readonly scope: ScopeV1;
  readonly temporal: PointTemporalQueryV1;

  readonly membershipAssertionIds: readonly AssertionId[];
}

export interface AbsenceCandidateEvaluationV1 {
  readonly candidateId: RecordId;
  readonly membershipAssertionIds: readonly AssertionId[];
  readonly membership: "member" | "nonmember" | "possible" | "conflicting" | "unresolved";
  readonly eligibilityAssertionIds: readonly AssertionId[];
  readonly eligibility:
    | "eligible"
    | "possibly-eligible"
    | "ineligible"
    | "conflicting"
    | "unresolved";
}

interface AbsenceEvaluationBaseV1 {
  readonly format: "wmm.absence-evaluation-receipt/1";
  readonly algorithm: "bundled-absence-point-v3";
  readonly inputSelection: AbsenceInputSelectionV1;
  readonly inputSelectionDigest: DigestHex;
  readonly positiveCoverageAssertionIds: readonly AssertionId[];
  readonly negativeCoverageAssertionIds: readonly AssertionId[];
  readonly staleCoverageAssertionIds: readonly AssertionId[];
  readonly selectedCoverageAssertionId: AssertionId | null;
  readonly coverageChecks: readonly AbsenceCoverageCheckV1[];
  readonly premiseAssertionIds: readonly AssertionId[];
  readonly eligibilityAssertionIds: readonly AssertionId[];
  readonly candidates: readonly AbsenceCandidateEvaluationV1[];
}

export type AbsenceEvaluationBodyV1 =
  | (AbsenceEvaluationBaseV1 & {
      readonly status: "established";
      readonly reason: "all-candidates-ineligible";
    })
  | (AbsenceEvaluationBaseV1 & {
      readonly status: "not-established";
      readonly reason:
        | "coverage-not-established"
        | "coverage-roster-mismatch"
        | "coverage-roster-missing"
        | "coverage-input-stale"
        | "coverage-selector-mismatch"
        | "coverage-conflicted"
        | "coverage-unresolved"
        | "membership-not-established"
        | "membership-conflicted"
        | "membership-unresolved"
        | "candidate-eligibility-conflicted"
        | "candidate-eligibility-unresolved"
        | "recorded-witness";
    })
  | (AbsenceEvaluationBaseV1 & {
      readonly status: "unsupported";
      readonly reason: "unsupported-semantics";
    });

export type AbsenceEvaluationReceiptV1 = AbsenceEvaluationBodyV1 & {
  readonly evaluationDigest: DigestHex;
};

export interface AbsenceQueryResultV1 {
  readonly format: "wmm.absence-query-result/1";
  readonly target: ExistsV1;
  readonly scope: ScopeV1;
  readonly temporal: PointTemporalQueryV1;
  readonly conclusion: {
    readonly status:
      | "absence-declared"
      | "absence-derived"
      | "absence-declared-and-derived"
      | "witness-recorded"
      | "conflicting"
      | "absence-not-established"
      | "unresolved";
    readonly bases: readonly ("declared" | "derived")[];
  };
  readonly declaration: {
    readonly status: "recorded" | "possible" | "unresolved" | "not-recorded";
    readonly definiteAssertionIds: readonly AssertionId[];
    readonly possibleAssertionIds: readonly AssertionId[];
    readonly unresolvedAssertionIds: readonly AssertionId[];
  };
  readonly witnesses: {
    readonly status: "recorded" | "possible" | "unresolved" | "none-recorded";
    readonly existentialAssertionIds: readonly AssertionId[];
    readonly possibleExistentialAssertionIds: readonly AssertionId[];
    readonly unresolvedExistentialAssertionIds: readonly AssertionId[];
    readonly candidateIds: readonly RecordId[];
    readonly possibleCandidateIds: readonly RecordId[];
    readonly unresolvedCandidateIds: readonly RecordId[];
  };
  readonly derivation: AbsenceEvaluationReceiptV1;
}

export interface IntervalAbsenceLimitsV1 {
  readonly maxCells: number;
  readonly maxWorkUnits: number;
}

export interface IntervalConstancyDeclarationV1 {
  readonly assertionId: AssertionId;
  readonly provider: "recorded-applicability-v1";
  readonly definitionDigests: readonly DigestHex[];
  readonly changePositions: readonly string[];
}

export interface IntervalPartitionIssueV1 {
  readonly assertionId: AssertionId | null;
  readonly reason:
    | "uncertain-change-position"
    | "unmapped-axis"
    | "unresolved-scope"
    | "unsupported-semantics"
    | "unsupported-primitive";
}

export interface IntervalAbsenceCellV1 {
  readonly start: string;
  readonly endExclusive: string;
  readonly representativePosition: string;
  readonly evaluation: AbsenceQueryResultV1;
}

interface IntervalAbsenceEvaluationBaseV1 {
  readonly format: "wmm.interval-absence-result/1";
  readonly algorithm: "bundled-absence-throughout-v1";
  readonly worldId: WorldId;
  readonly snapshotDigest: DigestHex;
  readonly target: ExistsV1;
  readonly scope: ScopeV1;
  readonly temporal: ThroughoutTemporalQueryV1;
  readonly limits: IntervalAbsenceLimitsV1;
  readonly execution: "completed";
  readonly breakpoints: readonly string[];
  readonly constancyDeclarations: readonly IntervalConstancyDeclarationV1[];
  readonly partitionIssues: readonly IntervalPartitionIssueV1[];
  readonly cells: readonly IntervalAbsenceCellV1[];
}

export type IntervalAbsenceEvaluationBodyV1 =
  | (IntervalAbsenceEvaluationBaseV1 & {
      readonly status: "established";
      readonly reason: "all-cells-ineligible";
    })
  | (IntervalAbsenceEvaluationBaseV1 & {
      readonly status: "not-established";
      readonly reason: "cell-not-established" | "recorded-witness" | "partition-unresolved";
    });

export type IntervalAbsenceResultV1 = IntervalAbsenceEvaluationBodyV1 & {
  readonly evaluationDigest: DigestHex;
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
  | "selector"
  | "criterion"
  | "axis"
  | "descriptorType"
  | "locator"
  | "interpretation";

export type SemanticOperationV1 =
  | "exact-tuple-multivalue-v1"
  | "text-value-v1"
  | "population-coverage-atom-v1"
  | "population-membership-atom-v1"
  | "criterion-satisfaction-atom-v1"
  | "population-coverage-basis-v1"
  | "retained-unicode-v1"
  | "safe-integer-literal-v1"
  | "integer-value-v1"
  | "bundled-candidate-membership-v1"
  | "bundled-candidate-selector-v1"
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

export type ApiOperationV1 =
  | "world.validate"
  | "record.inspect"
  | "world.export"
  | "claims.query"
  | "absence.query"
  | "absence.proveThroughout"
  | "workspace.create"
  | "workspace.read"
  | "workspace.review"
  | "workspace.mutate";

interface ApiRequestBaseV1 {
  readonly format: "wmm.request/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string;
}

export type ApiRequestV1 =
  | (ApiRequestBaseV1 & {
      readonly operation: "world.validate";
      readonly payload: { readonly bundlePath: string };
    })
  | (ApiRequestBaseV1 & {
      readonly operation: "record.inspect";
      readonly payload: {
        readonly bundlePath: string;
        readonly recordId: string;
      };
    })
  | (ApiRequestBaseV1 & {
      readonly operation: "world.export";
      readonly payload: { readonly bundlePath: string };
    })
  | (ApiRequestBaseV1 & {
      readonly operation: "claims.query";
      readonly payload: {
        readonly bundlePath: string;
        readonly scope: ScopeV1;
        readonly temporal: TemporalQueryV1;
      };
    })
  | (ApiRequestBaseV1 & {
      readonly operation: "absence.query";
      readonly payload: {
        readonly bundlePath: string;
        readonly target: ExistsV1;
        readonly scope: ScopeV1;
        readonly temporal: PointTemporalQueryV1;
      };
    })
  | (ApiRequestBaseV1 & {
      readonly operation: "absence.proveThroughout";
      readonly payload: {
        readonly bundlePath: string;
        readonly target: ExistsV1;
        readonly scope: ScopeV1;
        readonly temporal: ThroughoutTemporalQueryV1;
        readonly limits?: Partial<IntervalAbsenceLimitsV1>;
      };
    })
  | WorkspaceRequestV1;

export type ApiErrorCodeV1 =
  | "UNSUPPORTED_API_VERSION"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_REQUEST"
  | "INVALID_WORLD"
  | "UNKNOWN_RECORD"
  | "BUDGET_EXCEEDED"
  | "STORAGE_FAILURE"
  | "INTERNAL_ERROR"
  | WorkspaceErrorCodeV1;

export interface ResolvedSnapshotV1 {
  readonly worldId: WorldId;
  readonly snapshotDigest: DigestHex;
}

export interface WorldValidationReportV1 {
  readonly status: "valid";
  readonly worldId: WorldId;
  readonly snapshotDigest: DigestHex;
  readonly files: number;
  readonly descriptors: number;
  readonly sources: number;
  readonly assertions: number;
  readonly activeAssertions: number;
  readonly supports: number;
  readonly activeSupports: number;
}

export type InspectableRecordV1 =
  | RosterV1
  | WorldRecordV1
  | SemanticDefinitionV1
  | SemanticProfileV1;

export interface WorldExportV1 {
  readonly format: "wmm.world-export/1";
  readonly snapshotDigest: DigestHex;
  readonly world: WorldCatalogV1;
  readonly semanticProfile: SemanticProfileV1;
  readonly definitions: readonly {
    readonly digest: DigestHex;
    readonly body: SemanticDefinitionV1;
  }[];
  readonly rosters: readonly { readonly digest: DigestHex; readonly body: RosterV1 }[];
  readonly descriptors: readonly DescriptorRecordV1[];
  readonly sources: readonly SourceRecordV1[];
  readonly assertions: readonly AssertionRecordV1[];
  readonly supports: readonly SupportRecordV1[];
  readonly documents: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly sha256: DigestHex;
    readonly byteLength: string;
  }[];
}

export interface ApiResultByOperationV1 {
  readonly "world.validate": WorldValidationReportV1;
  readonly "record.inspect": InspectableRecordV1;
  readonly "world.export": WorldExportV1;
  readonly "claims.query": ClaimQueryResultV1;
  readonly "absence.query": AbsenceQueryResultV1;
  readonly "absence.proveThroughout": IntervalAbsenceResultV1;
  readonly "workspace.create": WorkspaceViewV1;
  readonly "workspace.read": WorkspaceViewV1;
  readonly "workspace.review": WorkspaceViewV1;
  readonly "workspace.mutate": WorkspaceViewV1;
}

export type ApiSuccessResponseV1 = {
  [Operation in ApiOperationV1]: {
    readonly format: "wmm.response/1";
    readonly apiVersion: "wmm/1";
    readonly requestId: string;
    readonly operation: Operation;
    readonly outcome: "success";
    readonly execution: "completed";
    readonly resolved: ResolvedSnapshotV1;
    readonly data: ApiResultByOperationV1[Operation];
    readonly diagnostics: readonly DiagnosticV1[];
  };
}[ApiOperationV1];

export interface ApiErrorResponseV1 {
  readonly format: "wmm.response/1";
  readonly apiVersion: "wmm/1";
  readonly requestId: string | null;
  readonly operation: string | null;
  readonly outcome: "error";
  readonly execution: "completed" | "incomplete";
  readonly error: {
    readonly code: ApiErrorCodeV1;
    readonly message: string;
  };
  readonly diagnostics: readonly DiagnosticV1[];
}

export type ApiResponseV1 = ApiSuccessResponseV1 | ApiErrorResponseV1;

export type ApiContractV1 = ApiRequestV1 | ApiResponseV1;

export type CoreContractV1 = ClaimBodyV1 | SnapshotManifestV1 | RevisionEnvelopeV1;

export type SemanticContractV1 =
  | SupportBodyV1
  | ScopeComparisonV1
  | EvidenceStatusV1
  | FamilySupportV1
  | TemporalQueryV1
  | TemporalComparisonV1
  | ClaimQueryResultV1
  | RosterV1
  | CoverageInputSelectionV1
  | PopulationCoverageBasisV1
  | AbsenceEvaluationReceiptV1
  | AbsenceQueryResultV1
  | IntervalAbsenceResultV1
  | CommonResponseV1
  | ValidationStatusV1;
