# Economy: first authoring and inspection increment

Status: implementation in progress on `feat/economy-observations`. This document specifies the increment; it does not claim these capabilities already exist. The preceding actor/context workflow was merged in PR #3.

## Product boundary

Make economic information first-class structured worldbuilding data, compiled into ordinary WMM assertions and rendered into useful DM views. Do not add a parallel economy database, mandatory micro/macro model, autonomous tick, or implicit canon acceptance.

The layers are shared measurements → a release-owned economic profile → deterministic accounting checks → optional conditional models → agent proposals. The first increment covers description and inspection, not all later layers.

## E1 acceptance target

Use one unrelated synthetic town's grain supply. Author an opening-stock observation, an explicitly future delivery commitment, and a planned food requirement. Inspect their quantities, context, source basis, reference time/period, ownership/custody or accounting boundary, and missing information in a readable Economy view. Scheduled deliveries and requirements must never appear as observed current stock.

The source must pass explicit domain admission, build an ordinary verified snapshot, survive normal world loading/export/workspace capture, and produce the same source-bound economic view after the original bundle is unavailable. Deliver a runnable CLI/DM view with the data increment rather than a disconnected ontology or mockup. Add an interactive World → Economy inspection through the actual application client; keep it read-only and explicit about its captured base.

### E1a: shared exact quantities

Implemented and independently reviewed with no blocking findings. See [the implemented measurement API](MEASUREMENTS.md). E1b and the integrated Economy experience remain in progress.

- Add independently reusable quantity/unit contracts in wire-contracts and bounded exact arithmetic in core. They do not become mandatory properties of every claim or descriptor.
- Use one canonical rational representation: signed decimal-string numerator, positive decimal-string denominator, reduced to lowest terms. Zero is `0/1`; reject leading zeros, negative zero, nonpositive denominators, and unreduced input rather than silently repairing it.
- Bound each component to 64 decimal digits (excluding the sign). Fixed arithmetic operations must return canonical results or fail closed on bounds; no floating-point amounts, silent rounding, or exponent notation.
- A quantity names an admitted unit and has an exact value, inclusive bounded estimate, or explicit unknown. Unknown is not zero. Arithmetic involving unknowns stays unknown; bounded inputs retain bounded status and conservative interval results.
- Begin with a small immutable, release-owned unit catalogue for mass and count: kilogram, tonne, and one counted item. Identity is the unit ID, not a display symbol. Unsupported/local units are rejected rather than guessed. Currency valuation, exchange rates, arbitrary authored unit definitions, and calendar-duration conversion are outside this first catalogue.
- Conversion uses only admitted exact scale definitions and compatible quantity kinds. No conversion of grain to money or sacks to mass is inferred. Resource identity remains a separate domain check; matching physical dimensions alone do not authorize adding different resources.
- Preserve descriptor-based plain-data admission and detach before consuming caller-owned arrays/objects. Schema validity is not arithmetic validity or unit admission. Do not mutate caller input.

### E1b: admitted economic observations and intentions

- Reuse the typed-literal/assertion/provenance boundary, with new release-owned meanings and explicit authoring opt-in. Do not extend descriptors with arbitrary payloads or mutate the existing authoring profile in place.
- Keep old projects, profiles, fixture identities and captured-input replay reproducible. New economic inputs must select/version the additional semantics explicitly.
- Distinguish stock at a reference point, a flow total over a reference period, and a rate. Measurement reference time/period is not claim applicability. Unmapped or unknown time remains explicit; no invented calendar mapping.
- Separate observed quantities, reported estimates, commitments, planned requirements, and later scenario outputs. Preserve qualitative descriptions alongside quantities instead of inventing measurements to fill fields.
- Distinguish ownership, custody, available use and location. A political/map polygon is not automatically an accounting boundary or complete reporting area.
- Permit direct sourced or author-stipulated aggregate observations without inventing individual farms or prior transactions. Do not require complete event history to describe an opening stock.
- Record uncertainty, method, declared coverage, and source references. None is an automatic certificate of truth, completeness or actor awareness.

## Selected E1b integration design

Add a closed, optional `economy: { format: "wmm.authoring-economy/1", records: [...] }` envelope to the authoring project. Its presence explicitly selects a new release-owned profile; absence must preserve every existing profile, payload and snapshot identity. Leave `authoringSemantics()` unchanged. The new profile adds the `economic_record` predicate and `economic_record_value` literal, with distinct admitted operations and a pinned predicate/literal pairing.

Reuse existing place, faction, item and concept descriptors. Each economic record has a project-unique slug included in its typed literal, so distinct reports with equal quantities do not collapse into one assertion. Do not introduce a separate hierarchy of economic participants or observation descriptors. Compile one positive active assertion per record, retaining the ordinary claim scope, author-stipulation support, and invariant applicability. Invariant here describes the declaration about a reference point/period; it does not assert that the amount exists forever.

The first closed record union is:

