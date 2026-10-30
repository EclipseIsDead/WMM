# DM import and worldbuilding harness

The harness takes **one readable authoring project + explicitly selected source notes + a task**, lets an agent interact with bounded WMM tools, and builds an explicit **DRAFT** for DM review. It is a helper for structured worldbuilding, not a vault copier, a new provider framework, or an automatic canon writer.

This first mode is `dm-import`. It can see the selected DM project, including its DM-only material. It is **not** an actor-knowledge filter or player-safe context. The [separate actor workflow](ACTOR-WORKFLOW.md) remains separate; this harness does not execute actor decisions or deliver communications.

## Run the public synthetic example first

Use Node.js >=24.3.0, build WMM, and have a compatible Hermes installation on `PATH`. Hermes supplies the existing agent loop and provider authentication; WMM supplies the scoped tools and draft validation. No credentials belong in the request file.

The optional adapter uses source fingerprints for reviewed SDK integration seams (Hermes checkout `bf0203a794a07aac3ff764972ab9087baa4e4f4e`). Changes to those seams fail with `UNSUPPORTED_HERMES_VERSION` until reviewed; there is no bypass flag. This is a compatibility tripwire, not installation authenticity. Invoking Hermes also invokes its normal launcher/bootstrap, which may finish its own pending installation maintenance; WMM does not initiate or suppress an update or modify its settings.

Replace the output placeholder below with a fresh writable directory **outside the selected source tree**:

```sh
pnpm build
node apps/cli/dist/main.js harness run examples/harness/dm-import.json --out /absolute/path/to/new-synthetic-run
```

The [shipped request](../examples/harness/dm-import.json) selects an [unrelated synthetic beacon note](../examples/harness/selected/beacon-rota.md) and the existing [faction project](../fixtures/authoring/faction-project.json). Its baseline includes narrative, an explicit relationship and a track with two entries; preserving them is not an empty-collection assertion. The task requests a name change and an additional sourced DM note, not a strike, payment or change to campaign state.

Optional `--model <model>` and `--provider <provider>` select the Hermes route without changing a profile. From an extracted portable archive, use `bin/wmm` instead of `node apps/cli/dist/main.js`. Hermes is an external optional runtime, not a bundled dependency of the WMM engine.

Commands use the existing development JSON envelope, `wmm/dev/1`. A successful result has `data.status: "draft"` and paths to the proposed project, verified bundle, notes and review. Harness requests/proposals/run artifacts have their own `wmm.dm-harness-*/1` formats. They are **not new `wmm/1` stdin operations**.

## Select inputs explicitly

The operator-owned request is closed JSON with these fields:

- `format: "wmm.dm-harness-request/1"` and `mode: "dm-import"`.
- `projectPath`: the readable authoring-project JSON file.
- `sourceRoot`: an explicit read-only source directory.
- `task`: the requested DM/worldbuilding work.
- `sources`: selected `{id, title, path}` entries. Each `path` is a portable relative file path beneath `sourceRoot`; the same relative value becomes logical citation metadata.

`projectPath` and `sourceRoot` resolve relative to the request file. Only the named regular files are read. There is no directory traversal, recursive discovery, glob expansion, Obsidian configuration lookup or model-supplied filesystem path capability. Symlinks, device/FIFO inputs, malformed JSON/UTF-8, duplicate keys and protected output locations are rejected. Source text preserves exact admitted UTF-8, including leading U+FEFF and CR/LF bytes.

Treat the request as **trusted operator configuration**, not an imported note or model-generated file to execute blindly. Source contents are untrusted data and cannot expand the selected file set or tool authority. Source paths inside a proposed authoring project are metadata; they are never opened by a model tool.

Keep private requests, source vaults, projects, interpretations, runs, bundles and notes in a separate private directory outside the tooling repository. Do not use `.gitignore` as the privacy boundary. The original sources remain read-only; generated notes are disposable views, not a second editable authority. Review the configured provider's handling of the data before using private material.

## The agent's tools

The agent has exactly these five capabilities, not terminal, general file reading, web access, tool discovery, delegation or persistent-memory tools:

| Tool | Host-owned behavior |
| --- | --- |
| `wmm_project_read` | Return the captured full readable project, run binding and selected-source metadata. |
| `wmm_source_read` | Return only a selected source's exact text, SHA-256, byte length and line count. |
| `wmm_authoring_schema` | Return WMM's existing closed authoring schema. |
| `wmm_proposal_check` | Run real compiler/semantic checks plus the same run/source policy used by submission. No bundle is written. |
| `wmm_proposal_submit` | Retain one explicit admitted full-project proposal for host finalization. No approval or canon action. |

The Hermes adapter runs in a separate process with an attempt-local working directory/session store. Before the host sends the task, it requires an exact scoped-tool and context-isolation handshake. The adapter must verify disabled ambient memory, project/skills/soul context and a supported built-in context engine. Unsupported configurations, SDK interfaces and external-agent transports fail closed rather than silently acquiring another runtime's native tools. It does not copy profiles or credentials or change Hermes settings.

A final prose answer is **not** a proposal submission. If the model stops, fails, or never submits an admitted proposal, the CLI returns an error and retains the run; it does not manufacture a successful draft.

