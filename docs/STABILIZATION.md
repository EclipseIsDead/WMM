# Engine and workspace stabilization contracts

## Compatibility boundary

The API envelope remains `wmm/1`, but these contracts are pre-release drafts. U1/U2 add `workspace.create`, `workspace.read`, and `workspace.mutate` for durable draft authoring; the bounded U3 subset adds `workspace.review` for deterministic candidate compilation and review. Existing read-only world/claim/absence operations and their CLI usage are unchanged. This does not add canonical-world acceptance, a domain revision store, or full V3 conformance. Roster-bound coverage stabilization tightened operation payload validation and replaced the draft self-referential coverage value with a pinned roster-bound literal. The bundled coverage predicate definition is version `2`; that literal dependency changed population/profile digests and therefore affected claim/support/snapshot identities. The exact-interval increment is an additional read-only operation, not a further coverage-profile migration.

Older bundles are not silently rewritten or reinterpreted by admission. Recompile draft worlds explicitly against the bundled profile. Previously generated absence receipts use `bundled-absence-point-v1`; the final roster/input-bound evaluation uses `bundled-absence-point-v3` (superseding the intermediate membership-only draft v2), and old receipts do not pass the new shape/replay contract. The independent `absence.proveThroughout` operation adds `wmm.interval-absence-result/1` / `bundled-absence-throughout-v1`; it does not widen the point-only `absence.query` contract or change its algorithm. The immutable v0.3 seed kit and its golden identity vectors are unchanged.

`pnpm generate:fixtures` rebuilds the production world, V2 request/expected-result fixtures, and the worked workspace demo. The V2 generator constructs point and interval expectations from the fixture's explicit known roles and boundaries, and constructs the expected point receipt directly; it does not call the claim, point-absence, or interval-proof evaluator to produce expected answers.

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

## U1/U2 and bounded U3 workspace contract

The terminal components, plain/JSON gateway, and machine clients use the same application service and wire operations. `packages/core` owns pure draft actions, candidate compilation, dependency/selection calculations, and bounded candidate checks; `packages/application` admits operations against the captured base, coordinates reviews, and constructs readable effects; `packages/ports` defines `WorkspaceStore`; `packages/store-authoring-sqlite` supplies durable draft and review storage. The UI neither computes canonical identities nor evaluates historical truth. See [WORKSPACE.md](WORKSPACE.md) for runnable commands and the controller's actual shortcuts.

### Captured base and transactional persistence

- Creation loads a verified WMM bundle once and captures its snapshot, exported world data, and exact document bytes in the authoring database. A normal world starts without demo proposals/pins; only explicit `succession-demo` mode seeds the worked alternatives.
- The base is pinned by `{worldId, snapshotDigest}` and cannot change in place. This is a snapshot digest, **not** a domain revision ID or Git revision; output labels it as the base snapshot. Resume and historical reads use the captured base, not the original directory, and survive source movement, mutation, or removal.
- `authoring.sqlite` uses WAL, `synchronous=FULL`, foreign keys, and `BEGIN IMMEDIATE` transactions. Bases, state versions, and idempotent outcomes are append-only through the store and guarded against update/delete by SQLite triggers. Each successful mutation adds one workspace version; failed admission/stale writes roll back without consuming an outcome key.
- `workspace.review` requires an exact `expectedVersion`, rechecks that version under the store write lock, and appends a separately stored immutable receipt. It does not advance the semantic workspace version. A mutation outcome freezes the review association it returned; a later receipt cannot change an idempotent replay's original view.
- Mutations require `expectedVersion` and an `idempotencyKey`. The application canonicalizes normalized intent without the transport `requestId`. A matching saved outcome is replayed **before** the current-version check and returns its original state version; reusing a key for a different intent returns `IDEMPOTENCY_CONFLICT`. CLI open/demo presentation reads the latest state after a create replay.
- `workspace.read` accepts optional `atVersion`; all saved state versions, including their proposal contents, remain retained. There is no workspace-list/fork operation, separate historical-proposal API, in-place rebase, or history-pruning operation. A new independent workspace is not a linked rebase or alternate-canon branch.

The trusted host selects the database directory using `json --workspace-dir <directory>` or its application-service configuration. Database paths are not request-payload authority. The CLI requires source and authoring directories to be separate, neither containing the other, and rejects storage inside a world bundle, symlink database paths/sidecars, and incompatible database identities/schemas. Use a private stable directory: these guards are not an adversarial-filesystem sandbox or a coordinated backup protocol. Draft operations never write the source world or move a Git branch. Node's built-in SQLite can emit an experimental warning on stderr; JSON stdout remains a single response object.

### Explicit operation admission, not narrative inference

`write-prose` admits portable relative Markdown paths confined to `prose/` (including nested paths), with case/file-directory/traversal collision checks. Replacing an existing Markdown document requires its exact captured `beforeSha256`; a new document requires `null`. The service supplies hashes, never the UI's possibly truncated text. These operations are saved proposals, not writes into the source or arbitrary vault import. Prose is not interpreted into claims.

