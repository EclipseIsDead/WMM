# World Master's Manual

A read-only worldbuilding engine prototype with deterministic identities, verified directory bundles, scoped historical queries, roster-bound exact-point absence evaluation, and a certified exact-interval absence subset over the versioned `wmm/1` JSON stdin API. It is not yet an authoring or revision-storage engine, and the contracts remain pre-release drafts.

Implementation is guided by [RFC WMM-001 v0.3](plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md). See [implementation status](docs/STATUS.md) and [stabilization contracts and limitations](docs/STABILIZATION.md) for the narrower implemented boundary. The original plans were hidden by a `plans/` ignore rule; that rule has been removed so the existing originals can be versioned.

## Current packages

- `packages/wire-contracts`: closed core, semantic, and production world-record shapes with Draft 2020-12 validators.
- `packages/canonical`: restricted safe-integer canonical JSON, domain-separated SHA-256, and domain identity helpers.
- `packages/temporal`: exact and uncertain local applicability over integer chronons, including correlated interval endpoints and certified exact applicability change positions.
- `packages/schema`: the bounded first-release semantic-definition/profile vocabulary and structural checks.
- `packages/core`: scope comparison, evidence/family aggregation, immutable semantic admission, world-reference validation, active-claim queries, roster-bound point/partitioned-interval absence, and snapshot-backed receipt replay.
- `packages/exchange`: fixture-scoped compatibility loading plus production bundle verification, loading, inspection, and deterministic JSON export.
- `packages/application`: versioned read-only validation, inspection, export, claim-query, point-absence, and interval-proof operations with runtime request admission and operation-discriminated responses.
- `apps/cli`: development commands plus duplicate-key-safe `wmm/1` JSON request processing over stdin.
- `fixtures/v0`: golden scope, evidence, temporal, and result-algebra cases.
- `fixtures/v1/complete-world`: a fully referenced portable world with descriptors, source, assertions, supports, profile, definitions, manifest, and prose.
- `fixtures/v2`: independently constructed before/after/scope query expectations, point-absence receipts, and interval-proof requests/expectations.
- `wmm-v0.3-contract-kit`: immutable seed vectors and independent Node/Python verifiers supplied with the RFC.

## Toolchain

- Node.js 24.3.0 or newer in the Node 24 line
- pnpm 10.12.4
- TypeScript 7.0.2
- Vitest 5.0.5

Exact package versions are recorded in `pnpm-lock.yaml`.

## Commands

```sh
pnpm install
pnpm check
pnpm verify:contracts
pnpm verify:v0
pnpm verify:seed
pnpm generate:fixtures
pnpm verify:v1
pnpm verify:v2
node apps/cli/dist/main.js json < fixtures/v1/validate-request.json
node apps/cli/dist/main.js json < fixtures/v2/absence-request.json
node apps/cli/dist/main.js json < fixtures/v2/interval-request.json
```

`pnpm check` runs the original Node verifier, strict source/test TypeScript checks, and the Vitest suite. `pnpm verify:contracts` checks the identity kit through the compiled CLI. `pnpm verify:v0` executes bounded semantic fixtures. `pnpm verify:seed` verifies the intentionally incomplete v0.3 seed payload. `pnpm generate:fixtures` regenerates the production world and V2 examples; `pnpm verify:v1` and `pnpm verify:v2` exercise the compiled stdin API; V2 includes claim, point-absence, and interval-proof requests. CI is configured to run these checks on Linux and macOS and check regenerated fixture bytes. These commands describe validation targets, not a report that this increment has passed them.

The independent Python verifier additionally requires `jsonschema`. It is intentionally not a runtime dependency of WMM.

### JSON API exit codes

- `0`: completed successful operation, including an evaluated but `not-established` interval proof
- `2`: invalid request, unsupported API version, or unsupported operation
- `3`: invalid world or unknown record
- `4`: storage/internal failure or incomplete `BUDGET_EXCEEDED` interval proof

JSON stdout contains exactly one canonical response object. Development and future progress output belong on stderr.

## Implemented boundary

The implementation and checked-in validation targets cover:

- seed canonical-byte and identity vectors;
- positive and negative core schema cases;
- expected identity differences;
- seed snapshot manifest closure;
- restricted canonicalization behavior for Unicode, UTF-16 key ordering, safe integers, sparse arrays, and cycles;
- tri-state scope comparison, documentary evidence status, and explicit-polarity family support;
- the closed response/validation result algebra;
- exact, bounded-unknown, unknown, and unbounded temporal applicability against exact point/interval queries;
- trusted allowlist admission for the bounded semantic operation vocabulary, including default rejection of fixture-only definitions;
- fixture-scoped compatibility verification for the intentionally incomplete v0.3 identity kit;
- production descriptor/source/assertion/support/world/snapshot records;
- release-owned bundled semantic trust rather than trust derived from imported bytes;
- complete catalog, identity, definition-role, temporal-input, source, and historical-reference validation;
- production manifest closure, canonical JSON, size/path/symlink/case-collision controls, deterministic inspection/export, and integrity-preserving semantic corruption tests;
- operation-discriminated `wmm/1` request/response schemas for `world.validate`, `record.inspect`, `world.export`, `claims.query`, `absence.query`, and `absence.proveThroughout`;
- strict JSON/own-property/Unicode admission, bounded reads, request correlation, resolved snapshot identifiers, typed errors, canonical one-line output, and documented exit-code classes;
- roster-bound population coverage, preservation of positive witness support under contrary claims, certified exact-interval partitions, and separate integrity/replay verification of absence receipts.

### Exact interval absence subset

`absence.query` remains an independent exact-point (`at`) operation. `absence.proveThroughout` accepts a finite exact half-open interval `[start,endExclusive)` on one integer axis. It constructs a complete, numerically sorted partition from the query endpoints and certified relevant primitive changes, then reuses point evaluation only after constancy is certified over each nonempty cell. Point premises contribute both their position and successor, clipped to the query range; this does not turn stored events into durations. Exhaustive roster-bound absence must be established in every cell; an authorial declaration alone is not an exhaustive proof, and a definite witness in any cell blocks interval absence.

Potentially relevant uncertain changes, unresolved scope, or unmapped axes produce completed `not-established` results rather than guessed partitions. Missing/stale coverage or unresolved membership/eligibility also cannot establish absence. Deterministic work/cell budgets and bounded output construction produce incomplete `BUDGET_EXCEEDED` errors on exhaustion, with no result/receipt. Interval receipt integrity checking is not proof: snapshot replay independently reconstructs the partition and cell evaluations against adapter-verified content. See [the detailed contract](docs/STABILIZATION.md#exact-interval-absence-subset).

This is the recorded-applicability subset of RFC §5.6, not a general temporal solver, computed age/eligibility thresholds, or arbitrary rule execution. The read-only path still lacks general historical conflict/impact analysis, proposal workspaces, host authorization, Git-backed world revisions, branches, and backups. `world.export` is a metadata view, not a lossless backup. Load bundles from stable/private directories; no-follow file checks do not provide atomic confinement against concurrent parent-directory swaps. Queries remain synchronous and have no deadline/cancellation/pagination contract. These limitations remain explicit gates rather than implied completed capabilities.
