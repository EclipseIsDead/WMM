# Proposed authored-draft composition milestone

**Status: design proposal, not an implemented export command or an approved implementation scope.** The reference-type and SQLite-initialization repairs do not add project round-tripping, economic notes/context, dated authoring, approval, or canon writes.

The next useful increment is one complete authoring loop, not a new agent framework:

**economic project → captured workspace → explicit edits → review of the actual resulting snapshot → fresh reloadable DRAFT → complete linked DM notes → continued authoring.**

See [structured authoring](AUTHORING.md), [workspace boundaries](WORKSPACE.md), [economic declarations](ECONOMY.md), and [current status](STATUS.md) for what exists today.

## Why candidate export is a design decision

There are three distinct authorities:

1. The readable project is explicit authored input.
2. The canonical snapshot contains admitted records and exact document bytes.
3. The presentation index supplies verified labels, sections, context and citations; it cannot authorize facts that disagree with the snapshot.

Today, `reviewWorkspace` returns a hypothetical candidate and a bounded receipt. The application stores the receipt, not a reloadable candidate directory. A non-null candidate can still have an invalid review. `world.export` provides document metadata, not all document bytes or a bundle writer.

`verifyAuthoringBundlePresentation` recompiles the retained project and compares the complete payload before notes or economic projections use it. Workspace assertion/prose edits do not update that project or its index. Exporting the current U3 candidate alone would therefore leave presentation correspondence stale. Removing those checks is not an export strategy.

## Recommended route: edit the project, then compile and review that result

Introduce a separate, opt-in **authored-composition mode**. Keep existing U3 operations, evaluator identity, receipts, replay and persistence semantics unchanged.

- Recover the complete project from a verified captured base; do not require the original bundle directory or open citation paths.
- Apply explicit representable edits to a detached project. Start with existing indexed section text and authored relationship/economic declarations. Bind replacements/removals to exact prior document/assertion identities; carry complete replacement values, context and citations.
- Keep authored entity/source declarations, tracks and atlas unchanged initially. Do not infer claims from prose, citations from claim text, or section metadata from a new filename. Generated author-stipulation provenance still changes as described below.
- Compile the updated project **before** constructing its review. Bind the opt-in evaluation to the verified base, workspace version, selected group versions and operations, updated project digest and exact final snapshot digest.
- Reuse the bounded selection, operations, references, pins and explicit-opposition checks without changing the meaning of the legacy evaluator. A distinct admitted receipt/result contract is needed; do not put a different evaluation under the old evaluator identifier or legacy stored-receipt path.
- Reconstruct/replay from verified application state for export. Caller-supplied candidates or receipt hashes are not authority. Reject stale expected versions and incomplete/invalid evaluations.
- Publish only into fresh protected destinations, using the existing authoring writer and ordinary loader. Retain the readable project and clearly labelled DRAFT review/bindings alongside the bundle. Verify full project correspondence after reload, then render notes into a separate fresh directory.
- Continue by opening a new workspace on that verified draft. Export does not rebase the old workspace, change its version/selection/history, or replace its saved-review association.

### Compatibility cost that must be visible

Project recompilation is **not a lossless export of the current U3 candidate**:

- Even changing only section text changes the captured project digest, author-stipulation source, presentation metadata and generated supports.
- Removing a project declaration generally removes its record from that fresh compilation. U3 instead retains old immutable assertion/support records while changing active status.
- The newly compiled snapshot needs its own exact review binding. It must not be advertised under the earlier U3 `candidateSnapshotDigest`.
- Retain earlier captured bases and artifacts, and disclose derived provenance changes. Do not claim that each fresh project compilation contains the complete prior inactive-record archive.

If preserving that exact archive inside every exported snapshot is required, use the larger alternative below rather than silently changing this contract.

## Alternative: exact U3 candidate with separate presentation authority

A writer could preserve the exact candidate records, document bytes and snapshot identity. Completing notes and continuation would additionally require a self-contained draft-presentation authority bound to the verified base, exact selected operations and exact candidate.