Machine `put-proposal` actions can also carry `activate-assertion` and `deactivate-assertion`. Admission checks the closed schema, canonical assertion identity, world/profile identity, immutable-ID consistency, semantic/reference closure for additions, and active pinned-base identity for deactivation. This is real operation admission, not full combined-candidate historical conflict/impact validation. The generic human form authors explicit prose; the labelled `add-regency` template exists only in succession-demo mode and also produces explicit prose. Neither route auto-selects its new proposal.

Proposal revisions retain prior contents in saved workspace versions. Changing operations/dependencies/exclusions on a selected group returns it to undecided; editing rationale alone preserves structured effects. Rejection remains durable, not deletion, and restoration must explicitly return to undecided before selection. Prerequisites are displayed, never silently selected or restored.

### Exact pins and selected-draft diagnostics

Document pins bind an exact captured path/hash; assertion pins bind an active pinned-base assertion. Selected-draft diagnostics include missing/rejected prerequisites, explicit exclusions, conflicting prose replacements, changed pinned document bytes, pinned-assertion deactivation, and an admitted opposite-polarity assertion with the same proposition and scope. Byte-identical document writes do not count as pin changes. Diagnostics can remain in a saved unresolved selection; saving/selecting does not establish validity or override a pin.

These are exact supported protections, not arbitrary constraints over narrative meaning, a temporal contradiction solver, or a guarantee that prose preserves every asserted fact. Advisory direction such as “prefer diplomacy” is stored prose, not an executable rule. The demo's neutrality pin protects document bytes, not every possible claim about foreign policy.

### Bounded U3 candidate review

`workspace.review` compiles exactly the explicitly selected groups against the immutable captured base. It never auto-selects dependencies. The review binding covers the workspace/version, base snapshot, semantic profile, selected group/proposal versions, selected operations, and steering. The pure kernel builds a hypothetical candidate in memory and returns a candidate digest, combined document/assertion diff, diagnostics, limitations, and an evaluation digest. When compilation succeeds, the receipt also contains the candidate snapshot digest; it is null when selection or operation admission prevents compilation. The API does not expose or store a complete portable candidate bundle; deterministic replay uses the saved state and captured base.

The five mandatory checks are selection, operation admission/merge conflicts, candidate semantic/reference closure and source-byte integrity, exact pin preservation, and explicit opposition. Explicit opposition is intentionally narrow: exact same proposition, opposite polarity, comparable scope, and definitely intersecting recorded applicability. Unresolved scope/axis/applicability is surfaced as a warning, not an assumed pass. `valid` requires a compiled candidate and all five checks passed; any error yields `invalid`, while unresolved comparisons with no errors yield `undetermined`. Narrative text is never interpreted, and cardinality, causality, computed age/succession rules, and general historical impact are not implemented. `workspace.review` does not automatically invoke `claims.query`, `absence.query`, or `absence.proveThroughout` on the hypothetical candidate.

Review receipts are immutable, stored apart from semantic workspace versions, and do not grant authority. A fresh workspace has `validation.status: not-run`; a receipt bound to the exact current state is `current`; a previous receipt after edits is `stale`. Each receipt records `execution: completed` separately from `validity: valid | invalid | undetermined`. Review work defaults to 2,000,000 units and is capped at 50,000,000; receipts are capped at 75,000 value nodes or 1 MiB. Exceeding a work/receipt budget returns `BUDGET_EXCEEDED` with incomplete execution and no new receipt.

This is a bounded candidate review, not full U3 historical validation or a general truth judgment. Full candidate-bound historical query/proof/conflict/impact validation, host approval receipts (U4), and canonical commit/recovery (V4) remain unavailable. Approval is always `unavailable` and canon remains `unchanged`.

### Presentation and save recovery

The editor has five views, an 80x24 baseline, split panes at 100+ columns, and a compact too-small state that retains input. Non-TTY/`TERM=dumb` and `--plain` select a linear rendering without prompts; `--json` uses the existing envelope. Base record labels are derived from IDs when authored display names are absent; no names, timeline, or provenance are invented. Long Markdown previews are explicitly truncated while complete base bytes remain stored.

Imported text is sanitized only for presentation: active terminal controls/escape sequences and directional controls are removed, with Unicode/grapheme-aware editing and cell-width bounds. Stored source bytes are not rewritten. Keyboard, paste, resize, and `NO_COLOR` paths have tests; this is not screen-reader certification. Ctrl+E uses the trusted host's `VISUAL`/`EDITOR` executable and parsed arguments without a shell (falling back to `vi`); external edits only update the buffer and need a separate explicit save.

“Saved vN” follows an acknowledged transaction. Failed saves retain the form and outgoing action/key/version. Unknown outcomes can be explicitly retried identically; stale outcomes refresh without automatic merge and require an explicit new-version/new-key retry. A changed structured proposal blocks a stale rationale overwrite until the author explicitly loads/reviews the current structure. Esc never implicitly saves.

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

### Additional workspace bounds

