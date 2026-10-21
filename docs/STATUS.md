# Implementation status

This is an implementation inventory against [RFC WMM-001 v0.3](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md), not a substitute for or a claim of full RFC conformance. Removing the `plans/` ignore rule revealed the existing original attachments; they were hidden from the earlier project listing, not absent from disk.

## Milestone gates

| Increment | Implemented | Still required |
| --- | --- | --- |
| V0: identities and bounded semantics | Canonical safe-integer JSON, immutable semantic admission, identity vectors, scope/evidence/temporal/result contracts | Contracts remain draft; broaden independent semantic conformance and resource characterization before freezing |
| V1: inspect a world | Verified directory bundles, record/roster closure, deterministic metadata export, strict versioned stdin API | RFC gate still lacks pinned domain revision resolution and byte-preserving prose export; not a hostile-directory sandbox |
| V2: historical questions | Active-claim queries; independent exact-point absence and certified exact-interval absence subset; roster-bound coverage; positive/negative witness preservation; receipt integrity and snapshot replay; deterministic interval work/cell/output bounds | Broader certified change providers beyond recorded applicability; historical conflict/impact checks; pagination, deadlines, and resource characterization |
| V3: steer alternatives | U1/U2 subset implemented: base-world inspection, durable fixed-snapshot workspaces and proposal versions, explicit selections/rejections, exact base-bound pins, advisory direction, historical workspace reads, restart recovery | Full combined candidate historical validation (U3), candidate-bound results and trusted host approval (U4); full V3 is not complete |
| V4: commit safely | Revision-envelope types/hashing only | Domain revision storage, expected-head acceptance, canonical idempotency, journal recovery, fault-injection matrix |
| V5: alternate canon | Not implemented | Forks, retcons, comparison, fast-forward promotion |
| V6: recover/exchange | Metadata export view only | Coordinated backups/restore, portable assets, linked notes and bounded context |

The source-code Git repository is not the planned Git-backed domain revision store. Durable draft mutations now exist; accepted canonical-world writes do not. A workspace pins `{worldId, snapshotDigest}`, not a domain revision ID. The editor labels that identity as the base snapshot; it is not a Git revision.

## Workspace slices

The [workspace implementation brief](../plans/WMM-V3-WORKSPACE-IMPLEMENTATION-BRIEF.md) divides V3 into executable slices:

| Slice | Current boundary |
| --- | --- |
| U1: inspect comfortably | React/Ink editor with Changes, World, Constraints, History, and Review; real application-supplied base documents/record summaries and before/proposed effects; 80x24 baseline, split panes at 100+ columns, plain/non-TTY and JSON modes |
| U2: persist decisions | Shared `wmm/1` create/read/mutate operations, typed prose alternatives, machine assertion admission, durable decisions/proposal versions/pins/direction, transactional SQLite, expected versions, replay-before-version-check idempotency, and restart recovery |
| U3: review the candidate | Unavailable. Prerequisite/exclusion, exact-pin, and conflicting-prose diagnostics exist, but full combined historical validation remains `not-run` |
| U4: authorize explicitly | Unavailable. No host approval receipt or authorization operation; no V4 commit capability |

Launch `node apps/cli/dist/main.js workspace demo --workspace-dir ./wmm-workspaces/succession` after building, or use `pnpm workspace:demo` to build and launch. Repeating the demo resumes it. A normal `workspace open fixtures/v1/complete-world --workspace-dir ./wmm-workspaces/my-world` starts with empty proposals and no demo pins. `workspace resume --workspace-dir ./wmm-workspaces/my-world` reads the captured base even if the source has gone. IDs default to `main`; `--plain` and `--json` are explicit output alternatives.

The host-owned directory contains `authoring.sqlite` in WAL mode, the immutable admitted base including document bytes, and all saved state versions. The source is untouched. Historical state is readable with `workspace.read` / `atVersion`; there is no workspace-list/fork command or separate proposal-history API. See [WORKSPACE.md](WORKSPACE.md) for commands, keyboard controls, machine requests, limits, and recovery.

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
- Transactional workspace creation/mutation with immutable bases/state versions, stale-write rejection, and durable original-outcome replay before version checking; no source-world writes.
- Application-enforced prose path/base-hash admission and exact document/active-assertion pin binding. Pin violations are selected-draft diagnostics, not arbitrary narrative constraints or completed historical validation.
- Terminal-safe Unicode presentation without executing imported controls; grapheme-aware forms, retained failed-save buffers, explicit retries, and host-owned external editing without a shell.
- Strict source/test typechecking, adversarial regression fixtures, and an existing macOS/Linux engine CI workflow.

These are implemented bounds, not general security or accessibility certification. Local `pnpm check` passed 793 tests across 42 files, seed vectors, and strict source/test typechecks. All four real-PTY smoke scenarios passed on macOS. No hosted CI result, Linux PTY execution, or screen-reader certification is claimed. `pnpm verify:workspace` builds and runs the Python-standard-library terminal smoke; [WORKSPACE.md](WORKSPACE.md#validation) lists focused and broader validation commands. See [STABILIZATION.md](STABILIZATION.md) for exact contracts, compatibility changes, and remaining limitations.

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

## Before full V3 and canonical writes

U1/U2 now let an author inspect explicit alternatives and durably remember steering; they do not validate the combined candidate, authorize it, or preserve alternate canon as a domain branch. U3 must reuse real WMM validation with candidate-bound completeness/execution results, not a fixture-specific validator. U4 needs durable host-only approval. Extend supported V2 proof/conflict scenarios beyond the exact recorded-applicability subset, and do not enable accepted writes before approval and the V4 acceptance/recovery protocol have their own executable gates. Pinned domain revision resolution, byte-preserving portable export, forks/retcons/comparison/promotion, and coordinated backup/restore remain open RFC work.
