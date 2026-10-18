# World Master's Manual

Implementation follows `WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md`.
The current code includes the executable V0 contracts and a production V1 read-only portable-world path. It is not yet an authoring or revision-storage engine.

## Current packages

- `packages/wire-contracts`: closed core, semantic, and production world-record shapes with Draft 2020-12 validators.
- `packages/canonical`: restricted safe-integer canonical JSON, domain-separated SHA-256, and domain identity helpers.
- `packages/temporal`: exact and uncertain local applicability over integer chronons, including correlated interval endpoints.
- `packages/schema`: the bounded first-release semantic-definition/profile vocabulary and structural checks.
- `packages/core`: scope comparison, evidence/family aggregation, trusted semantic-profile admission, bundled V1 semantics, and complete world-reference validation.
- `packages/exchange`: fixture-scoped compatibility loading plus production bundle verification, loading, inspection, and deterministic JSON export.
- `apps/cli`: development commands for contract verification and read-only world validation/inspection/export.
- `fixtures/v0`: golden scope, evidence, temporal, and result-algebra cases.
- `fixtures/v1/complete-world`: a fully referenced portable world with descriptors, source, assertions, supports, profile, definitions, manifest, and prose.
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
pnpm generate:v1-fixture
pnpm verify:v1
```

`pnpm check` runs the original Node verifier, TypeScript project-reference checks, and the Vitest suite. `pnpm verify:contracts` checks the identity kit through the compiled CLI. `pnpm verify:v0` executes the bounded semantic fixtures. `pnpm verify:seed` verifies the intentionally incomplete v0.3 seed payload. `pnpm generate:v1-fixture` deterministically regenerates the complete V1 world, and `pnpm verify:v1` validates it through the production loader.

The independent Python verifier additionally requires `jsonschema`. It is intentionally not a runtime dependency of WMM.

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
- production manifest closure, canonical JSON, size/path/symlink/case-collision controls, deterministic inspection/export, and integrity-preserving semantic corruption tests.

The read-only V1 path does not yet implement interval-wide population-coverage inference, the versioned stdin JSON request API, proposal workspaces, host authorization, Git-backed revisions, branches, or backups. Those retain their RFC milestone gates.
