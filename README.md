# World Master's Manual

Implementation follows `WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md`.
The current code is an executable V0 contract baseline, not yet a complete world engine.

## Current packages

- `packages/wire-contracts`: closed core and semantic wire shapes with Draft 2020-12 validators.
- `packages/canonical`: restricted safe-integer canonical JSON, domain-separated SHA-256, and domain identity helpers.
- `packages/temporal`: exact and uncertain local applicability over integer chronons, including correlated interval endpoints.
- `packages/schema`: the bounded first-release semantic-definition/profile vocabulary and structural checks.
- `packages/core`: scope comparison, evidence/family aggregation, and trusted semantic-profile admission.
- `apps/cli`: development commands that verify the supplied identity kit and all executable V0 fixtures.
- `fixtures/v0`: golden scope, evidence, temporal, and result-algebra cases.
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
```

`pnpm check` runs the original Node verifier, TypeScript project-reference checks, and the Vitest suite. `pnpm verify:contracts` checks the identity kit through the compiled CLI. `pnpm verify:v0` additionally executes the scope, evidence, temporal, result-algebra, and trusted-definition fixtures.

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
- trusted allowlist admission for the bounded semantic operation vocabulary, including default rejection of fixture-only definitions.

They do not yet implement portable world loading, descriptor/source records, interval-wide coverage inference, authoring authorization, Git transactions, or backups. Those retain their RFC milestone gates.
