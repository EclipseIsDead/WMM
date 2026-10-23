# Release notes

## 0.1.0-alpha.1 — first product prerelease (prepared, not published)

- Portable macOS/Linux archive with the compiled CLI, production dependencies, and the worked succession demo. Node.js >=24.3.0 remains a prerequisite; no package installation or checkout is needed to run the archive.
- `wmm --version` reports the product version; `wmm --help` lists commands.
- Demo creation, repeat launch, and resume work outside the repository. Saved proposals and decisions remain in a separate local workspace directory.
- `pnpm release:pack` builds the archive; `pnpm release:verify` checks an isolated extraction, JSON mutation persistence, plain output, and UI runtime imports. CI runs these checks on macOS and Linux; local results do not imply the remote matrix has passed.
- The product version is separate from RFC v0.3 and the `wmm/1` API. Internal workspace packages remain private implementation details.

This alpha supports durable drafts, not full historical validation, approval, or committing to canon. No registry publication, release upload, or Git tag is performed by the packaging tools. See the [release guide](RELEASING.md) for installation, verification, and platform limits.

## Pre-release implementation baseline — CLI and durable authoring workspace

This pre-release implementation snapshot preserves the former README's technical inventory. It is not a published release or a claim of completed RFC milestones. Commands below run from the repository root. For setup, start with the [quick start](../README.md).

A worldbuilding engine prototype with deterministic identities, verified directory bundles, scoped historical queries, roster-bound exact-point absence evaluation, and a certified exact-interval absence subset. A durable terminal workspace implements U1/U2 and a bounded U3 candidate-review subset over the same versioned `wmm/1` application API. `workspace.review` combines explicitly selected changes and returns a candidate-bound diff/receipt for bounded WMM checks; full candidate historical validation, host approval, and canonical commits remain unavailable. Draft decisions are saved; canonical worlds remain read-only, and the contracts remain pre-release drafts.

Implementation is guided by [RFC WMM-001 v0.3](../plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md). See the [workspace guide](WORKSPACE.md), [implementation status](STATUS.md), and [stabilization contracts and limitations](STABILIZATION.md) for the narrower implemented boundary. The original plans were hidden by a `plans/` ignore rule; that rule has been removed so the existing originals can be versioned.

## Current packages

- `packages/wire-contracts`: closed core, semantic, production world-record, and workspace shapes with Draft 2020-12 validators.
- `packages/canonical`: restricted safe-integer canonical JSON, domain-separated SHA-256, and domain identity helpers.
- `packages/temporal`: exact and uncertain local applicability over integer chronons, including correlated interval endpoints and certified exact applicability change positions.
- `packages/schema`: the bounded first-release semantic-definition/profile vocabulary and structural checks.
- `packages/core`: scope comparison, evidence/family aggregation, immutable semantic admission, world-reference validation, active-claim queries, roster-bound point/partitioned-interval absence, snapshot-backed receipt replay, and bounded workspace candidate compilation/review.
- `packages/exchange`: fixture-scoped compatibility loading plus production bundle verification, loading, inspection, and deterministic JSON export.
- `packages/ports`: the durable `WorkspaceStore` boundary, separate from canonical-world storage.
- `packages/store-authoring-sqlite`: transactional draft workspaces with immutable captured bases, retained state versions, optimistic concurrency, idempotent outcomes, and immutable version-bound review receipts.
- `packages/application`: versioned read-only world operations plus `workspace.create`, `workspace.read`, `workspace.review`, and `workspace.mutate`, with runtime admission and operation-discriminated responses shared by human and machine clients.
- `apps/cli`: development commands, duplicate-key-safe `wmm/1` JSON stdin processing, and a React/Ink workspace editor with plain/JSON output modes.
- `fixtures/v0`: golden scope, evidence, temporal, and result-algebra cases.
- `fixtures/v1/complete-world`: a fully referenced portable world with descriptors, source, assertions, supports, profile, definitions, manifest, and prose.
- `fixtures/v2`: independently constructed before/after/scope query expectations, point-absence receipts, and interval-proof requests/expectations.
- `fixtures/v3/succession-world`: a verified worked-demo bundle with explicit authored-prose alternatives, not a historical-validation substitute.
- `wmm-v0.3-contract-kit`: immutable seed vectors and independent Node/Python verifiers supplied with the RFC.

