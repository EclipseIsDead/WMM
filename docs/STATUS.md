# Implementation status

This is an implementation inventory against [RFC WMM-001 v0.3](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md), not a substitute for or a claim of full RFC conformance. Removing the `plans/` ignore rule revealed the existing original attachments; they were hidden from the earlier project listing, not absent from disk.

## Milestone gates

| Increment | Implemented | Still required |
| --- | --- | --- |
| V0: identities and bounded semantics | Canonical safe-integer JSON, immutable semantic admission, identity vectors, scope/evidence/temporal/result contracts | Contracts remain draft; broaden independent semantic conformance and resource characterization before freezing |
| V1: inspect a world | Verified directory bundles, record/roster closure, deterministic metadata export, strict versioned stdin API | RFC gate still lacks pinned domain revision resolution and byte-preserving prose export; not a hostile-directory sandbox |
| V2: historical questions | Active-claim queries; independent exact-point absence and certified exact-interval absence subset; roster-bound coverage; positive/negative witness preservation; receipt integrity and snapshot replay; deterministic interval work/cell/output bounds | Broader certified change providers beyond recorded applicability; historical conflict/impact checks; pagination, deadlines, and resource characterization |
| V3: steer alternatives | U1/U2 and a bounded U3 candidate-review subset: durable fixed-snapshot workspaces, explicit selections, deterministic candidate compilation, candidate-bound diffs/receipts, bounded semantic/reference and protection checks | Broader candidate-bound historical query/conflict/impact validation (full U3), trusted host approval (U4); full V3 is not complete |
| V4: commit safely | Revision-envelope types/hashing only | Domain revision storage, expected-head acceptance, canonical idempotency, journal recovery, fault-injection matrix |
| V5: alternate canon | Not implemented | Forks, retcons, comparison, fast-forward promotion |
| V6: recover/exchange | Metadata export, bounded structured-project → WMM snapshot → linked DM-note projection, and cited entity dossiers | Coordinated backups/restore, portable assets, arbitrary vault import, two-way note sync, broader context, and actor-knowledge policies |

The source-code Git repository is not the planned Git-backed domain revision store. Durable draft mutations now exist; accepted canonical-world writes do not. A workspace pins `{worldId, snapshotDigest}`, not a domain revision ID. The editor labels that identity as the base snapshot; it is not a Git revision.

## Agent authoring slice

The [structured authoring guide](AUTHORING.md) describes the first end-to-end data/projection slice. A closed, readable authoring project contains stable named entities, explicitly declared invariant relationships, labelled narrative sections, citations, and campaign-scoped bounded integer tracks. The compiler builds fresh ordinary WMM bundles; the renderer reads a reloaded bundle and verifies correspondence with its captured project before producing deterministic linked DM notes. Imported citations remain distinct from stipulation support and historical truth. Existing profiles/fixtures are not rewritten, and normal world/API/workspace paths accept the additional release-owned profile.

This is not a vault copier, an LLM migration service, a finalized universal world schema, or accepted canonical storage. Private input/derived artifacts stay outside the tooling repository. Workspace-to-project round trips, assets/plugins, custom calendars, dated event history, approval, and canonical commits are not added.

The opt-in `context entity` command now builds deterministic snapshot/input/profile-bound DM-side packets from verified authored bundles, without scraping rendered notes or modifying state. It selects direct relationships, own/explicitly referencing sections, and selected-campaign current tracks, retaining citations and assertion/document identities. Canonical byte/item budgets omit whole items with explicit coverage counts; current state takes priority. This is not an actor-knowledge filter, model call, roleplayed decision, or new `wmm/1` operation. See [the context contract](AUTHORING.md#entity-context-for-an-agent-harness).

## Workspace slices

The [workspace implementation brief](../plans/WMM-V3-WORKSPACE-IMPLEMENTATION-BRIEF.md) divides V3 into executable slices:

| Slice | Current boundary |
| --- | --- |
| U1: inspect comfortably | React/Ink editor with Changes, World, Constraints, History, and Review; real application-supplied base documents/record summaries and before/proposed effects; 80x24 baseline, split panes at 100+ columns, plain/non-TTY and JSON modes |
| U2: persist decisions | Shared `wmm/1` create/read/mutate operations, typed prose alternatives, machine assertion admission, durable decisions/proposal versions/pins/direction, transactional SQLite, expected versions, replay-before-version-check idempotency, and restart recovery |
| U3: review the candidate | Bounded `workspace.review` combines only explicitly selected prose/assertion operations into a deterministic candidate and returns a bound diff/receipt; it checks selection, operations, semantic/reference closure, pins, and explicit opposition | General candidate-bound historical query, proof, conflict, and impact validation remain incomplete; no general history-truth judgment |
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
- `workspace.review` compiles only explicitly selected operations and binds its candidate/review digests and diff to the exact workspace version, base snapshot, semantic profile, selected groups, and steering. Receipts are stored separately without advancing the workspace version; later edits make them stale. Work exhaustion is incomplete `BUDGET_EXCEEDED` with no new receipt.
- Application-enforced prose path/base-hash admission and exact document/active-assertion pin binding. Pin violations are selected-draft diagnostics, not arbitrary narrative constraints or completed historical validation.
- Terminal-safe Unicode presentation without executing imported controls; grapheme-aware forms, retained failed-save buffers, explicit retries, and host-owned external editing without a shell.
- Strict source/test typechecking, adversarial regression fixtures, and an existing macOS/Linux engine CI workflow.

These are implemented bounds, not general security or accessibility certification. Local `pnpm run check` passed 1,117 tests across 53 files, seed vectors, and strict source/test typechecks under Node 26.12.1. `pnpm verify:workspace` passed all four real-PTY smoke scenarios on macOS; release packing and isolated release verification also passed. No hosted CI result, Linux PTY execution, or screen-reader certification is claimed. The default Node 22.14.0 on this host is below the declared Node >=24.3.0 requirement. [WORKSPACE.md](WORKSPACE.md#validation) lists focused and broader validation commands. See [STABILIZATION.md](STABILIZATION.md) for exact contracts, compatibility changes, and remaining limitations.

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

The bounded U3 review compiles selected operations and runs real WMM semantic/reference, pin, and explicit-opposition checks; it is not a general historical proof or impact engine and does not automatically run `claims.query` or `absence.*` against the candidate. The candidate is built in memory; the API returns its snapshot digest and combined diff in a bound, replayable receipt, not a portable candidate bundle. Full U3 remains open. U4 needs durable host-only approval. Extend supported V2 proof/conflict scenarios beyond the exact recorded-applicability subset, and do not enable accepted writes before approval and the V4 acceptance/recovery protocol have their own executable gates. Pinned domain revision resolution, byte-preserving portable export, forks/retcons/comparison/promotion, and coordinated backup/restore remain open RFC work.