| Record kind | Specific meaning and fields |
| --- | --- |
| `stock-observation` | An observed or reported-estimate amount at a reference point; separate owner, custodian, physical location, and declared/unknown available use |
| `delivery-commitment` | An intended future total over a reference period; explicit promisor, recipient and destination, each allowed to remain unknown; future-as-authored relative to an explicit reference, not the computer clock |
| `planned-requirement` | A planned total over a reference period; planner, beneficiary and purpose, not consumption or a negative inventory |

Common fields include subject/resource references, authoring context, quantity, measurement reference, method, declared/unknown accounting boundary, declared coverage and citations. Support mapped reference points/finite half-open periods on admitted axes, unmapped authored labels, and explicit unknowns. Stock requires a point; commitments/requirements require a period. E1b's three physical-amount meanings require nonnegative admitted quantities; this is not a general restriction on the shared signed quantity primitive or financial accounts. Limit records to 64 and fail closed on complete-view output budgets.

Nested references require ordinary semantic closure: subject/resource/parties, declared owner/custodian, physical locations, boundary members, cited sources, and mapped axes. Check place roles where a location is required. For this new profile only, emit declared citation sources as ordinary `sourceType: "document"` records with `content: { availability: "none" }`, without opening their paths or inventing content hashes/support. The wire value `availability: "unavailable"` requires a known content hash and is inappropriate for a path-only authored citation. Preserve the captured-project stipulation support; neither a method nor a citation becomes documentary proof.

Economic values and semantic citation references come from assertions, not duplicated presentation-index fields. Use the index only for verified display names, source titles and paths. Do not put these records into `AuthoringNoteIndex.facts` or integer tracks; their existing consumers assume different meanings.

Add one pure economic projection, a verified-bundle adapter and a captured-base adapter. A stored SQLite base is decoded data, not new validation: reconstruct all retained record/document payloads against the complete manifest, recompute snapshot/profile identities, require recognized release trust, and check captured-project recompilation before using presentation metadata. Reuse/extract the bounded reconstruction precedent in `workspace-review.ts`'s private `admitBase`, not `reviewWorkspace()` or its selection/mutation machinery.

The shared reconstruction seam is implemented as `verifyCapturedWorkspaceBase` and passed independent review with 102 focused base/review tests. It returns detached, deeply frozen retained data and requires an explicit host-pinned world/snapshot/profile binding. It does not authenticate that host policy or replace the economic adapter's release-profile and captured-project correspondence checks; the integrated adapter/UI remain in progress.

Expose a separate opt-in `workspace.economy.read` result, without changing `WorkspaceViewV1`. Bind workspace/version/base, profile and input digests; label DM perspective, base-only data, selected proposals excluded, candidate view unavailable, and accounting/scenarios not run. Wire the actual application service, API allowlists/result schema and host-constructed CLI client, not just a component fake. Provide direct-snapshot and captured-workspace plain/JSON commands over the same projection, plus an optional `readEconomy()` client capability and a World inspection subview. Wrong-base/version results and mutation shortcuts must not be accepted in this subview.

Generalize authored-presentation correspondence through a new explicitly profile-aware helper for economic compilation/inspection; do not weaken existing strict wrappers accidentally. Preserve old actor/entity-context profile guards and packet identities in E1b: a new economic profile is explicitly unsupported there until a separately tested integration, rather than automatically adding economic knowledge or claiming complete old-style dossiers. Resolve the new profile's DM-note projection compatibility explicitly before closing E1; never silently render economic data as a complete empty view.

Acceptance must include coherently rehashed malformed literal/reference tests (not checksum failures), old-profile identity vectors, discovered/captured source loss, base/presentation tampering, real CLI/API clients, read-only UI navigation with existing selected proposals/review receipts, and an isolated shipped grain example. No accounting totals, fulfillment, rate/currency support, scene generation or canon adoption is implied by this description layer.

## Later increments

E2 adds bounded physical inventory reconciliation, fulfillment allocations and explicit aggregation, with exact input identities and duplicate/overlap checks. Incomplete coverage produces an explained insufficient-premises result, not an impossible-world verdict. No universal conservation of money, reciprocal payment, or institutional compliance rule is implied.

E3 adds read-only snapshot-bound scenario comparison. Runs bind model/version, inputs, assumptions, horizon, parameters and any seed. Report unmet requirements separately from physical stock. Numerical results do not entail price changes, famine, riots or political outcomes. Existing workspace proposal operations do not yet supply this scenario capability; add it explicitly rather than treating selection as execution or adoption.

Behavioral models and actor knowledge remain separate: a DM economic view is not an actor packet. Only an explicitly curated brief should disclose economic information to an external agent.

## Verification

Use test-first vertical slices. Cover canonical-number rejection, exact conversions, incompatible or unadmitted units, unknown/interval propagation, overflow and behaviorful input. Then cover authoring/admission/normal loaders, coherently rehashed tampering, source-bound views, original-source loss, read-only UI navigation and packaged examples. Run supported Node, strict source/test checks, all fixtures, PTY smoke and independent review before declaring E1 complete.

All source and examples in the repository are reusable tooling or invented data. Private campaign material, briefs and outputs stay in a separately authorized private directory. No approval, world execution, message delivery or canonical writes are part of this increment.