## Toolchain

- Node.js >=24.3.0
- pnpm 10.12.4
- TypeScript 7.0.2
- Vitest 5.0.5
- React 19.3.1, Ink 8.0.0, and string-width 8.3.0 (pinned workspace UI dependencies)

Exact package versions are recorded in `pnpm-lock.yaml`. Workspace storage uses Node's built-in SQLite, which can emit an experimental-feature warning on stderr; it does not belong to JSON stdout. The terminal smoke command also requires Python 3 (standard library only).

## Try the durable workspace

From the repository root, build and launch the worked succession demo:

```sh
pnpm build
node apps/cli/dist/main.js workspace demo --workspace-dir ./wmm-workspaces/succession
```

Or run `pnpm workspace:demo`, which builds and launches the same demo. Repeating the demo command resumes the saved workspace rather than reseeding its proposals or decisions.

For a normal verified bundle, start without demo proposals or pins, then resume the captured base:

```sh
node apps/cli/dist/main.js workspace open fixtures/v1/complete-world --workspace-dir ./wmm-workspaces/my-world
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/my-world
node apps/cli/dist/main.js workspace review --workspace-dir ./wmm-workspaces/my-world --plain
```

`--id` defaults to `main`. Workspace commands accept `--plain` or `--json` (mutually exclusive); non-TTY execution and `TERM=dumb` use linear plain output by default. `workspace review` is always non-interactive and explicitly runs the bounded review for the exact latest workspace version it read. The interactive editor has Changes, World, Constraints, History, and Review views, an 80x24 baseline, and split panes at 100+ columns—not a chat panel. In the Review tab, `c` calls the same version-bound review operation.

The separate workspace directory holds `authoring.sqlite` in WAL mode, the immutable verified base including captured document bytes, saved workspace state versions, and immutable review receipts. The source bundle is untouched. `resume` does not reload it and works even after it is moved or removed. The base identity is a **pinned snapshot digest**, not a stored domain revision or a Git revision, even where plain output labels it “Base revision”. Selection alone does not validate history or change canon. Explicit review can return `current` for its bounded checks; a later edit makes that receipt stale. U4 approval and V4 commit remain unavailable.

