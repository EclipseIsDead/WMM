# Economic declarations and read-only inspection

WMM's first economy increment describes **what is reported, promised or planned**, not what the world will do next. Author economic data in an ordinary structured project, build a verified snapshot, and inspect it through a linear CLI or **World → Economy**.

There is no automatic inventory update, availability total, fulfillment calculation, price model, scenario run or canon adoption.

## Runnable synthetic grain example

Use Node >=24.3.0 and run from the source checkout root. The output directories below must be fresh; neither the workspace nor any generated view may be inside the source bundle.

```sh
pnpm build
node apps/cli/dist/main.js authoring check fixtures/authoring/grain-project.json
node apps/cli/dist/main.js authoring build fixtures/authoring/grain-project.json --out ./wmm-workspaces/grain-world
node apps/cli/dist/main.js economy inspect ./wmm-workspaces/grain-world
node apps/cli/dist/main.js economy inspect ./wmm-workspaces/grain-world --json
node apps/cli/dist/main.js workspace open ./wmm-workspaces/grain-world --workspace-dir ./wmm-workspaces/grain-review
```

In an unpacked release, use `./bin/wmm` in place of `node apps/cli/dist/main.js` and skip the build. The grain input and economic/measurement schemas are shipped in the archive.

The invented Reedbank dataset contains:

| Declaration | Quantity | Reference and scope |
| --- | --- | --- |
| Opening town-store stock observation | Exact `600 t` | Mapped point on the admitted `days` axis; setting scope; private/household stocks explicitly excluded |
| Future delivery commitment | Inclusive bounded `[200, 250] t` | Mapped future period relative to an authored point; setting scope; arrival is not asserted |
| Planned relief requirement | `unknown t`, not zero | Unmapped authored relief-season label; separate Rainwatch campaign scope; no invented mass estimate |

The shared physical unit does not make these three declarations an inventory balance. They differ in meaning, reference time and context. The complete view shows method, coverage, boundary, parties, ownership/custody/location where applicable, citation locators and source-bound identities.

These are synthetic authored inputs, not observations made by a model or imported private campaign material. Keep real projects, original source material, generated snapshots and private DM views outside the tooling repository. Original source material remains read-only.

## Terminal controls

In the workspace editor:

- **2** opens World; **o** opens Economy. **o** returns to World.
- **[ / ]** switches stock observations, future commitments and planned requirements.
- **j / k** or **Up / Down** highlights records; **Enter** opens readable details.
- At 100+ columns, the list and inspector appear together. **Right / Left** moves inspector focus; narrower terminals use the detail view.
- **PageUp / PageDown** scrolls details. **d** shows the raw bound payload.
- **Esc** returns from details/inspector to the list, then to World.
- **?** opens the keyboard guide.

Economy is read-only. Edit, pin, proposal-selection, advisory-direction and review shortcuts cannot operate on hidden World/Changes rows while this subview is open. Navigation, category changes and resizing do not advance the saved workspace version or change proposals, history or the saved review association.

The screen labels **DM perspective**, **base world**, excluded selected proposals and unavailable candidate view. Highlighting an economic record is not selecting a proposal, executing a delivery, or adopting a declaration as canon. An older client without the opt-in read capability reports Economy unavailable instead of inventing an empty inventory.

## Plain and machine output

Direct snapshot inspection:

```sh
node apps/cli/dist/main.js economy inspect ./wmm-workspaces/grain-world
node apps/cli/dist/main.js economy inspect ./wmm-workspaces/grain-world --json
```

Captured-workspace inspection and reopening:

```sh
node apps/cli/dist/main.js workspace economy --workspace-dir ./wmm-workspaces/grain-review --plain
node apps/cli/dist/main.js workspace economy --workspace-dir ./wmm-workspaces/grain-review --json
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/grain-review
```

`--id <workspace-id>` is supported for workspace commands; the default is `main`. Plain and JSON are separate output modes. Plain output is terminal-safe, escape-free and readable without an interactive terminal; use JSON to copy exact unwrapped identifiers or consume structured values.

The direct `--json` command uses the existing canonical **`wmm/dev/1`** development-command envelope with an `EconomyView` in `data`. The captured command uses the distinct **`wmm/1`** `workspace.economy.read` response, not a legacy `WorkspaceViewV1`.

