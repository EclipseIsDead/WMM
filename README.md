# World Master's Manual

World Master's Manual (WMM) is a worldbuilding tool for inspecting a world's records, exploring alternative prose, and keeping track of draft decisions in a terminal workspace.

**Pre-release:** draft decisions are saved locally, but the original world stays unchanged. Full historical validation, approval, and committing drafts to canon are not available yet.

## Quick start

WMM currently runs from source; there is no published installable release. You'll need:

- **Node.js 24.3.0 or newer**
- **pnpm 10.12.4** (the version pinned by this repository)

From a local checkout, run these commands in the repository root:

```sh
pnpm install --frozen-lockfile
pnpm workspace:demo
```

The demo command builds WMM and opens a worked succession scenario with draft alternatives ready to explore. Run it again to return to your saved workspace—your decisions won't be reset.

### Your first session

Use a terminal at least **80 columns × 24 rows**. The editor has five views: **Changes, World, Constraints, History, and Review**.

- **Tab** switches views; **↑ / ↓** moves through items.
- **Enter** inspects an item; **Esc** returns or cancels.
- **Space** selects or unselects a draft change in Changes.
- **a** adds a prose proposal; **Ctrl+S** saves a form.
- **?** shows keyboard help; **q** quits outside a form.

Saved decisions live in `wmm-workspaces/succession`, separate from the source world. Selecting a change saves a draft decision; it does **not** validate history or change canon.

For more controls and a guided walkthrough, see the [workspace guide](docs/WORKSPACE.md).

## Open a world or resume your work

After the initial build, open the included example bundle without the demo's proposals:

```sh
node apps/cli/dist/main.js workspace open fixtures/v1/complete-world --workspace-dir ./wmm-workspaces/my-world
```

Replace `fixtures/v1/complete-world` with the path to another verified WMM bundle to inspect it. Keep the workspace directory separate from the source bundle, with neither directory inside the other.

Resume that workspace later:

```sh
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/my-world
```

WMM captures the base world when creating the workspace. Resume uses that saved snapshot, even if the original bundle moves or changes. The source bundle is never modified.

## Plain output and automation

Add `--plain` to inspect a workspace without the interactive editor:

```sh
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/succession --plain
```

Non-interactive terminals use plain output automatically. Workspace commands also accept `--json`; machine clients can use the versioned `wmm/1` JSON stdin API. See the [workspace API documentation](docs/WORKSPACE.md) for details.

Node's built-in SQLite may print an experimental-feature warning on stderr. This is separate from JSON output.

## Documentation

- [Workspace guide](docs/WORKSPACE.md) — controls, prose proposals, storage, recovery, and the machine API.
- [Release notes](docs/RELEASE-NOTES.md) — the current unreleased capability inventory, technical details, and validation commands.
- [Implementation status](docs/STATUS.md) — what works today and what remains planned.
- [Contracts and limitations](docs/STABILIZATION.md) — supported semantics and safety boundaries.
- [Engineering plan](plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md) — the underlying RFC; its version is separate from a WMM package release.

## Development

```sh
pnpm build    # Compile the engine and CLI
pnpm check    # Run the identity verifier, TypeScript checks, and tests
```

Additional fixture and terminal validation commands are recorded in the [release notes](docs/RELEASE-NOTES.md).