| Boundary | Limit |
| --- | --- |
| Base read-model record summaries / documents | 256 each; no pagination |
| Proposal groups / pins | 256 each |
| Operations per group / group-ID lists | 256 each; a group must contain at least one operation |
| Decision-history entries | 2,000 |
| Prose operation text | 65,536 UTF-16 code units |
| Direction / goal / rationale / rejection reason | 16,000 UTF-16 code units each |
| Base Markdown preview | 16,000 UTF-16 code units before an explicit truncation notice; full bytes retained |
| Workspace response | 4 MiB canonical JSON, also subject to the 200,000-value-node plain-data preflight |
| Workspace review | 2,000,000 work units by default (50,000,000 maximum); receipt capped at 75,000 value nodes or 1 MiB |

These are intersecting bounds, not guaranteed usable capacities. Response shape/size, accumulated history, or the shared preflight may reject a workspace, review, or mutation **earlier** than an individual item/text limit. Admission checks the bounded read model before storing a new version; it does not silently truncate proposals, history, or selected effects. When limits are reached, use a new workspace rather than expecting history to be pruned; prior versions remain retained. There is no history pagination, database-size quota, or general large-world performance guarantee. The separate interval-receipt limits above are unchanged.

File allocation follows opened-inode size checks, not manifest declarations. Reads cannot grow past that observed size. Manifest cardinality is checked before the expensive schema pass. Unknown reserved `records/` families are rejected rather than silently omitted.

File opens use no-follow/nonblocking flags and metadata/inode consistency checks. **Node does not provide `openat`-style atomic parent confinement here.** Load bundles from a private, stable directory if another process could change parent directories. These checks do not establish safety against an adversary concurrently swapping directory ancestors.

Under-limit stdin still waits for EOF. Beyond the deterministic interval-proof and workspace-review budgets and workspace admission/read-model bounds above, general query resource characterization remains deferred. Operation deadlines, query pagination, cancellation, CPU/memory isolation, and large-world performance guarantees are not implemented. Size/count limits do not imply constant-time schema validation or a fixed peak heap size.

## Errors and export

Loader errors distinguish `INVALID_WORLD`, `FILESYSTEM_ERROR`, and `INTERNAL_ERROR`. The application maps filesystem failures to `STORAGE_FAILURE`, preserves explicit input rejection, and reports unexpected failures as incomplete internal errors. Symlinks intentionally rejected by the loader are invalid bundle input.

Every success operation has a matching payload schema. JSON-mode failures, including Unicode and serialization failures, stay in `wmm.response/1` and its documented exit-code classes. Workspace domain errors (`STALE_WORKSPACE`, `IDEMPOTENCY_CONFLICT`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_EXISTS`, `INVALID_WORKSPACE_ACTION`) use exit `3`; malformed wire requests use `2`, and storage/internal failures use `4`. An unconfigured workspace service is `UNSUPPORTED_FEATURE` (exit `2`). Resume/read/review/mutate do not initialize a missing authoring database; the CLI reports a storage failure rather than creating an empty one.

`world.export` is a deterministic record/document-metadata view. It does not contain document bytes or a restorable manifest and must not be advertised as a portable backup. Capturing base document bytes inside the authoring database does not change that export contract or supply a lossless portable workspace export. Coordinated backup and lossless exchange remain V6 work.

## Verification and remaining work

Local `pnpm run check` passed 1,010 tests across 47 files, seed vectors, and strict source/test typechecks under Node 26.12.1. `pnpm verify:workspace` passed four real-PTY scenarios on macOS. Coverage includes exact state/review recovery, candidate replay, source-loss independence, replay/stale-write behavior, source/storage separation, operation admission, terminal fallbacks, resize, and signal cleanup. The default Node 22.14.0 on this host is below the declared Node >=24.3.0 requirement. Linux PTY execution and screen-reader certification are not claimed; neither are hosted CI results.

Validation entrypoints (commands to run, not promises of success):

```sh
pnpm check
pnpm verify:contracts
pnpm verify:v0
pnpm verify:seed
pnpm verify:v1
pnpm verify:v2
pnpm verify:workspace
```

`pnpm verify:workspace` builds and then runs `python3 tools/workspace-terminal-smoke.py`, which uses only Python's standard library. The smoke supports macOS/Linux; only local macOS execution is reported. [WORKSPACE.md](WORKSPACE.md#validation) lists the focused Vitest command and the four PTY scenarios. Existing engine regression targets include independent fixtures, interval byte-amplification and receipt-node boundary cases, and deterministic fixture regeneration; the existing CI workflow targets Linux and macOS.

The existing [original RFC](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md) is now visible after removing the `plans/` ignore rule. [STATUS.md](STATUS.md) compares the implemented boundary with its milestone gates; it does not declare the contracts frozen. U1/U2 and a bounded U3 candidate-review subset are implemented, but full V3 is not complete. Remaining product work includes broader candidate-bound historical query/proof/conflict/impact validation (full U3), pinned domain revision resolution/storage and byte-preserving portable prose export, certified interval change providers beyond recorded applicability, durable host-only approval (U4), V4 expected-head acceptance/idempotency/journal recovery and its fault matrix, alternate-canon branches/forks/retcons/comparison/promotion, and coordinated backup/restore. A pinned workspace snapshot and captured prose bytes do not close those RFC gaps.