Verified base metadata could supply labels; it could not authorize candidate facts or completeness. New assertions must come from the candidate, changed prose from its actual bytes, and new presentation metadata from explicit input. Full replay, loader admission and continuation would need their own contract. This is not achieved by retaining a stale project/index or trusting its checksum.

Choose this alternative only if exact U3 archival retention is an acceptance requirement. Do not combine the two routes under an ambiguous export command.

## Economic projections needed for the useful loop

Economic-profile rejection is currently deliberate. Replace it only with implemented, separately tested projections:

- **DM notes:** retain ordinary narrative, relationships and tracks, plus a complete economic appendix linked from participating entities. Preserve exact/bounded/unknown quantities, units, declaration category, scope, reference time, roles, method, boundary, coverage and citations.
- **DM entity context:** select whole economic items by explicit subject/direct entity references and exact setting/selected-campaign rules. Report availability, inclusion and omissions honestly. Use an opt-in contract rather than inserting fields into the closed legacy packet.
- **Curated actor context:** add an explicit admitted economic-assertion basis. Validate active/scope membership and replay against the snapshot, but disclose only curated item wording. Keep source paths, provenance and uncurated economic values host-side. Importer DM knowledge must not become actor awareness.

Stock observations, promised deliveries and planned requirements stay distinct. Unknown is not zero; reference dates are not claim applicability; no aggregate availability, fulfillment, production or consumption is inferred.

Retain existing loader, workspace, work, item and byte ceilings. In particular, economic records remain bounded at 64; complete Economy output at 1 MiB; default entity context at 65,536 canonical bytes/128 items; and actor context at 65,536 bytes with fail-closed complete curation. Do not raise limits to make composition pass.

## Fail explicitly instead of losing information

Initially unsupported edits include arbitrary machine assertions, new unindexed prose files, new entities/sources/semantic vocabulary, track-entry reconstruction, and generated-Markdown-to-project synchronization. A raw claim does not supply all project citations/presentation metadata; a prose path does not supply its owner, category or context.

The updated project, compiled candidate and presentation must stay mutually consistent. Unsupported operations must not disappear during export or be mistaken for reviewed operations.

## End-to-end acceptance test

Use only unrelated synthetic public material. **Before the initial compilation or workspace capture**, construct a detached acceptance variant of `fixtures/authoring/grain-project.json`. The shipped fixture has no sections, relationship facts or tracks; using it unchanged makes the prose edit impossible and retention checks vacuous. Keep that fixture byte-identical, and keep its sources, entity IDs/names, campaign identity and all three economic declarations unchanged in the variant.

The following seed-construction script uses the existing [authoring schema](../packages/wire-contracts/schemas/authoring.schema.json), not a new patch format or composition API. Save it as a `.mjs` file in scratch; run `node <scratch-script.mjs> <fresh-scratch-seed.json>` from the repository root. No acceptance-variant file is shipped. The citation refers to the existing `source:ledger`; its locator labels synthetic authored input, not verified documentary evidence.

```js
import { readFileSync, writeFileSync } from "node:fs";

const seed = JSON.parse(readFileSync("fixtures/authoring/grain-project.json", "utf8"));
const citations = [{ sourceId: "source:ledger", locator: "Synthetic acceptance additions" }];
seed.entities.find((entity) => entity.id === "place:store").sections = [{
  id: "opening-stock", heading: "Opening stock", category: "dm-note",
  context: { kind: "setting" },
  text: "Opening report: 600 t of grain at the Town Store; household and private stocks are excluded.",
  references: ["item:grain", "place:reedbank"], citations,
}];
seed.facts = [{
  subjectId: "place:store", predicate: "located_in", objectId: "place:reedbank",
  polarity: "positive", context: { kind: "setting" }, citations,
}];
const campaign = seed.campaigns.find((entry) => entry.id === "campaign:rainwatch");
campaign.sections = [{
  id: "relief-plan", heading: "Possible relief", category: "possibility",
  context: { kind: "campaign", campaignId: "campaign:rainwatch" },
  text: "The council may arrange relief; no arrival or consumption has occurred.",
  references: ["faction:council", "place:store"], citations,
}];
campaign.tracks = [{
  id: "track:relief_preparation", name: "Relief preparation", subjectId: "faction:council",
  minimum: 0, maximum: 6,
  entries: [
    { value: 1, note: "Initial planning state.", citations },
    { value: 2, note: "Supplies remain to be arranged.", citations },
  ],
}];
writeFileSync(process.argv[2], JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
```

