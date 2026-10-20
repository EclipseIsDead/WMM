# Implementation status

This is an implementation inventory against [RFC WMM-001 v0.3](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md), not a substitute for or a claim of full RFC conformance. Removing the `plans/` ignore rule revealed the existing original attachments; they were hidden from the earlier project listing, not absent from disk.

## Milestone gates

| Increment | Implemented | Still required |
| --- | --- | --- |
| V0: identities and bounded semantics | Canonical safe-integer JSON, immutable semantic admission, identity vectors, scope/evidence/temporal/result contracts | Contracts remain draft; broaden independent semantic conformance and resource characterization before freezing |
| V1: inspect a world | Verified directory bundles, record/roster closure, deterministic metadata export, strict versioned stdin API | RFC gate still lacks pinned domain revision resolution and byte-preserving prose export; not a hostile-directory sandbox |
| V2: historical questions | Active-claim queries; independent exact-point absence and certified exact-interval absence subset; roster-bound coverage; positive/negative witness preservation; receipt integrity and snapshot replay; deterministic interval work/cell/output bounds | Broader certified change providers beyond recorded applicability; historical conflict/impact checks; pagination, deadlines, and resource characterization |
| V3: steer alternatives | Not implemented | Durable workspaces, immutable proposals, selections, rejections, pins, restart recovery, trusted host approval |
| V4: commit safely | Revision-envelope types/hashing only | Domain revision storage, expected-head acceptance, canonical idempotency, journal recovery, fault-injection matrix |
| V5: alternate canon | Not implemented | Forks, retcons, comparison, fast-forward promotion |
| V6: recover/exchange | Metadata export view only | Coordinated backups/restore, portable assets, linked notes and bounded context |

The source-code Git repository is not the planned Git-backed domain revision store. No accepted authoring-write operation exists yet.

## Stabilization guarantees

- Strict syntax/duplicate-key checks followed by native JSON materialization; inherited fields do not satisfy requests.
- Unicode-scalar strings and plain-data API admission; malformed correlation data is not echoed into serialization.
- Operation-discriminated success payload schemas/types. Unexpected application failures are not reported as invalid worlds.
- Bounded stdin reads, actual-inode file limits, directory/depth/cardinality limits, reserved-namespace rejection, no-follow file opens, and consistency checks.
- Deeply frozen admitted semantics and non-mutating trust-set views; behaviorful identity inputs are rejected.
- Population coverage binds explicit canonical roster bytes, the selector, primitive membership inputs, and candidate birth identities at the claim's own scope/applicability. Changing a selected input requires explicit renewed coverage.
- Definite positive witnesses remain recorded under contrary evidence; unknown or negative-only eligibility does not manufacture a positive witness.
- Exact interval partitions require complete certified relevant change positions, including a point premise's position and successor. Relevant uncertainty or unmapped axes yields completed `not-established`, not sampled proof.
- Interval work/cell/output exhaustion yields incomplete `BUDGET_EXCEEDED` with no result/receipt; these limits are not wall-clock deadlines or isolation guarantees.
- Separate hash-integrity checks and replay against adapter-verified snapshot content, including partition reconstruction and cell evaluation for interval receipts.
- Strict source/test typechecking, adversarial regression fixtures, and a macOS/Linux CI workflow.

These are implemented bounds, not a claim of general security certification. Local validation of this increment passed `pnpm check` (535 tests across 33 files, seed vectors, and strict source/test typechecks), the compiled V0/seed/V1/V2 commands, and fixture regeneration without byte drift. Hosted CI results are not claimed. See [STABILIZATION.md](STABILIZATION.md) for the exact contracts, compatibility changes, and remaining limitations.

## RFC §5.6: implemented interval subset

`absence.proveThroughout` is separate from the unchanged point-only `absence.query`. It accepts a finite exact `[start,endExclusive)` query on one integer axis and uses the bundled recorded-applicability constancy provider. The receipt binds the query/snapshot, effective limits, sorted breakpoints, constancy declarations, partition issues, and point-evaluation results for each certified nonempty half-open cell. Point and successor boundaries isolate a one-chronon witness without changing the event's stored applicability type.

- Every cell must independently establish exhaustive roster-bound ineligibility. A declared absence is retained as a declaration, not promoted to a derived interval proof.
- A definite witness in any cell yields `not-established` / `recorded-witness`. Missing coverage or other failed cell proofs yields `not-established` / `cell-not-established`.
- Potentially relevant uncertain changes, unresolved scope, unmapped axes, or unsupported constancy providers yield completed `not-established` / `partition-unresolved` with explicit issues, rather than speculative cell evaluation. Definitely irrelevant claims do not block certification; the separate conservative coverage-input commitment still applies.
- Cell/work/output budget exhaustion is incomplete execution, not a completed negative answer, and emits no receipt. `maxCells` and `maxWorkUnits` are interval request limits; point queries do not inherit them.
- Integrity-only receipt checks cannot establish that all relevant boundaries or true cell results were supplied. Snapshot replay reconstructs both from adapter-verified content; neither check authenticates an author or grants write permission.

This closes only the recorded explicit-premise portion of §5.6. There is no general temporal solver, calculated threshold/age evaluator, or rule/institutional-rule change provider implied by this increment. Regression coverage includes invariant-axis admission, unused-roster irrelevance, rehashed false partitions/conclusions, byte amplification, oversized imported partitions, and adjacent receipt-node limits.

## Deferred deliberately

Arbitrary schema execution, recursive rule programming, divergent merging, and a universal succession simulator are not prerequisites for the next authoring increment. The current bundled eligibility primitive evaluates explicit eligibility assertions; it does not calculate age, inheritance law, or legitimacy.

## Before V3

Extend supported V2 proof/conflict scenarios beyond the exact recorded-applicability subset and retain explicit completeness/execution results. Do not enable accepted writes before durable approval and the V4 acceptance/recovery protocol have their own executable gates. Preserve the first useful product goal: inspect a proposed change, select the outcomes the author wants, remember their steering, and preserve alternate canon.
