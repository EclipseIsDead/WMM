# Read-only engine stabilization contracts

## Compatibility boundary

The API envelope remains `wmm/1`, but these contracts are pre-release drafts. Roster-bound coverage stabilization tightened operation payload validation and replaced the draft self-referential coverage value with a pinned roster-bound literal. The bundled coverage predicate definition is version `2`; that literal dependency changed population/profile digests and therefore affected claim/support/snapshot identities. The exact-interval increment is an additional read-only operation, not a further coverage-profile migration.

Older bundles are not silently rewritten or reinterpreted by admission. Recompile draft worlds explicitly against the bundled profile. Previously generated absence receipts use `bundled-absence-point-v1`; the final roster/input-bound evaluation uses `bundled-absence-point-v3` (superseding the intermediate membership-only draft v2), and old receipts do not pass the new shape/replay contract. The independent `absence.proveThroughout` operation adds `wmm.interval-absence-result/1` / `bundled-absence-throughout-v1`; it does not widen the point-only `absence.query` contract or change its algorithm. The immutable v0.3 seed kit and its golden identity vectors are unchanged.

`pnpm generate:fixtures` rebuilds both the production world and V2 request/expected-result fixtures. The V2 generator constructs point and interval expectations from the fixture's explicit known roles and boundaries, and constructs the expected point receipt directly; it does not call the claim, point-absence, or interval-proof evaluator to produce expected answers.

## Roster-bound coverage

A coverage claim is still an ordinary signed `Atom`, with normal scope, applicability, evidence, activation, and retraction. Its subject is the population descriptor. Its value is the bundled coverage-basis literal:

```json
{
  "format": "wmm.population-coverage-basis/1",
  "populationDefinitionDigest": "<pinned population definition>",
  "selectorDefinitionDigest": "<pinned selector definition>",
  "rosterDigest": "<digest of the canonical roster artifact>",
  "inputSelectionDigest": "<digest of selected primitive claims and candidate births>",
  "coverageMethod": "authorAttested"
}
```

The canonical roster artifact is `{format: "wmm.roster/1", worldId, populationDefinitionDigest, memberIds}` with sorted unique member IDs. Its domain-separated digest uses `wmm.roster/v1`; the actual artifact bytes live at `payload/rosters/<digest>.json`. Loading validates path, bytes, digest, member order and references. Inspection and typed export preserve rosters explicitly. A coverage reference without available roster bytes yields `coverage-roster-missing`, not proof.

The separate `CoverageInputSelectionV1` contains:

- `format: wmm.coverage-input/1`, world, population and selector definition digests;
- the **coverage assertion's own scope and applicability**, not a substituted query point;
- all active primitive Atom IDs in the selector's declared membership families, of both polarities, across every population/scope/time variant;
- birth-record digests for every descriptor of the selector's declared candidate type, including candidates without membership claims.

Its hash domain is `wmm.coverage-input/v1`; immutable descriptor birth records use `wmm.descriptor-birth/v1`. Every hash uses the UTF-8 domain label, a zero byte, and canonical JSON bytes. Neither the snapshot, coverage/support records, eligibility rows, nor coverage-dependent conclusions enter the coverage-input hash. The evaluation receipt may bind a snapshot separately without introducing a cycle.

This deliberately conservative first profile invalidates coverage when a declared primitive input or candidate birth is added, deactivated or replaced—even outside the query's scope/time. A matching digest identifies inputs; it does not prove the authorial completeness premise. `coverageMethod` also supports `sourceEnumeration` as an accepted coverage premise; documentary evidence remains separate under this bundled profile.

Stale coverage remains inspectable, not a corrupt world. Receipt `coverageChecks` identify selector, input, missing-roster and roster mismatches. `staleCoverageAssertionIds` cannot establish completeness; an author can explicitly renew coverage after reviewing changed inputs. Every roster member must be definitely a member and explicitly ineligible. Extra candidates are eliminated only by definite nonmembership; unresolved membership blocks the exhaustive route.

This profile refuses empty-roster derivation, even if empty-roster coverage was explicitly renewed. Direct negative existential stipulations do not require coverage or documentary corroboration.

## Witness composition