Require admission and an ordinary build/reload of this seed before capture. Record a nonempty baseline: **2 indexed sections, 1 relationship fact, 1 campaign track with 2 ordered entries**, and the original 3 economic records. `place:store` owns the setting `opening-stock` section; `campaign:rainwatch` owns the campaign-context `relief-plan` section and track. The `located_in` target is the existing place, and the track subject is the existing council; the track's current value is 2, not a dated event or inferred economic quantity. Retain the verified index, exact section paths/bytes and metadata, relationship declaration, and complete ordered track values/notes/citations as comparison inputs. Derive assertion/document identities from the admitted build, not invented IDs.

The seed setup above uses only implemented construction/build/inspection paths. **The composed review/export, economic notes/context and continuation checks below are proposed acceptance gates, not runnable claims about current functionality.**

1. Capture that verified seeded bundle, then remove access to the original bundle directory.
2. Propose one explicit group correcting economic record `opening` from **600 t to 575 t** and replacing only `600 t` with `575 t` in the existing indexed `place:store` / `opening-stock` section. Bind both replacements to their exact prior identities; preserve the section's heading, category, context, references and citations. Leave an alternative unselected.
3. Review the composed project's actual final snapshot and export a fresh clearly labelled DRAFT. Compare the old workspace's versions, selection, history and saved review before/after: all must be unchanged.
4. Reload through the ordinary loader and verify complete captured-project correspondence. Notes and Economy inspection show **575 t**, a separate **200–250 t** commitment, and an **unknown** planned requirement. Require exactly 2 indexed sections, 1 relationship fact and 1 track with its 2 entries: only the opening-stock text and economic amount change at the authored-value level. Compare the untouched possibility's exact bytes/metadata, the relationship's direction/polarity/context/citations, and the track's subject, bounds, ordered values/notes/citations and current value against the nonempty baseline; verify their links. Generated provenance/support identities may change as disclosed above. Economic entity context either includes whole items or reports exact omissions; an actor receives only curated wording, and a stale snapshot-bound brief is rejected.
5. Open a new workspace on the exported bundle and perform another draft edit without the original bundle, project path or citation files. Earlier artifacts remain unchanged.
6. Reject stale versions, unsupported edits, invalid references, pin violations, conflicting selected writes, over-budget inputs, forged/stale presentation and existing/descendant output destinations without publishing a misleading success artifact.

Passing this scenario establishes a bounded draft workflow, not historical truth, approval or accepted canon.

## Separate later milestones

- **Dated authoring:** explicitly introduce office entities and one dated appointment/tenure workflow on the admitted day axis. Keep old facts invariant; author appointment points and tenure intervals separately, with before/at/after queries. Do not infer succession, exclusivity, removal or economic consequences.
- **Canon acceptance:** design host approval, domain revision storage, expected-head acceptance/idempotency, recovery and coordinated backup/restore before branches or promotion. A Git source commit, SQLite draft transaction or valid receipt is not accepted world canon.
- **Economics:** add actual movement/consumption/production/loss observations and one explainable reconciliation before markets, prices, macro indicators or simulation.
- **Harness:** compose the verified authoring/context/proposal services around an existing agent runtime only after the chosen draft loop works. Keep private imports and actor roleplay as separately scoped modes; do not add provider execution to fix an export gap.
