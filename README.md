# World Master's Manual

World Master's Manual (WMM) is a worldbuilding tool for authoring structured world/campaign data, generating linked DM notes, inspecting records, and keeping track of draft alternatives in a terminal workspace.

**Pre-release:** draft decisions are saved locally, but the original world stays unchanged. Full historical validation, approval, and committing drafts to canon are not available yet.

## Quick start

To build the archive yourself, follow the [release guide](docs/RELEASING.md).

### Run from source

You'll need:

- **Node.js 24.3.0 or newer**
- **pnpm 10.12.4**

From a local checkout, run these commands in the repository root:

```sh
pnpm install --frozen-lockfile
pnpm workspace:demo
```

The demo command builds WMM and opens a worked succession scenario with draft alternatives ready to explore. Run it again to return to your saved workspace—your decisions won't be reset.

### Your first session

The editor has five views: **Changes, World, Constraints, History, and Review**.

- **Tab** switches views; **↑ / ↓** moves through items.
- **Enter** inspects an item; **Esc** returns or cancels.
- **Space** selects or unselects a draft change in Changes.
- **a** adds a prose proposal; **Ctrl+S** saves a form.
- **?** shows keyboard help; **q** quits outside a form.

Saved decisions live in `wmm-workspaces/succession`, separate from the source world. Selecting a change saves a draft decision; it does **not** validate history or change canon.

### Try the succession crisis

Inspect the death and interim-council proposals, reject the coup with a reason, and add the demo's explicit regency alternative. Review your decisions, quit, and reopen the demo to see them preserved. These are authored prose alternatives—not a generated history or proof of a valid succession.

Follow the [step-by-step succession walkthrough](docs/WORKSPACE.md#worked-succession-review) for the full exercise and controls.

## Open a world or resume your work

From a source checkout after the initial build, open the included example bundle without the demo's proposals:

```sh
node apps/cli/dist/main.js workspace open fixtures/v1/complete-world --workspace-dir ./wmm-workspaces/my-world
```

For a packaged release, use `./world-master-manual-0.1.0-alpha.1/bin/wmm` instead of `node apps/cli/dist/main.js` and supply your own verified bundle path; the archive includes the succession demo, not the other example fixtures. Replace `fixtures/v1/complete-world` with the path to another verified WMM bundle to inspect it. Keep the workspace directory separate from the source bundle, with neither directory inside the other.

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

## Author data and generate DM notes

An agent can interpret your existing material into a readable structured project, compile a fresh verified WMM snapshot, and generate linked Markdown views for Obsidian. The first slice supports named entities, explicitly declared relationships, labelled narrative, and campaign-scoped integer tracks. It does not infer facts from prose or import an entire vault automatically.

Start with the synthetic `fixtures/authoring/faction-project.json` and the [structured authoring guide](docs/AUTHORING.md). Keep private projects, source material, bundles, and generated notes outside this repository. Each build/render uses a fresh destination; this does not add approval or committing to canon.

`context entity <bundle-directory> <entity-id> [--campaign <campaign-id>]` prepares a bounded, cited DM-side dossier for a harness from the verified authored snapshot. It includes direct relationships, selected narrative/explicit incoming references, and current campaign tracks, with byte/item limits and explicit omission counts. It does not call a model or decide what an actor knows. See [entity context](docs/AUTHORING.md#entity-context-for-an-agent-harness) for commands and contracts.

## Documentation

- [Workspace guide](docs/WORKSPACE.md) — controls, prose proposals, storage, recovery, and the machine API.
- [Structured authoring](docs/AUTHORING.md) — agent-editable data, snapshot builds, provenance, and generated DM notes.
- [Release notes](docs/RELEASE-NOTES.md) — prerelease changes, technical details, and validation commands.
- [Release guide](docs/RELEASING.md) — build and verify a portable archive.
- [Implementation status](docs/STATUS.md) — what works today and what remains planned.
- [Contracts and limitations](docs/STABILIZATION.md) — supported semantics and safety boundaries.
- [Engineering plan](plans/WMM-PHASE-1-ENGINEERING-PLAN-v0.3.md) — the underlying RFC; its version is separate from a WMM package release.

## Development

```sh
pnpm build
pnpm check
```

Additional fixture and terminal validation commands are recorded in the [release notes](docs/RELEASE-NOTES.md).
