# Actor briefs and decision rehearsals

This slice takes **a verified authored snapshot + an explicit actor brief → actor-facing context → an external agent's proposed decision → a DM review**. WMM prepares and checks data; it does not call a model, execute an action, deliver a message, or accept anything into canon.

## Run the synthetic round trip

Use Node >=24.3.0. From a source checkout after `pnpm build`:

```sh
node apps/cli/dist/main.js actor schema
node apps/cli/dist/main.js authoring build fixtures/authoring/faction-project.json --out ./wmm-workspaces/actor-demo/bundle
node apps/cli/dist/main.js actor prepare ./wmm-workspaces/actor-demo/bundle fixtures/authoring/lantern-actor-brief.json
node apps/cli/dist/main.js actor review ./wmm-workspaces/actor-demo/bundle fixtures/authoring/lantern-actor-brief.json fixtures/authoring/lantern-decision-draft.json --out ./wmm-workspaces/actor-demo/review
```

The decision fixture is an **authored example**, not a claimed model response. All three example inputs also ship in the portable archive under `fixtures/authoring/`; use its `bin/wmm` launcher instead of `node apps/cli/dist/main.js`, and resolve fixture paths inside the extracted release. Keep generated output outside the release. The isolated release verifier exercises this actual shipped example.

Each command returns the existing `wmm/dev/1` envelope. These are opt-in development commands, not new `wmm/1` stdin operations. `prepare` returns only the actor packet in `data`; `review` returns `{review, markdown, outputDirectory}`. Without `--out`, neither command writes files. With it, review writes only a new, separate artifact directory. Repeat with a fresh output label rather than deleting or overwriting an earlier result.

For a real rehearsal, replace the authored decision example with an external agent's response. Give that agent **only `prepare`'s `data` packet**, the decision shape from `actor schema`, and your host instructions to draft rather than act. Do not send the raw brief, DM dossier, source bundle, review, or artifact directory: these contain withheld source metadata. The host/harness controls model identity, tool access, memory, and provider calls; WMM does not supply that orchestration or a sandbox.

## The actor brief

The closed [schema](../packages/wire-contracts/schemas/actor.schema.json) and [types](../packages/wire-contracts/src/actor.ts) describe these sidecars:

- `format: "wmm.actor-brief/1"`.
- `snapshotDigest`: the exact verified bundle the curator reviewed. Obtain it from `authoring check/build` or normal world validation; do not guess it.
- `actorId`: an existing authored entity ID. Start with one faction/person; display names are not lookup keys.
- Optional `campaignId`: exactly one existing campaign. Omitting it admits only setting-scoped source references.
- `question`: explicitly actor-visible wording.
- `items`: unique stable local IDs, a `kind`, actor-facing `text`, and host-side `basis` references.

Item kinds are `goal`, `value`, `resource`, `constraint`, `belief`, `information`, and `unknown`. They label curated statements, not formal truth judgments. A belief may contradict the DM's actual information. A report need not be reliable. An unspecified resource is not a zero balance, and an unknown is not a negative fact.

Basis references can name:

- A captured section: `{kind: "section", ownerId, sectionId}`.
- An active authored relationship: `{kind: "relationship", assertionId}`.
- A selected-campaign track: `{kind: "track", trackId}`. The host review identifies its current assertion and bounds/subject records; earlier entries are not dated history.

References must exist in the verified authored snapshot and be setting-scoped or match the selected campaign exactly. Duplicate references within an item are rejected. An empty basis is allowed and explicitly remains **unsourced**. A valid reference does not prove the statement is entailed, that the actor actually knows it, or that the curator has user approval to establish it as canon.

The brief is a separate, editable sidecar, not an extension of the authoring-project schema. Atlas geometry, territorial models, existing semantic-profile identities, and world data are not changed by this workflow.

## Explicit disclosure, not an omniscience filter

Actor preparation copies only the question and curated item wording, plus the actor's own ID/name, selected campaign ID, opaque identity bindings, bounds, and fixed limitations. It does **not** automatically copy source prose, document headings, citation titles/paths/locators, relationship values, track values, or linked neighbors. The original source references stay on the host; the actor packet omits every item's `basis`.

This matters even when a referenced section is labelled `lore`: that category is not proof that this actor knows every sentence. An internal assessment, an institutional rumor, and an omniscient DM note are different things. Curate the exact wording the actor receives rather than forwarding a whole mixed section.

**The curator can still disclose a secret by writing it into the question or an item.** The actor's own display name and selected IDs are also visible. This policy is not access control, cryptographic secrecy, automatic redaction, institutional knowledge propagation, or isolation from a harness's other memory/tools. Hashes bind content; they do not authenticate its author or establish truth.

## Context and proposed output

`prepare` returns `wmm.actor-context/1` with `perspective: "actor"`, `selectionPolicy: "explicit-curation"`, the complete curated item set, and a deterministic `contextDigest`. The context binds the snapshot, semantic profile, captured authoring input, canonical brief identity, selected actor/campaign, question, items, limits, and limitations.

