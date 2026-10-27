# Fixture verification in CI

Run the fixture gate locally with Node >=24.3.0 and pnpm 10.12.4:

```sh
pnpm verify:fixtures
```

This builds the actual CLI and runs `tools/verify-fixtures.mjs`. For a coverage inventory without executing checks:

```sh
node tools/verify-fixtures.mjs --list --json
```

Use `--fixtures-dir <directory>` for an isolated fixture collection. The normal repository root and compiled CLI remain the execution context, so fixture requests retain their authored repository-relative bundle paths.

## What is covered

| Fixture family | Executed checks |
| --- | --- |
| Contract kit | Full contract-kit verification and bundled seed validation, not only the byte-vector script |
| V0 semantic cases | Every declared scope, evidence, family, temporal, invalid temporal, and positive/negative schema case through the existing V0 verifier |
| Snapshot bundles | Ordinary `world.validate` for every discovered bundle; its loader checks the complete manifest and payload bytes, rather than treating each payload record as an independent request |
| V1 API collections | Every positive request and every `invalidRequests` entry; invalid input must actually produce `INVALID_REQUEST` with exit code 2 |
| Standalone requests | Every `wmm.request/1` fixture, including the V3 workspace-create request using isolated temporary storage |
| V2 claims | Every case and the complete declared definite/possible/unresolved/excluded golden lists |
| V2 point absence | Every declared expectation, including evidence classifications and pinned selection/evaluation digests where supplied |
| V2 interval absence | Every declared expectation, including breakpoints, cell evaluations, and the expected incomplete budget failure; that exit-code-4 case is a passing regression check, not a failed fixture |
| Authoring projects, when present | Every discovered authoring project through real check/build/world validation/note rendering and deterministic-output comparison |
| Reference atlases, when present | Each authored atlas through a captured-workspace map read; this CI change does not bundle or require the separate atlas feature PR |
| Actor briefs, when present | Real `actor prepare` against a discovered or generated verified snapshot matching the declared snapshot digest |
| Actor decision drafts, when present | Real `actor review` against the rebuilt context matching the declared context digest; invalid or unbound inputs fail instead of being skipped |

The report enumerates discovered JSON files and their coverage. Unknown formats, malformed or empty collections, unsupported expectation keys, and an empty fixture root are errors rather than silent skips. Individual failures are collected so later independent fixture checks still run; the command exits nonzero if any check fails.

Actor checks run after snapshot validation and authoring checks, with all briefs prepared before decisions are reviewed. Binding uses snapshot/context digests, never fixture filenames or campaign identities. Inventory mode only lists these planned checks and invokes no CLI subprocesses. The current combined inventory covers 104 JSON files with 50 executable checks.

The harness uses bounded subprocesses with no shell interpolation. Generated bundles, notes and authoring storage live in fresh, canonical temporary directories; source fixtures are not rewritten by the verifier.

## GitHub Actions

The `Conformance` workflow has independent `check` and `fixtures` jobs on both Linux and macOS. Fixture jobs do not depend on unit-test success. After the CLI builds, all of these fixture stages are attempted even if an earlier stage fails:

1. `pnpm verify:fixtures` — discovery, positive/negative requests, bundle admission and golden results.
2. `pnpm verify:workspace` — actual PTY navigation, persistence, signal cleanup and terminal fallbacks, plus any supported atlas smoke scenarios.
3. `pnpm generate:fixtures` — regeneration must leave tracked fixture bytes unchanged and create no unexpected untracked fixture files.

The normal conformance job retains strict source/test typechecks, the full unit/integration suite, and portable release packing/isolated verification. Runtime versions, frozen dependency installation and read-only workflow permissions are unchanged.

Both jobs establish a realpath-resolved temporary directory under the runner's temporary root. This avoids macOS `/var` aliases triggering intentional no-symlink output guards; validators are not weakened. Vitest workers are bounded to two in CI to reduce contention between real CLI subprocess tests; test assertions and timeouts are not relaxed.

## Adding fixtures

Add an input using a supported fixture format or an ordinary snapshot bundle; the verifier discovers it without adding another hard-coded CI command. Give golden cases explicit expected values. A new fixture format or expectation field must have a corresponding verified handler instead of being ignored. Keep reusable examples synthetic and do not add private setting data or credentials.
