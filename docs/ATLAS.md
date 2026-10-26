# Read-only ASCII reference atlas

Increment A adds a **World → Map subview**, not a sixth workspace tab. It renders admitted, fixed reference geometry from the workspace's captured base. It does not infer political ownership, run candidate review, edit geography, or change saved decisions.

The service and UI distinguish two independent boundaries:

- **REFERENCE ATLAS:** undated outlines; political facts not projected.
- **BASE WORLD:** selected proposals are not shown; candidate view unavailable.

Those labels come from the map service's explicit result metadata. Selecting a proposed transfer elsewhere does not turn this reference map into a candidate preview. The atlas remains readable after its original source bundle moves or disappears.

## Run the synthetic example

Use Node.js >=24.3.0. From a source checkout:

```sh
pnpm build
node apps/cli/dist/main.js authoring build fixtures/authoring/atlas-project.json --out ./wmm-workspaces/atlas-demo/bundle
node apps/cli/dist/main.js workspace open ./wmm-workspaces/atlas-demo/bundle --workspace-dir ./wmm-workspaces/atlas-demo/workspace
```

Press **2** for World, then **m** for Map. The atlas contains overlapping regional footprints and a one-reference-pixel island; it deliberately leaves some geography unmapped. The governing faction is a separate entity, not an owner property on a polygon.

Build once into a fresh destination. Later, resume without rebuilding:

```sh
node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/atlas-demo/workspace
```

For a packaged release, replace `node apps/cli/dist/main.js` with the archive's `bin/wmm`. The archive includes `fixtures/authoring/atlas-project.json`; supply its path inside the extracted release when building. Keep generated bundles and workspaces outside the extracted release, with neither source nor workspace inside the other.

For linear inspection or automation:

```sh
node apps/cli/dist/main.js workspace map --workspace-dir ./wmm-workspaces/atlas-demo/workspace --atlas reference_demo --plain
node apps/cli/dist/main.js workspace map --workspace-dir ./wmm-workspaces/atlas-demo/workspace --atlas reference_demo --geometry-version reference_v1 --json
```

`workspace map` is always non-interactive. It requires existing storage and never initializes a workspace, mutates decisions, or runs review. `--id` defaults to `main`; `--plain` and `--json` are mutually exclusive. Plain output uses a fixed-default 72×18 ASCII grid followed by a complete feature directory, provenance, and limitations. It has no interactive prompts or terminal escapes. The normal `workspace resume --plain` remains the unchanged general workspace inspection; use `workspace map --plain` for cartography.

A world without an atlas returns an explicit empty reference view. An explicitly requested missing atlas or geometry version returns `UNKNOWN_RECORD`; it does not substitute a different map or a newer outline.

## Keyboard interaction

| Key, in Map | Action |
| --- | --- |
| `j` / `k`, Up / Down | Select semantic features in stable feature-ID order; tiny features remain discoverable regardless of raster size |
| Enter | Open the selected feature's readable inspector |
| Esc | Leave inspection, leave canvas focus, or return to World |
| `m` | Return directly to World |
| `[` / `]` | Toggle reference-feature and physical-coverage layers |
| `{` / `}` | Cycle the service-listed atlases, if more than one exists |
| `f` | Explicitly focus/unfocus the cell canvas |
| Arrows / `h j k l`, in canvas | Move the cursor across cells; movement does not silently change semantic selection |
| Enter, in canvas | Keep an already-selected intersecting feature, select a sole target, or open a stable mixed-feature chooser |
| Up / Down, then Enter, in chooser | Choose and inspect a particular reference; no first/last-drawn winner |
| Right / Left | Focus the inspector / return to the map |
| Page Up / Page Down | Scroll focused inspection, including full identifiers and provenance |
| `d` | Secondary raw map response inspection |

The baseline is 80×24; wide terminals have a side inspector. Resizing preserves semantic selection and uses the actual terminal rows and columns for cell hit testing. Terminal cells receive aspect correction and letterboxing, not calibrated distance measurements. `p` does not pin a hidden World row while Map is open. Normal explicit authoring forms remain separate from read-only map navigation.

## Colour terminal shader and redraw scaling

The interactive map uses a **CPU terminal-cell shader**, not GPU rendering or an animation loop. Geometry and interaction stay authoritative; colour is a separate presentation pass:

1. Core geometry produces a bounded framebuffer of physical states, complete intersecting feature IDs, and separate anchor references. Closed bounding boxes reject off-cell polygons before the unchanged exact narrow predicates; they never establish a hit or physical completeness. Admission still checks the whole atlas, including geometry outside the viewport, and work charges remain bounded.
2. A client-local LRU retains at most **four rasters**, so cursor movement, feature selection, colour changes, and returning to a recent size reuse geometry. At most 64 exact point-surface queries are retained as well. These are transient process-local data, not persistent spatial chunks or a second editable map model.
3. A pure shader chooses foreground/background and edge/selection emphasis from those cells. Reference-feature colours derive from stable **place IDs**, not draw order, display names, a government, or inferred ownership. Mixed-cell `+` and unknown/outside distinctions remain visible.
4. Adjacent equal styles are batched into Ink text runs instead of creating a component for every cell. Printable ASCII layout avoids repeated Unicode segmentation/prefix-width scans; Unicode inspectors retain grapheme-aware sanitization and sizing.
5. Styling is applied **after** safe plaintext layout/cropping and only to the map's grid rows. Imported source text and inspector strings cannot supply active terminal styles.

True-colour terminals receive the richer palette; 256-colour and basic 16-colour terminals have fallbacks. `NO_COLOR` (including an empty value), `NODE_DISABLE_COLORS`, `TERM=dumb`, non-TTY output, or `FORCE_COLOR=0` disables map styling. Explicit `NO_COLOR` wins over a conflicting `FORCE_COLOR`. Glyphs carry the same information without colour. Plain/JSON commands stay escape-free even if `FORCE_COLOR` is set.

For example, to request true colour in a compatible interactive terminal:

```sh
FORCE_COLOR=3 node apps/cli/dist/main.js workspace resume --workspace-dir ./wmm-workspaces/atlas-demo/workspace
```

Ensure `NO_COLOR` is unset for that example. No fixed refresh loop, continuous water animation, graphics protocol, terminal plugin, GPU dependency, or new package is required. The existing 160×60-cell and conservative geometric-work ceilings still apply; this does not promise unbounded GIS workloads.

To reproduce CPU measurements from a source checkout:

```sh
pnpm build
node tools/atlas-render-benchmark.mjs
```

The benchmark uses admitted synthetic geometry, including 64 separated regions. It reports cold geometric projection, cached colour/selection redraws, and complete plaintext-layout-plus-shader timings at several terminal sizes, while asserting zero extra rasterizations on warm redraws. Timings exclude Ink reconciliation, terminal transport, and emulator painting; they are **not** measured display FPS. No benchmark mutates a workspace or writes a persistent cache.

One local run on macOS arm64 / Node 26.12.1 measured these medians. Uncached geometry is sampled 12 times in a warmed process; cached cell shading is sampled 100 times. Results vary with host load.

| Synthetic scene / grid | Previous uncached geometry (ms) | Current uncached geometry (ms) | Cached colour pass (ms) |
| --- | ---: | ---: | ---: |
| Demo / 72×18 | 58.5 | 4.776 | 0.270 |
| Demo / 160×60 | 421.29 | 30.192 | 2.167 |
| 64 separated regions / 72×18 | 584.57 | 11.566 | 0.376 |
| 64 separated regions / 160×60 | Work-budget rejection | 71.870 | 2.682 |

The complete cached layout-plus-shader pass for the 64-region scene in a 240×80 terminal measured a 2.932 ms median over 50 samples, with **zero extra rasterizations** while changing selection. This is still a CPU microbenchmark, not terminal display latency. A separate real-PTY test opens that admitted scene in true colour, renders the 160×60 canvas, resizes to 80×24 and back, inspects a selected region, and confirms unchanged saved state. Highly overlapping complex polygons can still exceed the original work limit and remain rejected rather than approximated.

## Physical coverage and glyphs

| Glyph | Meaning |
| --- | --- |
| `.` | Recorded land coverage |
| `~` | Explicitly recorded water coverage |
| `?` | Unmapped or incompletely certified coverage inside the frame |
| `#` | Mixed physical coverage; not an inferred coastline |
| blank | Outside the declared frame |
| Letter/digit feature code | An authored geographic reference, not a governing actor |
| `+` | Multiple geometry and/or anchor references, not a political contradiction |
| `@` | Selected display anchor or canvas cursor; not enlarged geography |

No polygon does **not** mean ocean. Physical land/water coverage is independent of regional feature footprints and political facts. Cells retain all intersecting feature IDs and separate display-anchor IDs. Moving or enlarging an anchor never enlarges a footprint or establishes physical coverage.

Physical completeness uses a conservative single-polygon certificate. A cell can remain uncertain when several polygons together appear to cover it; this increment does not promote that visual impression into a proof of complete coverage. Shared land/water boundaries are unresolved rather than a draw-order winner. The feature layer can visually cover a physical glyph; switch to the physical layer and inspect cell contents when needed.

## Authoring and identity

The optional `atlases` array belongs to `wmm.authoring-project/1`. See the [synthetic fixture](../fixtures/authoring/atlas-project.json), [atlas schema](../packages/wire-contracts/schemas/atlas.schema.json), and [types](../packages/wire-contracts/src/atlas.ts).

An atlas declares:

- `format: "wmm.map-atlas/1"`, `worldId`, stable atlas ID, display title, and explicit `geometryVersion`;
- `temporalMeaning: "undated"`;
- a named frame with `[minX, minY, maxX, maxY]` extent, `reference-pixels` units, and `x-right-y-down` orientation;
- provenance with an existing WMM source ID and a locator;
- independent `physicalCoverage` polygons labelled `land` or `water`;
- features with their own ID, existing **place** entity reference, authored label, geometry, display anchor, precision, and source locator.

The compiler stores canonical, manifest-bound JSON at `maps/<atlas-id>.json`. Ordinary bundle loading recognizes and admits these assets, including world/source/place closure, geometry, and ID/path matching. A coherently rehashed malformed atlas is still rejected. Workspace capture retains exact asset bytes; map reads check their manifest binding and return the captured atlas digest.

Keep **place/region**, **polity/faction**, **cartographic feature**, and **geometry version** separate. Several footprints can refer to one place; overlapping footprints do not establish contradictory governments. An authored feature label is not a canonical-name, ownership, or documentary-truth claim. A geometry version is interpreted together with its captured base and exact digest, not as an unverified global historical identifier.

The synthetic source `source:wmm_authoring` refers to the actual compiled authoring stipulation. Entries in the project's imported citation list are not automatically WMM source records. Provenance is traceability, not verified documentary support, authentication, or approval.

Only points and explicitly closed, simple polygon outer rings are supported. Holes, multipolygons, curves, alternate coordinate systems, and automatic image tracing are rejected, not silently approximated. Coordinates must be safe integers within the declared extent and the bounded coordinate range; degenerate/self-intersecting polygons and contradictory physical interiors are rejected.

Current caps include eight atlases per world, 1 MiB per atlas asset, 64 features, 64 physical polygons, 256 vertices per ring, and 4,096 total vertices. The client grid is bounded to 160×60 cells with a separate conservative geometric-work limit. These are ceilings, not a promise that every combination of maxima can be rasterized: work exhaustion produces an unavailable rendering, not fabricated partial geography. These guards are not a hostile-process CPU/heap sandbox.

## Opt-in wire operation

The existing `WorkspaceViewV1` success shape remains unchanged. Map clients opt in through the existing JSON stdin transport:

```json
{
  "format": "wmm.request/1",
  "apiVersion": "wmm/1",
  "requestId": "read-reference-atlas",
  "operation": "workspace.map.read",
  "payload": {
    "workspaceId": "main",
    "atlasId": "reference_demo",
    "geometryVersion": "reference_v1",
    "atVersion": 1
  }
}
```

Use `node apps/cli/dist/main.js json --workspace-dir <directory>`. Only `workspaceId` is required in the payload. Omit `atVersion` for the latest saved workspace version; it chooses draft state, not a date for historical geometry. With no atlas selector, the service selects the first atlas in stable ID order and includes the available-atlas catalog. A geometry-version selector constrains that selected atlas; it does not search other atlases or reconstruct historical borders.

The `wmm.workspace-map-view/1` result binds the workspace ID/version, base world/snapshot, atlas digest, and available catalog. It explicitly reports:

```json
{
  "worldBasis": "base",
  "selectedProposalsIncluded": false,
  "factProjection": "not-run",
  "candidateView": "unavailable"
}
```

Clients rasterize structured geometry locally; the wire result is not ASCII that another client must reverse-parse. The core grid provides separate physical states, geometry intersections, and anchor references for each cell. The public read accepts no candidate flag, source path, historical date, or ownership override.

Spatial/render chunks are deliberately **not** political entities or fact subjects. A semantic region can cross multiple future chunks, and one chunk can intersect many places or jurisdictions. Persistent chunks/caches are deferred until measurements justify them.

## Verification and remaining boundary

```sh
pnpm check
pnpm build
pnpm verify:workspace
pnpm release:pack
pnpm release:verify
```

Focused tests cover contracts, unsupported geometry/resource rejection, physical unknowns, tiny features, separate anchors, deterministic mixed-cell selection, captured-base reads after source loss, historical workspace versions, selected-proposal exclusion, unchanged review association, plain/JSON output, and legacy response compatibility. The real stdlib PTY smoke additionally navigates the actual built CLI with a selected territorial prose proposal and a current review, removes the original source path, inspects the tiny island/provenance, uses the mixed-feature chooser, resizes wide → narrow → wide, returns to World, and compares saved state/history/review afterward. Isolated release verification exercises the packaged atlas input and map reads without repository dependencies.

This increment does **not** provide dated rule, effective control, influence, claims adjudication, candidate-map simulation, historical border reconstruction, travel calculations, geographic editing, private-map migration, automatic image tracing, or persistent chunk caching. Distance calibration and border dates are disclosed limitations, not invented values. The next independent increment can project explicitly dated political facts onto this explicitly identified reference geometry without claiming that its outlines reconstruct borders at that date.