Candidate witness support is computed from positive membership and positive eligibility support before considering contrary claims. Negative support is retained in candidate status and may block a derivation; it does not erase a recorded positive witness. Possible temporal support remains separate from unresolved scope/axis support. Missing eligibility or definite negative-only eligibility is not a recorded eligible witness against an authorial declaration.

## Exact interval absence subset

The implemented subset of [RFC §5.6](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md#56-exact-interval-wide-absence-proofs) is deliberately narrower than a general historical proof engine:

- `absence.query` accepts exact-point `at` queries independently of the interval operation.
- `absence.proveThroughout` accepts only a finite exact half-open `[start,endExclusive)` query with `mode: throughout` on an admitted integer axis, even when every premise is invariant. It does not reinterpret `at` or `intersects` as a universal interval question.
- The bundled `recorded-applicability-v1` provider certifies piecewise constancy for relevant explicit membership, coverage, eligibility, and existential premises. Invariants and exact same-axis point/interval boundaries are supported; explicitly unbounded premise endpoints contribute no finite boundary in that direction. The query itself must remain finite and exact.
- This does not implement a general relative-time solver, computed age/eligibility thresholds, upstream rule execution, or institutional-rule change providers. Such semantics need their own admitted complete-change/constancy contract; accepting interval-shaped inputs is not certification.

The partition includes both query endpoints and every certified in-range relevant change, deduplicated and sorted by integer value, not lexically or through floating-point conversion. A point premise at `p` contributes `p` and `p + 1`, clipped to the query range. The resulting one-chronon cell is an evaluation device: the stored point stays an event, and the ordinary applicability matrix still excludes a point claim from a heterogeneous `throughout` claim query.

Only after the complete relevant partition is certified does the evaluator use one representative per nonempty half-open cell and apply the existing roster/input-bound point evaluator. Every cell must establish exhaustive ineligibility for interval `status: established` / `reason: all-cells-ineligible`. A declaration alone does not satisfy that test. A definite positive witness in any cell blocks the universal absence (`recorded-witness`); missing/stale coverage, unresolved membership/eligibility, or any other unestablished cell blocks it (`cell-not-established`). Neither an empty search nor a handful of sampled dates is an interval proof.

Potentially relevant uncertain change positions, unmapped axes, unresolved scope, or unsupported semantics/providers yield `execution: completed`, `status: not-established`, `reason: partition-unresolved`, with specific `partitionIssues` and no speculative cell evaluations. Definitely irrelevant claims need not block certification. This relevance filtering does not relax the separate conservative coverage-input hash: even an excluded membership variant can still require renewed coverage.

The completed interval result serves as its receipt. It binds world/snapshot, target, scope, exact query, effective limits, numeric breakpoints, constancy declarations with provider/definition references, partition issues, full per-cell point results and their coverage/roster/premise receipts, and an interval evaluation digest. A receipt recording `not-established` is an explanation, not an absence proof.

### Interval proof budgets

`payload.limits` can set `maxCells` (default 256, maximum 1,024) and `maxWorkUnits` (default 2,000,000, maximum 50,000,000); both require positive integers. Work accounting includes JSON nodes, escaped UTF-8 scalar/key bytes, and conservative reservations for repeated cell contexts, candidate/coverage scans and hashing. Completed receipts are additionally limited to 150,000 value nodes and 8 MiB; conservative preallocation bounds can reject earlier. Imported receipt verification enforces the same output caps and rejects excessive breakpoint counts before processing declarations.

Exceeding a work, cell, or output budget returns `BUDGET_EXCEEDED` with `execution: incomplete` (CLI exit `4`), without success data or a result/receipt. It must not return `not-established`, truncate the partition into a proof, or expose a partial receipt as a completed evaluation.

These are interval-operation limits, not changes to `absence.query`, wall-clock deadlines, cancellation, pagination, or CPU/memory isolation. They do not bound bundle loading time or promise a fixed whole-process peak heap size.

## Receipt checks

- `verifyAbsenceReceiptIntegrity(receipt)` validates the closed shape and recomputes roster, selection, and evaluation digests. Its result is tagged `verification: integrity-only`. It is not authentication or proof.
- `verifyAbsenceEvaluationReceipt(receipt, snapshot)` additionally checks snapshot/world binding and deterministically replays the evaluation. Its result is tagged `verification: snapshot-replay`.
- `verifyAbsenceQueryResult(result, snapshot)` also replays the top-level declaration, witness, and conclusion dimensions.
- `verifyIntervalAbsenceReceiptIntegrity(receipt)` checks the closed interval result shape and interval/nested receipt digests. It is tagged `verification: integrity-only`; an attacker can rehash fabricated constancy declarations or cell conclusions, so digest agreement is not a certified partition or proof.
- `verifyIntervalAbsenceReceipt(receipt, snapshot)` independently reconstructs the relevant partition and replays the cell results against the verified snapshot, including world/snapshot/query binding and effective limits. It is tagged `verification: snapshot-replay`, not authentication.

The snapshot argument must come from an adapter that has verified the snapshot manifest, record identities, semantic allowlist, and reference closure. The pure kernel does not accept an imported receipt as the authority for its own snapshot. Replay does not authenticate an author or confer commit permission.

## Input and storage limits

| Boundary | Limit |
| --- | --- |
| CLI input | 1 MiB; reads at most one extra byte, rejects immediately without waiting for EOF after exceeding the limit |
| CLI parsing | 128 container levels, 100,000 nodes including property names |
| Direct API/semantic plain-data preflight | 128 levels, 200,000 value nodes |
| Snapshot or individual payload file | 10 MiB actual opened-inode size |
| Total bundle | 100 MiB actual bytes, including `snapshot.json` |
| Manifest/payload files | 10,000 |
| Traversed entries | 20,000 |
| Observed directories | 1,000 |
| Payload directory depth | 32 |

File allocation follows opened-inode size checks, not manifest declarations. Reads cannot grow past that observed size. Manifest cardinality is checked before the expensive schema pass. Unknown reserved `records/` families are rejected rather than silently omitted.

File opens use no-follow/nonblocking flags and metadata/inode consistency checks. **Node does not provide `openat`-style atomic parent confinement here.** Load bundles from a private, stable directory if another process could change parent directories. These checks do not establish safety against an adversary concurrently swapping directory ancestors.

Under-limit stdin still waits for EOF. Apart from the deterministic interval-proof work/cell/output bounds above, general query resource characterization remains deferred. Operation deadlines, query pagination, cancellation, CPU/memory isolation, and large-world performance guarantees are not implemented. Size/count limits do not imply constant-time schema validation or a fixed peak heap size.

## Errors and export

Loader errors distinguish `INVALID_WORLD`, `FILESYSTEM_ERROR`, and `INTERNAL_ERROR`. The application maps filesystem failures to `STORAGE_FAILURE`, preserves explicit input rejection, and reports unexpected failures as incomplete internal errors. Symlinks intentionally rejected by the loader are invalid bundle input.

Every success operation has a matching payload schema. JSON-mode failures, including Unicode and serialization failures, stay in `wmm.response/1` and its documented exit-code classes.

`world.export` is a deterministic record/document-metadata view. It does not contain document bytes or a restorable manifest and must not be advertised as a portable backup. Coordinated backup and lossless exchange remain V6 work.

## Verification and remaining work

`pnpm check` passed locally: seed vectors, strict source/test typechecks, and 535 tests across 33 files. The compiled `verify:v0`, `verify:seed`, `verify:v1`, and `verify:v2` commands also passed. V2 includes claim, point-absence, and interval-proof requests (`fixtures/v2/interval-request.json`). Regenerating fixtures produced no byte drift, and `git diff --check` was clean. Independent review findings were fixed and retained as regressions, including byte amplification and receipt-node boundary cases. CI is configured for Linux and macOS; no hosted CI run is claimed.

The existing [original RFC](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md) is now visible after removing the `plans/` ignore rule. [STATUS.md](STATUS.md) compares the implemented boundary with its milestone gates; it does not declare the contracts frozen. Remaining product work includes pinned domain revisions and byte-preserving prose export, certified interval change providers beyond recorded applicability, general historical conflict validation, durable steering/approval, domain revision crash recovery, branches, and coordinated backups.
