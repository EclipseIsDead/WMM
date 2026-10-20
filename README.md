# World Master's Manual

A read-only worldbuilding engine prototype with deterministic identities, verified directory bundles, scoped historical queries, and roster-bound exact-point absence evaluation over the versioned `wmm/1` JSON stdin API. It is not yet an authoring or revision-storage engine, and the contracts remain pre-release drafts.

Implementation is guided by [RFC WMM-001 v0.3](plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md). See [implementation status](docs/STATUS.md) and [stabilization contracts and limitations](docs/STABILIZATION.md) for the narrower implemented boundary. The original plans were hidden by a `plans/` ignore rule; that rule has been removed so the existing originals can be versioned.

## Current packages

- `packages/wire-contracts`: closed core, semantic, and production world-record shapes with Draft 2020-12 validators.
- `packages/canonical`: restricted safe-integer canonical JSON, domain-separated SHA-256, and domain identity helpers.
- `packages/temporal`: exact and uncertain local applicability over integer chronons, including correlated interval endpoints.
- `packages/schema`: the bounded first-release semantic-definition/profile vocabulary and structural checks.
- `packages/core`: scope comparison, evidence/family aggregation, immutable semantic admission, world-reference validation, active-claim queries, roster-bound absence, and snapshot-backed receipt replay.
- `packages/exchange`: fixture-scoped compatibility loading plus production bundle verification, loading, inspection, and deterministic JSON export.
- `packages/application`: versioned read-only validation, inspection, export, claim-query, and absence-query operations with runtime request admission and operation-discriminated responses.
- `apps/cli`: development commands plus duplicate-key-safe `wmm/1` JSON request processing over stdin.
- `fixtures/v0`: golden scope, evidence, temporal, and result-algebra cases.
- `fixtures/v1/complete-world`: a fully referenced portable world with descriptors, source, assertions, supports, profile, definitions, manifest, and prose.
- `fixtures/v2`: independently constructed before/after/scope query expectations and absence receipt fixtures.
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
```

`pnpm check` runs the original Node verifier, strict source/test TypeScript checks, and the Vitest suite. `pnpm verify:contracts` checks the identity kit through the compiled CLI. `pnpm verify:v0` executes bounded semantic fixtures. `pnpm verify:seed` verifies the intentionally incomplete v0.3 seed payload. `pnpm generate:fixtures` regenerates the production world and V2 examples; `pnpm verify:v1` and `pnpm verify:v2` exercise the compiled stdin API. CI runs these checks on Linux and macOS and checks regenerated fixture bytes.

The independent Python verifier additionally requires `jsonschema`. It is intentionally not a runtime dependency of WMM.

### JSON API exit codes

- `0`: completed successful operation
- `2`: invalid request, unsupported API version, or unsupported operation
- `3`: invalid world or unknown record
- `4`: storage or internal failure

JSON stdout contains exactly one canonical response object. Development and future progress output belong on stderr.

## Verified boundary

The current checks cover:

- all 31 seed canonical-byte and identity vectors;
- 15 positive and 7 negative core schema cases;
- 8 expected identity differences;
- all 12 files referenced by the seed snapshot manifest;
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
- operation-discriminated `wmm/1` request/response schemas for `world.validate`, `record.inspect`, `world.export`, `claims.query`, and `absence.query`;
- strict JSON/own-property/Unicode admission, bounded reads, request correlation, resolved snapshot identifiers, typed errors, canonical one-line output, and documented exit-code classes;
- roster-bound population coverage, preservation of positive witness support under contrary claims, and separate integrity/replay verification of absence receipts.

The read-only path does not yet implement interval-wide population-coverage proofs, general historical conflict/impact analysis, proposal workspaces, host authorization, Git-backed world revisions, branches, or backups. `world.export` is a metadata view, not a lossless backup. Load bundles from stable/private directories; no-follow file checks do not provide atomic confinement against concurrent parent-directory swaps. Queries remain synchronous and have no deadline/cancellation/pagination contract. These limitations remain explicit gates rather than implied completed capabilities.