For a configured JSON workspace gateway, the new operation takes a payload with `workspaceId` and optional `atVersion`. Its `WorkspaceEconomyView` binds workspace ID/version and `{worldId, snapshotDigest}`, contains the complete `economy` view, and fixes `worldBasis: "base"`, `selectedProposalsIncluded: false` and `candidateView: "unavailable"`. Clients must check those bindings before displaying the response; a shape-valid response alone is not proof of source correspondence.

Creating a workspace captures exact base data. Subsequent Economy reads reconstruct and validate the retained manifest, records, semantic profile and document bytes, then verify compilation correspondence to the captured authoring project. They do not reopen the original bundle or any declared citation path. Moving the source bundle therefore does not change this view. A selected prose/claim proposal and its candidate-review receipt do not change the displayed base economy.

## Authoring contract

The closed [authoring schema](../packages/wire-contracts/schemas/authoring.schema.json) accepts an optional envelope:

```json
{ "economy": { "format": "wmm.authoring-economy/1", "records": [] } }
```

Its presence explicitly selects the release-owned economic authoring profile. Absence preserves the original authoring profile and existing compiled identities. The schema and readable input live in the usual authoring project, not a parallel economy database.

Use the complete [grain project](../fixtures/authoring/grain-project.json), [economic wire types](../packages/wire-contracts/src/economy.ts), and [economic schema](../packages/wire-contracts/schemas/economy.schema.json) as the exact input reference.

- Each declaration has a unique report slug, ordinary subject/resource IDs, exact setting/campaign context and invariant claim applicability. Its report slug remains in the assertion literal so equal reports do not collapse into one assertion.
- Stock has an observed/reported-estimate status and a point reference; owner, custodian, physical location and available use remain separate declared/unknown fields.
- A delivery has a period, promisor/recipient/destination and explicit future-as-authored timing relative to a point. WMM checks ordering where the admitted mappings make it comparable, never against the computer clock.
- A requirement has a period, planner, beneficiary and purpose. It is a plan, not consumption or negative inventory.
- Mapped points/finite half-open periods name admitted axes; unmapped labels and unknown references stay explicit. A quantity's reference is **not claim applicability**: invariant applicability describes the declaration, not an assertion that its physical amount exists forever.
- These three physical-amount meanings require nonnegative admitted quantities. The independently reusable [measurement primitive](MEASUREMENTS.md) still supports signed arithmetic and is not a financial-accounting theory.
- Entity/source/axis references must close over actual admitted records. Declared location/destination roles require places. No place polygon automatically becomes a complete accounting area.

The first catalogue is kilogram, tonne and one counted item. Amounts are canonical reduced rational strings with exact/bounded/unknown magnitudes; no float rounding, currency conversion, local sack weights, rates or calendar-duration conversions are inferred. Dimension compatibility alone does not establish that two reports concern the same resource or boundary.

A project can contain at most **64 economic records**. The complete canonical `EconomyView` is bounded to **1 MiB**; an oversized view fails rather than silently omitting reports. General authoring/bundle/workspace limits still apply and are not CPU/heap isolation guarantees.

## Provenance and limits

Economic values and semantic citations come from admitted assertions. Display names, citation titles and paths are used only after checking the captured project's compilation correspondence. Coherently rehashing a stale presentation index does not make it authoritative.

Path-only citations create document sources with `content.availability: "none"`: no file content or content hash is fabricated. Actual assertion supports remain author-stipulations bound to the captured project. A source reference, declared method, "observed" status or `complete-as-declared` coverage is not independent proof of truth, completeness or actor awareness.

This increment does **not** add inventory reconciliation, fulfillment allocations, aggregation, production/capacity models, price behavior, currency/rates, scenarios, ticking worlds, approval or canonical writes. Unknown remains unknown, promises remain promises, and agent interpretations remain authored proposals/declarations.

For the new economic profile, legacy `notes render`, entity-context and actor preparation paths deliberately report unsupported rather than silently omit economic information or disclose DM knowledge. Use this complete Economy view for economic inspection. Economic Markdown-note integration and explicitly curated actor disclosure are separate later work; ordinary non-economic authoring/notes/context/actor behavior remains unchanged.

## Verification

The integration is exercised with ordinary check/build/load/export paths, strict source/test types, coherent malformed/rehashed inputs, deterministic direct/captured reads, source-loss replay, unchanged saved selections/history/review, real wide/narrow/wide PTY navigation and an isolated archive containing the grain example. The fixture gate covers **105 JSON inputs / 64 checks**, including economic views instead of false-positive legacy note rendering and an explicit unsupported-note regression. These checks establish the implemented bounded contract, not general economic truth or model validity.