The authoring guidance asks for concise table notes rather than repeated audit disclaimers. Specific uncertainty, attributed claims and conditional plans stay in the prose; general import limitations go in the separate review. Source uses should target the smallest changed field and the shortest relevant passages, splitting non-contiguous ranges. Whole-source catalogue bindings are metadata, not narrative evidence; editorial housekeeping need not invent documentary support.

`wmm_source_read` retains the complete exact `source.text` and its hash, and adds an LF-numbered `numberedText` preview for checking citations. The preview contains only whole lines and is capped at 16 KiB of JSON-encoded UTF-8; `numberedTextComplete` and `numberedThroughLine` explicitly identify any omitted tail. This preview does not alter source bytes or relax the existing tool-result budgets. Use its line numbers rather than asking the model to count a long raw document; a blank line alone cannot support narrative.

## What the DM reviews

A proposal contains the entire readable project, the exact `runInputDigest`, a summary, uncertainties and declared source uses. The selected world identity must remain unchanged. Existing source declarations stay exact; additional declarations must match selected source metadata. New/changed citations must refer to selected sources. Old unselected citations can remain only on their exactly retained authored owner/item, not be copied onto new claims as evidence.

Declared source uses bind a proposed JSON pointer to a selected source's exact captured hash and inclusive line range. Lines are 1-based and LF-delimited; a trailing LF creates an empty final line. A valid hash/range/reference does **not** establish reading, entailment, documentary support, author authentication or truth. Unattributed edits are labelled **UNSOURCED/agent interpretation**. Deletions and old values remain visible in the complete project diff.

The host recompiles the admitted project into a fresh ordinary bundle, reloads and validates it, verifies full captured-project/presentation correspondence, and renders linked Markdown with concise category/state labels. Every note has conspicuous DRAFT/not-approved/not-canon markings, and the notes manifest hashes the actual marked bytes. Audit explanations stay in the review and index instead of repeating beneath every Lore/Possibility heading. The ordinary notes renderer retains its existing full annotations by default. Open `notes/index.md` and the linked `notes/draft-review.md`; the result's `reviewPath` identifies that review.

The Markdown review shows a summary, named entity/section/field changes with before/after values, explicit additions and deletions, collection counts, declared source ranges and escaped captured excerpts, questions for the DM, and provenance. It does not dump the serialized review object into the page. Excerpts are bounded previews with explicit shortening markers; every full value, declared range and digest remains in `review.json` and the sealed capture. Catalogue bindings are labelled separately from narrative evidence. Readability and narrow ranges do not establish entailment or truth, and unsupported edits remain visibly UNSOURCED.

The run retains canonical captured input/manifest, numbered attempts and tool records, explicit proposal/submission, readable `project.json`, `bundle/`, `review.json`, linked `notes/`, and a final `result.json`. Failed/partial finalization artifacts remain inspectable. Runtime transcripts and metadata are retained separately; raw stderr is not copied into artifacts.

This is **full-project recompilation**, not export of a U3 workspace candidate. The review binds the actual generated snapshot, not an earlier U3 receipt. The [composition proposal](AUTHORING-COMPOSITION.md) still describes separate unimplemented work. Economic-profile notes are unsupported here and fail before capture/finalization; economic declarations are never silently removed to make a draft render.

## Resume without rewriting earlier attempts

```sh
node apps/cli/dist/main.js harness resume /absolute/path/to/existing-run
```

Resume re-admits sealed input and starts a fresh numbered attempt. If the latest core-owned explicit submission is complete and valid, it is re-admitted and finalized without another provider call. Otherwise the new agent attempt starts from captured inputs; this is not in-flight SDK history replay and does not fall back silently to an older proposal.

Original source files may have moved after capture. Unknown/tampered sealed input fails before another attempt. Invalid prior proposals or incomplete attempts are not canon or resume authority. Opaque SDK history, runtime output and `result.json` are not substitutes for an admitted proposal. Earlier attempts and partial output are never overwritten or deleted to retry.

## Limits and guarantees

Application admission currently caps:

- 16 sources; 64 KiB/source and 256 KiB total exact source text.
- 256 KiB canonical project; 8 KiB UTF-8 task; 512 KiB canonical proposal.
- 32 substantive tool calls/attempt; 512 KiB canonical tool arguments/results; 2 MiB admitted tool results/attempt.
- Four attempts; depth 64, 100,000 visited JSON nodes and a 2 MiB canonical capture.

The Node host independently caps transport frames at 2 MiB, tool arguments/results at 512 KiB, cumulative results at 2 MiB, stdout at 24 MiB and stderr at 64 KiB. Its 300-second watchdog terminates its owned runtime process, escalating after 500 ms if needed. These are host controls, not a hard-real-time guarantee under host suspension. Runtime iteration/output settings are **not universal HTTP-call, token or provider-spend caps**.

These bounds do not create an OS/network/CPU/heap sandbox or cryptographic authenticity. Output parents must remain private and stable; path checks are not atomic confinement against hostile concurrent parent swaps. An admitted draft remains a proposal. Unknown is not zero, a promise is not available stock, authored track order is not dated history, and no approval, message delivery, executed action or canonical-head advancement is provided.

WMM does not evaluate Markdown. Opening generated views in Obsidian with third-party plugins is outside that guarantee. See [structured authoring](AUTHORING.md), [workspace boundaries](WORKSPACE.md) and [actor curation](ACTOR-WORKFLOW.md) for the distinct contracts.
