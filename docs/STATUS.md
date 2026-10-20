# Implementation status

This is an implementation inventory against [RFC WMM-001 v0.3](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md), not a substitute for or a claim of full RFC conformance. Removing the `plans/` ignore rule revealed the existing original attachments; they were hidden from the earlier project listing, not absent from disk.

## Milestone gates

| Increment | Implemented | Still required |
| --- | --- | --- |
| V0: identities and bounded semantics | Canonical safe-integer JSON, immutable semantic admission, identity vectors, scope/evidence/temporal/result contracts | Contracts remain draft; broaden independent semantic conformance and resource characterization before freezing |
| V1: inspect a world | Verified directory bundles, record/roster closure, deterministic metadata export, strict versioned stdin API | RFC gate still lacks pinned domain revision resolution and byte-preserving prose export; not a hostile-directory sandbox |
| V2: historical questions | Active-claim queries; roster-bound exact-point absence; positive/negative witness preservation; receipt integrity and snapshot replay | Interval-wide proofs/change partitions; broader historical conflict checks; query budgets and pagination |
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
- Separate hash-integrity checks and replay against adapter-verified snapshot content.
- Strict source/test typechecking, adversarial regression fixtures, and a macOS/Linux CI workflow.

These are tested bounds, not a claim of general security certification. See [STABILIZATION.md](STABILIZATION.md) for the exact contracts, compatibility changes, and remaining limitations.

## Deferred deliberately

Arbitrary schema execution, recursive rule programming, divergent merging, and a universal succession simulator are not prerequisites for the next authoring increment. The current bundled eligibility primitive evaluates explicit eligibility assertions; it does not calculate age, inheritance law, or legitimacy.

## Before V3

Finish the supported V2 proof/conflict scenarios and retain explicit completeness/execution results. Do not enable accepted writes before durable approval and the V4 acceptance/recovery protocol have their own executable gates. Preserve the first useful product goal: inspect a proposed change, select the outcomes the author wants, remember their steering, and preserve alternate canon.
