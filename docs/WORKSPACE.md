# Durable authoring workspace (U1/U2 and bounded U3 review)

The workspace is an inspect-and-steer workbench, not a chat transcript. U1 (inspection), U2 (durable decisions), and a bounded U3 candidate-review subset are implemented through terminal components, the shared application service, and SQLite storage. **Full V3 is not complete:** broader candidate-bound historical validation remains incomplete; host approval (U4) and canonical commit/recovery (V4) are unavailable.

A new workspace without a review reports validation `not-run`. An explicit `workspace.review` can return a current bounded result; later workspace edits retain the previous receipt as `stale`. Every view reports approval `unavailable` and canon `unchanged`. Saving or selecting a proposal does not itself run review, establish historical validity, authorize it, or change canon. See [STATUS.md](STATUS.md) for the other RFC milestone gaps and [STABILIZATION.md](STABILIZATION.md#u1u2-and-bounded-u3-workspace-contract) for the contracts.

## Launch and resume

Run from the repository root with Node.js >=24.3.0 and pnpm 10.12.4:

```sh
pnpm build
node apps/cli/dist/main.js workspace demo --workspace-dir ./wmm-workspaces/succession
```

Alternatively, `pnpm workspace:demo` builds and launches the same demo. The CLI pins React 19.3.1, Ink 8.0.0, and string-width 8.3.0. Storage uses Node's built-in SQLite, which can print an experimental-feature warning on **stderr**, including during JSON use. JSON stdout is not a log stream.

The first demo launch captures `fixtures/v3/succession-world` and creates explicit worked alternatives. Repeating the command resumes the saved workspace without reseeding its decisions. Use a different directory or `--id` for a new workspace; do not delete a database to perform an ordinary resume.

Open a normal verified WMM bundle without demo proposals, pins, or direction:

```sh
node apps/cli/dist/main.js workspace open fixtures/v1/complete-world --workspace-dir ./wmm-workspaces/my-world
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/my-world
```

`open` starts an ordinary `world` workspace with empty proposals. It does not inject the succession template, even if the bundle happens to be the demo bundle. Repeating the same open intent shows the latest saved state, not its initial version; a different create intent for an existing ID is not a rebase. Prefer `resume` once a workspace exists. Resume reads the captured base and works after the source directory is moved, changed, or removed.

### Options and non-interactive output

All human workspace commands (`open`, `demo`, `resume`, `review`, and `map`) require `--workspace-dir <directory>` and accept:

| Option | Behavior |
| --- | --- |
| `--id <id>` | Workspace ID within that authoring database; defaults to `main` |
| `--plain` | Linear human-readable inspection; no prompts or terminal-mode changes |
| `--json` | One canonical `wmm.response/1` object using the existing transport; no Ink output |

`--plain` and `--json` are mutually exclusive. Without either flag, both stdin and stdout must be TTYs and `TERM` must not be `dumb` to launch the editor; otherwise the command prints plain output without reading stdin or prompting. `NO_COLOR` is supported. `workspace review` is always non-interactive and runs checks for the latest version it read, using that version as an optimistic precondition. Opening/first-time demo creation can still create a workspace in plain/JSON mode; use `resume` to inspect an existing one.

`workspace map` is also always non-interactive, but only reads the captured reference atlas. It accepts `--atlas <id>` and `--geometry-version <id>` selectors; it never runs review or applies selected proposals. Use **m** in the interactive World view for Map, or `workspace map --plain` / `--json` for linear/structured output. See [ATLAS.md](ATLAS.md) for the runnable example, map controls, and `workspace.map.read` contract. The ordinary workspace read shape and its five tabs are unchanged.

```sh
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/succession --plain
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/succession --json
node apps/cli/dist/main.js workspace review --workspace-dir ./wmm-workspaces/succession --plain
node apps/cli/dist/main.js workspace review --workspace-dir ./wmm-workspaces/succession --json
```

Resume requires an existing database and workspace; it does not initialize missing storage. Keep source and authoring directories separate, with neither containing the other. The CLI also rejects authoring storage inside a world bundle.

## What is pinned and saved

The host-selected directory contains `authoring.sqlite` in WAL mode (with SQLite sidecars as needed). It retains:

- the immutable adapter-verified snapshot and world data;
- captured document bytes, not just their paths or displayed excerpts;
- every saved workspace state version, including proposal contents/versions, decisions and rejection reasons, pins, advisory direction, and decision history;
- immutable candidate-review receipts, stored separately and bound to the workspace version they reviewed;
- durable idempotency outcomes for successful create/mutate operations.

The source bundle is untouched. Proposals live in the authoring database; selecting `write-prose` does not write a Markdown file into the source. Read-model excerpts can be truncated without discarding the stored base bytes. Non-Markdown assets are retained but not decoded as prose.

The base identity is `{worldId, snapshotDigest}`: a **pinned snapshot**, not a domain revision ID, Git commit, or current branch head. Workspace versions (`v1`, `v2`, …) identify draft state, not accepted world revisions. The base cannot be changed in place.

SQLite mutations are transactional, use expected workspace versions, and retain immutable state rows and outcomes. This is durable draft storage, not V4 canonical acceptance or a general backup/restore protocol. Use a private, stable authoring directory; filesystem/symlink guards do not make hostile concurrent directory changes safe. Do not treat a copy of a live WAL database's main file alone as a coordinated backup.

### First creation and interrupted startup

For a new database, the store exclusively allocates a private `.wmm-authoring-init-*` directory beside the configured target, commits the existing SQLite schema/identity into its private file, and closes SQLite before publishing. Publication uses a same-filesystem hard link that cannot overwrite an existing target. A concurrent creator's winning database is validated and reopened normally; empty, foreign, corrupt, symlink and nonregular targets remain rejected without replacement. An absent main file does not establish ownership of existing WAL/SHM/journal sidecars, so these are rejected rather than adopted.

If the first process is interrupted before publication, retry the original `open`/`demo` creation command: a new valid database can be initialized. If interrupted after publication, the main file is already compatible and ordinary retry/reopen works. `resume` still requires an existing database and saved workspace; initialization alone does not create a saved world.

Handled failures remove only that invocation's private staging allocation. SIGKILL can leave abandoned hidden staging directories, including a hard-link alias to the published main file; they are ignored, not automatically scanned or removed. Historical zero-byte files with no WMM ownership proof remain rejected. Unsupported hard-link publication fails closed. These process-interruption checks do not establish power-loss durability, backup/restore, or safety against hostile concurrent namespace changes.

There is no workspace-list/fork command, linked rebase, or separate proposal-history endpoint. `workspace.read` with `atVersion` reads a complete historical workspace state; prior proposal contents remain in those states. A new independent workspace is not alternate canon or a linked fork.

## Five views, no chat panel

The fully usable baseline is **80 columns by 24 rows**. At 100+ columns, list-based views show list/inspector split panes; at 80 columns, navigate from the list into a full inspector. Smaller terminals show a bounded resize notice and retain input. Long details, history, and diagnostics have scrolling and a visible More indicator.

Map uses a colour terminal-cell shader with true-colour/256/16-colour fallbacks and cached geometry for selection/cursor redraws. `NO_COLOR`, dumb/non-TTY terminals, and plain/JSON output retain the monochrome representation. Colour never supplies political ownership or changes hit targets. See [atlas rendering and benchmarks](ATLAS.md#colour-terminal-shader-and-redraw-scaling).

| View | Implemented content |
| --- | --- |
| Changes | Explicit proposal groups, decisions, authorship/rationale, service-supplied before/proposed effects, prerequisites, and selection diagnostics |
| World | Read-only pinned-base documents and summaries of descriptors, assertions, and sources; document hashes and full IDs in inspection; `m` opens a captured-base reference atlas subview |
| Constraints | Exact document/active-assertion pins, separately labelled advisory direction |
| History | Saved workspace decisions, reasons, proposal revisions, direction and pin changes |
| Review | Selected effects, explicit combined-candidate diffs, bounded checks and diagnostics; receipt status is not-run/current/stale; approval unavailable and canon unchanged |

These views use admitted data, not invented fixture strings as world truth. When the canonical source lacks authored display names, descriptor labels are derived from IDs and identified as such. Assertion summaries use admitted propositions, time/scope, and source references; absence of documentary support is not a truth judgment. The workspace does not invent a timeline, inferred heirs, or provenance.

### Keyboard controls

These are the current controller bindings, not proposed future shortcuts. Shortcut letters are inactive while typing in a form; pasted text is not interpreted as a series of global actions.

| Key | Action outside text forms |
| --- | --- |
| `1`–`5`, `Tab` / `Shift+Tab` | Changes, World, Constraints, History, Review |
| Up/Down, `j` / `k` | Move list focus, or scroll the focused inspector/history/review |
| Enter / Esc | Open/toggle readable inspection; return or cancel without implicit save |
| Right / Left | Focus inspector / return to list; at narrower widths, Right opens full inspection |
| Page Up / Page Down | Page through the focused list, inspector, history, diagnostics, or dialog |
| Space | Select/unselect the focused change in Changes; review missing prerequisites explicitly |
| `r` | In Changes, reject with an optional reason or confirm restoration to undecided |
| `a` | Add a generic explicit prose proposal; demo mode also offers the labelled regency template |
| `e` | In Changes, edit rationale only; preserve structured operations and dependencies |
| `n` | Edit advisory direction, not an executable constraint |
| `p` | Confirm pin/unpin for a World document/active assertion or a Constraints pin |
| `d` | Toggle the secondary raw inspector/full identifiers |
| `m`, in World | Open/close the read-only reference atlas; selected proposals are excluded and candidate projection is unavailable |
| `v` / `?` | Review / keyboard help |
| `c` | In Review, build and check the combined selection at the displayed workspace version |
| `q` / Ctrl+C | Quit (`q` is ordinary text inside a form); no implicit form save |

In forms:

- `Tab` / `Shift+Tab` changes fields. Arrows, Home/End, Backspace/Delete, and Page Up/Down support grapheme-aware cursor editing; Ctrl+A goes to the start of the buffer.
- Enter inserts a newline in multiline fields and advances single-line fields. **Ctrl+S saves**; Ctrl+Enter also saves where the terminal can distinguish it. Esc cancels without saving.
- **Ctrl+E opens the external editor for the focused field.** The CLI uses `VISUAL`, then `EDITOR`, then `vi`; it parses executable/arguments with quote/escape support and launches without a shell. Shell expansion, pipes, and redirection are not interpreted. Configure a trusted executable/argument string, not a shell script fragment.
- Ink suspends terminal ownership for external editing and resumes it afterward. Successful external edits update the buffer only: save separately with Ctrl+S/Ctrl+Enter. Failed editor execution retains the original input.

Imported prose/titles/source excerpts pass through a terminal-safe presentation layer: active escape/control sequences and directional controls are not executed or rendered as active controls. Unicode text is width-bounded and grapheme-aware. Sanitization is presentation-only; captured source bytes remain unchanged. These behaviors and plain output do not constitute screen-reader certification.

### Worked succession review

1. Inspect and explicitly select the death group, then the interim council.
2. Focus the coup, press `r`, enter an optional rejection reason, and save. Rejection is a retained decision, not deletion.
3. Press `a`, choose the explicitly labelled demo regency template, fill title/rationale, and save. The service authors an explicit prose proposal; it is **not generated or inferred** and starts undecided. Select it separately.
4. Keep the neighboring kingdom's neutrality document pin active. `p` shows the precise document/hash or assertion protection before confirming any pin change.
5. Use `n` to edit advisory direction, then `v` to open Review and `c` to build/check the combined selection. Inspect its exact diff, checks, diagnostics, and limitations. “Prefer diplomacy” is not an executable rule; a valid bounded result does **not** mean all history is true.
6. Quit and repeat the demo command or use `workspace resume`; saved decisions, reasons, proposal contents, and direction remain available.

Selecting a group with missing prerequisites offers cancel, select that group alone with unresolved diagnostics, or explicitly include the displayed prerequisites. Rejected prerequisites are never silently revived; restore them to undecided first. Deselecting/rejecting a prerequisite leaves dependent selections visible with diagnostics rather than silently removing them.

## Explicit proposals and protection boundaries

### Prose and assertion operations

The generic human alternative form saves a typed `put-proposal` containing `write-prose`. It collects an exact relative path, title, rationale, and proposed body. It does not infer claims from natural language or select the new group.

- Writable draft paths are confined to portable `prose/*.md` paths, including nested subdirectories. Record/asset paths, traversal, case collisions, and file/directory collisions are rejected.
- Replacing an existing Markdown document requires its exact captured-base `beforeSha256`; a new path requires `null`. The UI uses the service-supplied hash, not a hash of a displayed/truncated excerpt.
- This opens existing verified WMM bundles, including snapshots built by the [structured authoring pipeline](AUTHORING.md), not arbitrary Markdown/Obsidian vaults. Automatic vault import and workspace-to-authoring-project round trips are not implemented here.
- Machine proposals can additionally use `activate-assertion` and `deactivate-assertion`. Closed-schema, canonical identity, world/profile, immutable-ID, semantic/reference admission, and active-base deactivation checks exist. There is no generic human claim-generation form; admission alone is not full combined-candidate historical validation.

A rationale edit preserves operations, title, authorship, dependencies, and exclusions. A machine proposal revision that changes executable operations/dependencies/exclusions on a selected group returns it to undecided. Earlier contents remain in saved workspace versions.

### Pins are exact, not narrative constraints

A document pin binds a captured path/hash; an assertion pin binds an active pinned-base assertion. The application diagnoses selected changes to protected document bytes, pinned-assertion deactivation, and admitted opposite-polarity assertions with the same proposition and scope. Byte-identical document writes are not changes. It also diagnoses missing/rejected prerequisites, explicit exclusions, and differing selected prose replacements at the same path.

These are **selected-draft diagnostics**, not arbitrary constraints over prose meaning or a completed historical conflict analysis. An unresolved selection can be saved; that does not remove a pin or authorize the candidate. The demo's neutrality protection is an exact document pin, not a general rule that understands every possible foreign-policy narrative. Pin changes need explicit confirmation; advisory direction remains separate.

### Bounded combined-candidate review

`workspace.review` requires `workspaceId` and `expectedVersion` (plus optional `limits.maxWorkUnits`). It combines only explicitly selected groups; it never closes over or auto-selects dependencies. `workspace review` and Review-tab `c` use this same service operation. A completed review is bound to the exact workspace version, base snapshot, semantic profile, selected group/proposal versions, operations, and steering. The review does not advance the semantic workspace version.

The pure core builds a hypothetical candidate in memory and computes `candidateDigest`, `candidateSnapshotDigest`, an `evaluationDigest`, and a combined document/assertion diff with group provenance. The API and stored receipt expose those digests and the diff, not a complete exportable candidate bundle. The deterministic candidate and receipt can be reconstructed/replayed from the immutable base and exact saved workspace state.

The five mandatory checks are:

1. **Selection:** at least one group, valid dependencies/exclusions, no missing prerequisites or dependency cycles; dependencies remain an explicit author choice.
2. **Operations:** only supported explicit prose/assertion operations, exact base document hashes, and no conflicting selected writes or assertion effects.
3. **References:** candidate semantic/reference closure and integrity of captured source bytes.
4. **Pins:** exact document-byte and active-assertion protections remain satisfied; an exact opposite assertion against a pinned assertion blocks the check.
5. **Explicit opposition:** exact same proposition, opposite polarity, comparable scope, and definitely intersecting recorded applicability. Unresolved scope, axes, or applicability is reported as a warning, not silently treated as agreement.

`validity` is `valid` only when a candidate was compiled and all five checks pass; any reported error makes it `invalid`, while unresolved comparisons with no errors make it `undetermined`. A completed result is bounded evidence about these checks—not a general historical truth judgment. Narrative prose, goals, and direction are not interpreted; cardinality, causality, age, succession rules, and general historical impact analysis are not implemented. This operation does not automatically run `claims.query`, `absence.query`, or `absence.proveThroughout` against the candidate. Work-budget exhaustion returns `BUDGET_EXCEEDED` with incomplete execution and no new receipt.

New workspaces report validation `not-run`; a successfully stored receipt bound to the current workspace reports `current`, and edits leave older receipts visible as `stale`. Receipts are append-only, stored outside semantic workspace versions, and do not authorize writes. Approval remains unavailable, canon remains unchanged, and no approval or commit operation exists. Full U3 still needs broader candidate-bound historical proof/conflict/impact validation.

## Machine API

Existing read-only `json` invocations are unchanged. Workspace requests use the same `wmm/1` envelope and transport, with a **host-controlled database directory**:

```sh
node apps/cli/dist/main.js json --workspace-dir ./wmm-workspaces/machine-demo < fixtures/v3/create-demo-request.json
```

That fixture contains a `workspace.create` request in explicit `succession-demo` mode. The database directory is CLI/host configuration, never a `workspaceDir`/database-path field in a request payload. A machine `workspaceId` corresponds to human `--id`; the machine command does not use a separate `--id` option. Without host-configured workspace storage, workspace operations return `UNSUPPORTED_FEATURE`.

| Operation | Payload |
| --- | --- |
| `workspace.create` | `workspaceId`, `bundlePath`, `title`, `goal`, `mode` (`world` or `succession-demo`), `idempotencyKey` |
| `workspace.read` | `workspaceId`, optional `atVersion` (otherwise latest) |
| `workspace.review` | `workspaceId`, `expectedVersion`, optional `limits.maxWorkUnits` |
| `workspace.mutate` | `workspaceId`, `expectedVersion`, `idempotencyKey`, typed `action` |

Read the original state of the workspace created above:

```sh
node apps/cli/dist/main.js json --workspace-dir ./wmm-workspaces/machine-demo <<'JSON'
{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"read-initial","operation":"workspace.read","payload":{"workspaceId":"main","atVersion":1}}
JSON
```

Omit `atVersion` to read the latest. Historical reads do not roll back current state. Success returns a `wmm.workspace-view/1` in `data`, with `resolved` identifying the pinned world/snapshot.

For a freshly created `machine-demo` at version 1, this saves advisory direction at version 2:

```sh
node apps/cli/dist/main.js json --workspace-dir ./wmm-workspaces/machine-demo <<'JSON'
{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"direction-1","operation":"workspace.mutate","payload":{"workspaceId":"main","expectedVersion":1,"idempotencyKey":"direction-1","action":{"kind":"set-direction","text":"Keep the dynasty. Prefer diplomacy."}}}
JSON
```

Review that exact resulting version (2). The operation stores a receipt separately and does not create workspace version 3:

```sh
node apps/cli/dist/main.js json --workspace-dir ./wmm-workspaces/machine-demo <<'JSON'
{"format":"wmm.request/1","apiVersion":"wmm/1","requestId":"review-v2","operation":"workspace.review","payload":{"workspaceId":"main","expectedVersion":2}}
JSON
```

If the workspace has advanced, read its latest version before composing a new mutation; do not guess or silently rebase. Available action kinds are `decide`, `select`, `put-proposal`, `set-direction`, `put-pin`, and demo-only `add-regency`. `select` replaces the full selected set, so include previously selected groups that should remain selected. Rejected groups must first be explicitly restored to undecided.

### Replay, stale writes, and errors

An idempotency key binds normalized semantic intent, not the correlation `requestId`. Replaying the same intent/key returns its **original saved state** before checking the now-current version. Changing intent (including its expected version) under that key returns `IDEMPOTENCY_CONFLICT`; a new key with a stale expected version returns `STALE_WORKSPACE`. Neither case silently merges or creates a new state. Human open/demo commands refresh the latest view after create replay rather than displaying the original state.

JSON exit classes remain `0` success, `2` request/version/unsupported-feature rejection, `3` world/record or workspace domain rejection, and `4` storage/internal failure or incomplete interval/workspace-review budget exhaustion. Workspace domain codes include `STALE_WORKSPACE`, `IDEMPOTENCY_CONFLICT`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_EXISTS`, and `INVALID_WORKSPACE_ACTION`. Invalid wire shapes are `INVALID_REQUEST`; well-shaped but inadmissible draft actions are rejected by application admission. See [the README](../README.md#json-api-exit-codes).

The interactive controller marks a save complete only after acknowledgement. On failure it retains the form/action/key/version and attempts a refresh without resubmitting:

- Unknown outcome: Enter/`y` explicitly retries the identical action, expected version, and idempotency key.
- Stale outcome: inspect the refreshed version and displayed outgoing action. Enter/`y` explicitly resubmits at the refreshed version with a new key; this can replace newer authoring data and is not an automatic merge.
- If a rationale's structured proposal changed, stale retry is blocked. `b` explicitly loads current proposal structure into the retained rationale form without saving; inspect and save separately.
- In the failure dialog, `r` refreshes only; Esc returns to the retained buffer. Unsaved input is not restart-persistent.

## Bounded first workspace

| Boundary | Limit |
| --- | --- |
| Base record summaries / document views | 256 each, without pagination |
| Proposal groups / pins | 256 each |
| Operations per group / group-ID lists | 256 each; at least one operation per group |
| Decision-history entries | 2,000 |
| Prose operation text | 65,536 UTF-16 code units |
| Advisory direction / goal / rationale / rejection reason | 16,000 UTF-16 code units each |
| Base Markdown preview | 16,000 UTF-16 code units before the truncation notice; complete bytes retained |
| Canonical workspace response | 4 MiB, also constrained by shared 200,000-value-node preflight |
| Review work / receipt | 2,000,000 work units by default (50,000,000 maximum); receipt capped at 75,000 value nodes or 1 MiB |

The existing stdin limit remains 1 MiB, with 128 parsing levels and 100,000 nodes including property names; direct API/response plain-data preflight uses 128 levels and 200,000 value nodes. Existing bundle limits also apply at creation. These intersect: accumulated history, response shape/size, or preflight can reject **before** individual item/text maxima. There is no promise that all maxima can be used simultaneously.

Admission fails before storing an over-limit state rather than pruning history or dropping proposal contents. Start a new workspace when the bounded contract is exhausted; old versions remain retained. There is no history-pruning API, pagination, general database-size quota, or large-world performance guarantee. See [all stabilization limits](STABILIZATION.md#input-and-storage-limits).

## Validation

The unit/process suite and native-PTY smoke exercise different boundaries; both should pass for workspace changes. Run them with the declared Node >=24.3.0 engine and use the actual output for the checkout being tested rather than a historical test count. There is no screen-reader certification or general filesystem power-loss certification.

For the focused component/domain/wire/application/SQLite and process/audit checks, build first because process tests use the compiled CLI:

```sh
pnpm build
pnpm exec vitest run \
  packages/core/test/workspace.test.ts \
  packages/core/test/workspace-review.test.ts \
  packages/wire-contracts/test/workspace-v1.test.ts \
  packages/wire-contracts/test/workspace-review.test.ts \
  packages/store-authoring-sqlite/test/workspace-store.test.ts \
  packages/application/test/workspaces.test.ts \
  packages/application/test/workspace-review.test.ts \
  packages/application/test/workspace-audit.test.ts \
  apps/cli/test/workspace-presentation.test.ts \
  apps/cli/test/workspace-ui.test.ts \
  apps/cli/test/workspace-command.test.ts \
  apps/cli/test/workspace-review-command.test.ts \
  apps/cli/test/workspace-review-ui.test.ts \
  apps/cli/test/workspace-audit.test.ts
pnpm verify:workspace
```

`pnpm verify:workspace` builds and runs `python3 tools/workspace-terminal-smoke.py` using only Python's standard library. The smoke is bounded, creates temporary authoring directories, and checks that source fixture bytes remain unchanged. It covers:

1. Interactive succession review, multiline input/resize between 80x24 and 120x36, normal quit, exact history, and durable reopen.
2. SIGTERM cleanup without implicitly saving an unfinished form.
3. SIGINT cleanup without implicitly saving an unfinished form.
4. Non-TTY/`NO_COLOR`, real `TERM=dumb` TTY, and explicit `--plain` fallbacks with escape-free readable output.
5. Captured-base reference atlas navigation after source loss, without mutating saved state/review.
6. Dense colour atlas inspection at large terminal size.
7. Captured-base Economy navigation, detail and resize after source loss, with unchanged workspace decisions/history/review.

Component tests additionally cover Unicode/paste isolation, explicit dependency/pin/restoration choices, save failures/stale retries, and host-editor handoff using simulated interactive streams. Application/store/process tests cover immutable bases and versions, source-loss independence, idempotent replay, stale writers, path/hash/identity admission, storage guards, correlation, and unchanged source bytes. These checks are not a substitute for broader accessibility or fault-injection certification.

Broader validation entrypoints are `pnpm check`, `pnpm verify:contracts`, `pnpm verify:v0`, `pnpm verify:seed`, `pnpm verify:v1`, and `pnpm verify:v2`; `pnpm generate:fixtures` regenerates world/V2/demo fixtures. Bounded candidate review is implemented; full historical U3 validation, U4 approval, and V4 commit/recovery are not. These commands describe checks to run, not guarantees about other checkouts.