The external agent returns `wmm.actor-decision/1`:

- Fixed `status: "proposed"` and the exact supplied `contextDigest`.
- `action` and a short in-character `rationale`, each `{text, basis: [briefItemIds]}`.
- `uncertainties`, with the same statement shape; their basis may be empty rather than fabricated.
- `communication: null`, or `{status: "draft", recipient, text, basis: [briefItemIds]}`. The recipient is descriptive text, not a delivered-message record or an automatically created entity.

Action, rationale, and any communication must cite at least one existing brief item. Unknown or duplicate citation IDs, blank text, extra fields, self-marked execution, and delivered-message statuses are rejected. WMM checks structure and reference closure, **not whether the rationale really follows from a cited item**. It cannot detect every invented assertion inside free text; the DM still reviews the content.

Review rebuilds the context from the verified snapshot and original brief instead of trusting an imported actor packet or the model's assertions about its input. Changing the snapshot, question, wording, source references, actor, or campaign makes an earlier decision stale. There is no automatic rebinding, approval, repair, or application.

## DM review and saved files

A successful review contains the rebuilt actor context, validated proposed draft, `decisionDigest`, and host-side source bindings for each curated item. Section bindings retain captured document paths/hashes; relationship/track bindings retain assertion IDs; imported citations retain source IDs, titles, paths, and locators. These remain provenance, not independent documentary evidence.

The Markdown view quotes and escapes untrusted draft text and keeps visible **proposed / not executed / draft / not delivered** labels. It shows the question, chosen action, short rationale, uncertainties, draft communication, curated context, host-only provenance, and identity bindings. It does not evaluate embedded Markdown/plugin instructions. Third-party viewers/plugins remain outside WMM's execution guarantees.

With `--out`, the fresh directory contains:

- `actor-brief.json` — the complete normalized host brief, including basis references.
- `actor-context.json` — the actor-facing packet; this is the only saved file intended as the agent's context.
- `decision.json` — the proposed output.
- `review.json` and `review.md` — structured and readable **DM-only** views.
- `wmm-actor-review.json` — snapshot/context/decision bindings and exact saved-file lengths/SHA-256 values, written last.

Output must not already exist and cannot be inside any existing WMM bundle. Symlinked output ancestors are rejected. A failed I/O operation may leave an incomplete fresh directory; WMM neither deletes nor overwrites it to retry. Use stable, private parents; these checks do not provide atomic confinement against a concurrent parent-swap adversary.

Wire validators check shape/plain-data admission only. Rebuild with the original brief and verified bundle to establish source correspondence; compare the complete structured review or saved-file bytes. Self-consistent hashes alone cannot prove source correspondence, honest awareness, reasoning quality, user approval, or canon acceptance.

## Bounds and failure behavior

- Brief/decision file inputs: regular files, no final-component symlinks, valid UTF-8 and duplicate-key-safe JSON, at most **262,144 bytes**. Programmatic inputs undergo plain-data admission; proxies/accessors are not accepted.
- Brief: **1–64 items**, **8 source references per item**, **8,192 UTF-16 code units per item**, and a **2,048-unit question**. IDs are preserved literally rather than normalized.
- Actor packet: **65,536 canonical UTF-8 bytes**, including metadata and digest. The curated set is never silently shortened: exceeding this budget fails with incomplete `ACTOR_BUDGET_EXCEEDED` and no packet. Explicitly revise the brief rather than accidentally dropping a constraint.
- Decision: bounded text, at most **16 uncertainties** and **16 unique brief references per statement**. An action/message remains unexecuted regardless of its text.
- Complete DM review: **1,048,576 canonical bytes**; rendered Markdown: **2,097,152 UTF-8 bytes**. Provenance admission accounts for entries incrementally before accumulating the whole expanded output. Exceeding a bound returns no partial successful review and writes no output directory.

These are structural/output limits, not deadlines, model-token budgets, compiler work limits, or heap isolation. Ordinary world loading/compiler correspondence has its own bounds. Unknown profiles, stale snapshots/contexts, missing references, malformed data, unsafe destinations, and I/O failure all exit nonzero. Budget exhaustion is incomplete execution; a structurally checked draft is not semantic approval.

## Private use and deferred work

Keep source vaults read-only and place private briefs, actor packets, actual model responses, and generated reviews outside both the tooling repository and source bundle. Public fixtures must remain unrelated synthetic material; an ignore rule is not the privacy boundary.

Decisions are sidecars for DM inspection, not canonical storage or delivered communications. There is no workspace mutation, timeline advancement, event execution, country simulation, automatic belief/knowledge inference, time selector, provider integration, or autonomous loop in this slice. Communication receipt/history and persistent decision continuity should be added only with their own explicit representations and acceptance rules.