See [WORKSPACE.md](WORKSPACE.md) for the actual shortcuts, typed prose forms, machine API, limits, and recovery behavior.

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
pnpm verify:workspace
node apps/cli/dist/main.js json < fixtures/v1/validate-request.json
node apps/cli/dist/main.js json < fixtures/v2/absence-request.json
node apps/cli/dist/main.js json < fixtures/v2/interval-request.json
```

`pnpm check` runs the original Node verifier, strict source/test TypeScript checks, and the Vitest suite. `pnpm verify:contracts` checks the identity kit through the compiled CLI. `pnpm verify:v0` executes bounded semantic fixtures. `pnpm verify:seed` verifies the intentionally incomplete v0.3 seed payload. `pnpm generate:fixtures` regenerates the production world, V2 examples, and workspace demo; `pnpm verify:v1` and `pnpm verify:v2` exercise the compiled stdin API. The existing engine CI workflow targets Linux and macOS and checks regenerated fixture bytes; that is not a claim that the workspace PTY smoke has run on both platforms.

`pnpm verify:workspace` builds, then runs `tools/workspace-terminal-smoke.py`, a Python-standard-library smoke with four real-PTY scenarios. Local macOS execution is reported; Linux execution is not yet verified. Focused workspace validation commands and scoped results are in [WORKSPACE.md](WORKSPACE.md#validation). The commands here are validation targets, not promises of success or a current full-suite test total.

The independent Python verifier additionally requires `jsonschema`. It is intentionally not a runtime dependency of WMM.

### JSON API exit codes

- `0`: completed successful operation, including an evaluated but `not-established` interval proof
- `2`: invalid request, unsupported API version, or unsupported operation
- `3`: invalid world/unknown record, or a workspace domain error such as stale version, idempotency conflict, unknown/existing workspace, or invalid workspace action
- `4`: storage/internal failure or incomplete `BUDGET_EXCEEDED` interval proof or workspace review

JSON stdout contains exactly one canonical response object. Development/progress output and runtime warnings belong on stderr. Existing read-only JSON commands are unchanged. Workspace machine clients use `json --workspace-dir <directory>` with the same `wmm/1` envelope and `workspace.create` / `workspace.read` / `workspace.review` / `workspace.mutate`; the host controls the database directory, not a field in the request payload.

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
- operation-discriminated `wmm/1` request/response schemas for `world.validate`, `record.inspect`, `world.export`, `claims.query`, `absence.query`, `absence.proveThroughout`, and the four workspace operations;
- strict JSON/own-property/Unicode admission, bounded reads, request correlation, resolved snapshot identifiers, typed errors, canonical one-line output, and documented exit-code classes;
- roster-bound population coverage, preservation of positive witness support under contrary claims, certified exact-interval partitions, and separate integrity/replay verification of absence receipts;
- U1/U2 component, application, and SQLite paths for explicit proposal versions, selections, rejections, exact base-document/active-assertion pins, advisory direction, restart recovery, and historical workspace reads via `atVersion`;
- bounded U3 candidate review that combines only selected operations, computes a candidate snapshot digest and diff, and checks selection, operation conflicts, semantic/reference closure, exact pins, and explicit opposition; receipts are version-bound/replayable, without approval or commit authority;
- typed `write-prose` proposals and machine assertion-operation schema/identity/reference admission. Review does not interpret prose or implement general historical truth, causality, age/succession rules, or arbitrary narrative constraints.

### Exact interval absence subset

`absence.query` remains an independent exact-point (`at`) operation. `absence.proveThroughout` accepts a finite exact half-open interval `[start,endExclusive)` on one integer axis. It constructs a complete, numerically sorted partition from the query endpoints and certified relevant primitive changes, then reuses point evaluation only after constancy is certified over each nonempty cell. Point premises contribute both their position and successor, clipped to the query range; this does not turn stored events into durations. Exhaustive roster-bound absence must be established in every cell; an authorial declaration alone is not an exhaustive proof, and a definite witness in any cell blocks interval absence.

Potentially relevant uncertain changes, unresolved scope, or unmapped axes produce completed `not-established` results rather than guessed partitions. Missing/stale coverage or unresolved membership/eligibility also cannot establish absence. Deterministic work/cell budgets and bounded output construction produce incomplete `BUDGET_EXCEEDED` errors on exhaustion, with no result/receipt. Interval receipt integrity checking is not proof: snapshot replay independently reconstructs the partition and cell evaluations against adapter-verified content. See [the detailed contract](STABILIZATION.md#exact-interval-absence-subset).

This is the recorded-applicability subset of RFC §5.6, not a general temporal solver, computed age/eligibility thresholds, or arbitrary rule execution. The bounded U3 review is implemented, but it does not run the general historical claim/absence proof and conflict/impact analyses over the candidate; full U3, host authorization (U4), domain revision storage and safe canonical acceptance/recovery (V4), branches, and backups remain open. Durable workspaces and candidate reviews do not complete the full V3 milestone. `world.export` is a metadata view, not a lossless backup. Load bundles from stable/private directories; no-follow file checks do not provide atomic confinement against concurrent parent-directory swaps. Queries remain synchronous and have no deadline/cancellation/pagination contract. These limitations remain explicit gates rather than implied completed capabilities.
