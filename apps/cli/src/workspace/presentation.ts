import type { ProposalGroupV1, WorkspaceViewV1 } from "@wmm/wire-contracts";
import { documentHash, groupTitle, tabs, worldItems } from "./controller.js";
import type { EditorForm, WorkspaceUiState } from "./controller.js";
import { textWithCursor } from "./input.js";
import { crop, ellipsis, fit, graphemes, viewport, wrap } from "./text.js";
import { reviewLines, reviewValidationLabel } from "./review.js";
import { renderAtlasBody } from "./atlas-renderer.js";
import type { AtlasPaint } from "./atlas-shader.js";
import { renderEconomyBody } from "./economy-renderer.js";
export { reviewLines } from "./review.js";
export { renderEconomyPlain } from "../economy-format.js";

const decisionTag = (group: ProposalGroupV1): string => group.decision === "selected" ? "[x] Selected" : group.decision === "rejected" ? "[-] Rejected" : "[ ] Undecided";
const prose = (lines: readonly string[], width: number): string[] => lines.flatMap(line => wrap(line, width));
const raw = (value: unknown, width: number): string[] => prose(JSON.stringify(value, null, 2).split("\n"), width);
const pinLabel = (pin: WorkspaceViewV1["workspace"]["pins"][number]): string => `${pin.active ? "[PIN ACTIVE]" : "[PIN INACTIVE]"} ${pin.kind === "document" ? pin.path : pin.assertionId}`;

export function changeLines(view: WorkspaceViewV1, group: ProposalGroupV1, width: number): string[] {
  const change = view.changes.find(item => item.groupId === group.id);
  const prerequisites = view.prerequisites.find(item => item.groupId === group.id);
  const lines = [group.title, `${decisionTag(group)} | Author: ${group.author} | Proposal v${group.version}`, "",
    `Representation: ${change?.representation ?? "Service change view unavailable"}`, "", "BEFORE (service view)",
    ...(change ? change.before.length ? change.before : ["No before text supplied by the service."] : ["Unavailable."]),
    "", "PROPOSED (service view)", ...(change ? change.proposed.length ? change.proposed : ["No proposed text supplied by the service."] : ["Unavailable."]),
    "", "RATIONALE", group.rationale || "No rationale supplied.", "", "PREREQUISITES (service view)",
    ...(prerequisites ? prerequisites.required.length ? prerequisites.required.map(id => `${prerequisites.rejected.includes(id) ? "REJECTED" : prerequisites.missing.includes(id) ? "MISSING" : "Required"}: ${groupTitle(view, id)}`) : ["No prerequisites reported."] : ["Unavailable; selection is disabled until supplied."]),
    ...(group.rejectionReason !== null ? ["", "REJECTION REASON", group.rejectionReason || "No reason supplied."] : []),
    "", "SELECTION DIAGNOSTICS — NOT HISTORICAL VALIDATION",
    ...view.selection.diagnostics.filter(item => item.groupIds.includes(group.id)).map(item => `${item.code}: ${item.message}`),
    "", "d: raw admitted operations and full identifiers",
  ];
  return prose(lines, width);
}

function worldLines(view: WorkspaceViewV1, index: number, width: number, showRaw: boolean): string[] {
  const item = worldItems(view)[index];
  const context = ["BASE WORLD / READ-ONLY", view.workspace.worldTitle, `Workspace: ${view.workspace.title}`, `Goal: ${view.workspace.goal}`, ""];
  if (!item) return prose([...context, "No base-world documents or descriptors supplied."], width);
  if (showRaw) return raw({ base: view.workspace.base, worldTitle: view.workspace.worldTitle, goal: view.workspace.goal, item }, width);
  return item.kind === "document"
    ? prose([...context, "BASE DOCUMENT / READ-ONLY", item.document.path, `SHA-256: ${documentHash(item.document) ?? "Not supplied"}`, "", item.document.text,
      ...(item.document.truncated ? ["", "[SERVICE EXCERPT TRUNCATED: full document not supplied to this view]"] : []), "", "p: explicitly pin this exact base document; d: raw metadata"], width)
    : prose([...context, "BASE RECORD / READ-ONLY", item.record.title, `Kind: ${item.record.kind}`, "", item.record.summary, "", "Full identifier", item.record.id,
      "", "Only active assertion descriptors can be pinned here. d: raw descriptor"], width);
}
function constraintLines(view: WorkspaceViewV1, index: number, width: number, showRaw: boolean): string[] {
  const pin = view.workspace.pins[index];
  if (showRaw) return raw(pin ?? { direction: view.workspace.direction }, width);
  if (!pin) return prose(["EDITORIAL DIRECTION / ADVISORY", "Not a deterministic constraint and not a hard pin.", "", view.workspace.direction || "No direction supplied.", "", "n: edit advisory direction"], width);
  return prose(["HARD PIN", pinLabel(pin), "", ...(pin.kind === "document" ? [`Document: ${pin.path}`, `Protected SHA-256: ${pin.sha256}`] : [`Protected assertion: ${pin.assertionId}`]),
    `Pin id: ${pin.id}`, "", "p: change protection only after explicit confirmation", "", "ADVISORY DIRECTION (separate from hard protection)", view.workspace.direction || "No direction supplied."], width);
}
function historyLines(view: WorkspaceViewV1, width: number): string[] {
  const lines = ["SAVED WORKSPACE DECISIONS", "History is supplied by the service. Proposal selection is not canon acceptance.", ""];
  for (const entry of view.workspace.history) {
    const action = entry.action;
    lines.push(`WORKSPACE v${entry.version} — ${action.kind}`);
    switch (action.kind) {
      case "decide": lines.push(`Group: ${groupTitle(view, action.groupId)}`, `Decision: ${action.decision}`, ...(action.reason !== undefined ? [`Reason: ${action.reason}`] : [])); break;
      case "select": lines.push("Explicit group selection:", ...action.groupIds.map(id => groupTitle(view, id))); break;
      case "put-proposal": lines.push(`Proposal: ${action.proposal.title}`, `Author: ${action.proposal.author}`, `Rationale: ${action.proposal.rationale}`, "Explicit operations:", JSON.stringify(action.proposal.operations, null, 2)); break;
      case "set-direction": lines.push("ADVISORY direction:", action.text); break;
      case "put-pin": lines.push(pinLabel(action.pin), JSON.stringify(action.pin, null, 2)); break;
      case "add-regency": lines.push("Explicit demo regency template (not generated)", action.title, action.rationale); break;
    }
    lines.push("");
  }
  if (view.workspace.history.length === 0) lines.push("No saved decisions reported.");
  return prose(lines, width);
}

const help = ["KEYBOARD GUIDE", "", "1-5 / Tab / Shift+Tab: Changes, World, Constraints, History, Review", "World o: Economy / o or Esc: return to World. [ ]: categories.",
  "Economy is read-only: no edits, pins, selection, accounting or review. j/k: rows; Enter: full details; Esc: list then World; d: raw payload. Right/Left: inspector/list on wide terminals.",
  "Economy uses captured-base DM declarations; selected proposals excluded, candidate unavailable. No availability totals. Full bindings/citations are in the readable inspector.",
  "World m: map subview / return to World. Reference atlas reads do not mutate or review.",
  "MAP: j/k or Up/Down select semantic features; Enter inspects; Esc returns. [ ] switch reference/physical layers; { } switch service-listed atlases.",
  "Map f: explicit canvas focus; arrows/hjkl move cells; Enter selects or opens a stable mixed-feature chooser. Empty cells never inherit the persistent semantic selection. f/Esc returns to features.",
  "Map is undated captured-base geometry: selected proposals are not shown, political facts are not projected, candidate view unavailable. p never pins a hidden World row.",
  "Up/Down (j/k): move rows; Enter: full readable inspector; Esc: back/cancel",
  "At 100+ columns: Right focuses inspector scroll, Left returns to list. PgUp/PgDn move through the focused list or inspector.", "PgUp/PgDn: scroll prose, diagnostics, history, dialogs or inspector", "Space: select/unselect focused change; review prerequisites explicitly",
  "r: reject with an optional reason, or explicitly restore to undecided", "a: add an explicit write-prose proposal; succession-demo also offers a labelled regency template",
  "e: edit rationale without changing structured operations", "n: advisory direction; p: pin/unpin selected World item or Constraints pin (confirmation)",
  "d: raw secondary inspector; v: navigate to Review; c: build/check combined selection ONLY in Review; ?: help; q / Ctrl+C: quit", "", "TEXT FORMS", "Tab / Shift+Tab: next/previous field; arrows/Home/End: move cursor; PgUp/PgDn: page through text", "Enter: newline in multiline fields; next field in single-line fields",
  "Ctrl+Enter: save; Ctrl+S: save on terminals that cannot distinguish Ctrl+Enter", "Backspace/Delete: remove a grapheme; Ctrl+A: start of buffer", "Ctrl+E: external editor when a host callback is configured; otherwise end of buffer. External edits stay unsaved until Ctrl+Enter/Ctrl+S.", "Paste inserts text; shortcut letters never act while typing.",
  "Esc: cancel editing (no implicit save). A failed save retains the buffer.", "", "SAVE FAILURES", "Esc: return to retained buffer. r: refresh only. Enter/y: explicitly confirm the displayed retry.",
  "Unknown result: identical action, expected version and idempotency key are retained.", "Stale result: refresh only; no automatic retry/merge. Explicit retry submits the displayed original action at the refreshed version, with a new key.",
  "A changed structured proposal blocks stale rationale retry. In that failure dialog, b explicitly loads current structure into the retained rationale form, without saving; inspect then save separately.", "", "COMBINED CANDIDATE REVIEW", "c explicitly calls the service at the displayed workspace version. Navigation never runs checks. Older clients show NOT RUN with an upgrade hint.", "Execution completed is separate from validity: valid, invalid or undetermined. Valid for bounded checks does not mean all history is true.", "Edits make previous receipts stale. Current selected intent is shown separately from receipt effects and provenance.", "Review failures are incomplete, not success. Older responses are discarded and refreshed without resubmission or lost buffers.", "The service validates the bound semantic profile; this editor only displays it. Approval unavailable; canon unchanged. No approval or commit route.", "Plain output has no prompts. Terminal-native foreground/background; no animation or color-only status."];

function formBody(form: EditorForm, height: number, width: number): string[] {
  const field = form.fields[form.focused];
  if (!field) return [];
  const heading = prose([form.title, `Field ${form.focused + 1}/${form.fields.length}: ${field.label}`, form.description, ""], width);
  const contents = wrap(textWithCursor(field.buffer), width);
  const beforeCursor = graphemes(field.buffer.text).slice(0, field.buffer.cursor).join("");
  const cursorLine = heading.length + wrap(beforeCursor + "|", width).length - 1;
  const error = form.error ? prose(["", `CANNOT SAVE: ${form.error}`], width) : [];
  const all = [...heading, ...contents, ...error, "", "Tab/Shift+Tab: fields | Ctrl+Enter or Ctrl+S: save | Esc: cancel"];
  const offset = Math.max(0, (form.error ? heading.length + contents.length + error.length - 1 : cursorLine) - Math.max(1, height - 3));
  return viewport(all, offset, height, width);
}
function modalBody(state: WorkspaceUiState, height: number, width: number, reportLimit?: (limit: number) => void): string[] | null {
  if (state.failureOpen && state.failure) {
    const failure = state.failure;
    const rationaleForm = failure.stale && failure.refreshError === null && state.modal?.kind === "form" && state.modal.purpose === "rationale" ? state.modal : null;
    const currentProposal = rationaleForm ? state.view.workspace.proposals.find(group => group.id === rationaleForm.proposalId) : null;
    const lines = prose([failure.stale ? "STALE SAVE — BUFFER RETAINED" : "SAVE UNCONFIRMED — BUFFER RETAINED", failure.message,
      `Attempt based on v${failure.attempt.expectedVersion}; latest read v${state.view.workspace.version}.`,
      ...(failure.refreshError ? [`Refresh also failed: ${failure.refreshError}`] : ["Latest state fetched. Nothing was merged or resubmitted."]),
      failure.stale ? "Enter/y explicitly retries this ORIGINAL action at the latest version with a new key. It may replace newer authoring data; inspect it below first. Changed structured operations block rationale retry." : "Enter/y retries the IDENTICAL action, expected version and idempotency key. A read alone does not establish whether this operation saved.",
      "Esc returns to your retained buffer without retrying. r refreshes state only.",
            ...(currentProposal ? ["b explicitly loads the CURRENT proposal structure into your retained rationale form, without saving. Review it below first; Ctrl+S saves separately."] : []),
            "", `Idempotency key: ${failure.attempt.key}`, "ORIGINAL OUTGOING ACTION", JSON.stringify(failure.attempt.action, null, 2),
            ...(currentProposal ? ["", "CURRENT PROPOSAL STRUCTURE (b loads this; does not save)", JSON.stringify(currentProposal, null, 2)] : []),
    ], width);
    return viewport(lines, state.scroll, height, width, reportLimit);
  }
  const modal = state.modal;
  if (!modal) return null;
  if (modal.kind === "help") return viewport(prose(help, width), state.scroll, height, width, reportLimit);
  if (modal.kind === "form") return formBody(modal, height, width);
  const options = modal.options.flatMap((option, index) => wrap(`${modal.focused === index ? ">" : " "} ${option.disabled ? "[unavailable] " : ""}${option.label}`, width));
  return [...viewport(prose([modal.title, "", ...modal.lines], width), state.scroll, Math.max(1, height - options.length - 1), width, reportLimit), "", ...options].slice(0, height);
}

function listPane(rows: readonly string[], index: number, title: string, height: number, width: number): string[] {
  const entries = rows.map((row, i) => wrap(`${i === index ? ">" : " "} ${row}`, width));
  const startOfFocus = entries.slice(0, index).reduce((sum, entry) => sum + entry.length, 0);
  const lines = [title, "", ...entries.flat(), ...(rows.length ? [] : ["No items supplied."]), "", "Enter: full readable inspector"];
  const offset = Math.max(0, startOfFocus + 3 - Math.max(1, height - 3));
  return viewport(lines, offset, height, width);
}
function mainBody(state: WorkspaceUiState, height: number, width: number, columns: number, reportLimit?: (limit: number) => void, reportPaint?: (paint: AtlasPaint) => void): string[] {
  const { view, tab, indices } = state;
  if (tab === "World" && state.economy.open) return renderEconomyBody(state, height, width, columns, reportLimit);
  if (tab === "World" && state.atlas.open) return renderAtlasBody(state, height, width, reportLimit, reportPaint);
  let rows: readonly string[] = [];
  let title = "";
  let details: string[];
  const group = view.workspace.proposals[indices.Changes];
  if (tab === "Changes") {
    title = "PROPOSED CHANGES";
    rows = view.workspace.proposals.map(item => `${decisionTag(item)} | ${item.title}`);
    details = group ? state.raw ? raw({ base: view.workspace.base, workspaceId: view.workspace.id, workspaceTitle: view.workspace.title, worldTitle: view.workspace.worldTitle, proposal: group, change: view.changes.find(item => item.groupId === group.id), prerequisites: view.prerequisites.find(item => item.groupId === group.id) }, width) : changeLines(view, group, width) : ["No proposals supplied. a: add an explicit proposal."];
  } else if (tab === "World") {
    title = "BASE WORLD / READ-ONLY | m: map | o: economy";
    rows = worldItems(view).map(item => item.kind === "document" ? `Document | ${item.document.path}` : `${item.record.kind} | ${item.record.title}`);
    details = worldLines(view, indices.World, width, state.raw);
  } else if (tab === "Constraints") {
    title = "PINS / ADVISORY";
    rows = [...view.workspace.pins.map(pinLabel), "ADVISORY direction (not a pin)"];
    details = constraintLines(view, indices.Constraints, width, state.raw);
  } else if (tab === "History") return viewport(state.raw ? raw(view.workspace.history, width) : historyLines(view, width), state.scroll, height, width, reportLimit);
  else return viewport(state.raw ? [...prose([`RAW REVIEW — ${reviewValidationLabel(view, state.reviewFailure)}`, ...(state.reviewFailure ? [`REVIEW FAILED / INCOMPLETE: ${state.reviewFailure}`] : [])], width),
    ...raw({ workspace: { id: view.workspace.id, version: view.workspace.version, base: view.workspace.base }, review: view.review ?? null, selection: view.selection, changes: view.changes, validation: view.validation, approval: view.approval, canon: view.canon }, width)]
    : reviewLines(view, width, state.reviewFailure, state.reviewAvailable), state.scroll, height, width, reportLimit);
  if (state.detail) return viewport(details, state.scroll, height, width, reportLimit);
  if (columns < 100) return listPane(rows, indices[tab], title, height, width);
  const leftWidth = Math.floor((width - 3) * 0.4);
  const rightWidth = width - leftWidth - 3;
  const left = listPane(rows, indices[tab], title, height, leftWidth);
  const rightDetails = tab === "Changes" ? group ? state.raw ? raw(group, rightWidth) : changeLines(view, group, rightWidth) : ["No proposals supplied."]
    : tab === "World" ? worldLines(view, indices.World, rightWidth, state.raw) : constraintLines(view, indices.Constraints, rightWidth, state.raw);
  const right = viewport([state.inspectorFocus ? "INSPECTOR (focused; Left: list)" : "INSPECTOR (Right: scroll)", ...rightDetails], state.scroll, height, rightWidth, reportLimit);
  return Array.from({ length: height }, (_, index) => `${fit(left[index] ?? "", leftWidth)} | ${fit(right[index] ?? "", rightWidth)}`);
}

export function renderWorkspaceScreen(state: WorkspaceUiState, columns: number, rows: number, reportLimit?: (limit: number) => void, reportPaint?: (paint: AtlasPaint) => void): string {
  const width = Math.max(1, Math.floor(columns) - 1);
  if (columns < 80 || rows < 24) return ["WMM / WORKSPACE", "Terminal too small: use 80x24 or larger, or plain output.", `Saved/read workspace v${state.view.workspace.version}; CANON READ-ONLY`, "Input is retained on resize. q quits outside a form; Ctrl+C quits."].slice(0, Math.max(1, rows - 1)).map(line => crop(line, width)).join("\n");
  const { view } = state;
  const height = rows - 11;
  const body = modalBody(state, height, width, reportLimit) ?? mainBody(state, height, width, columns, reportLimit, paint => reportPaint?.({ ...paint, row: paint.row + 5 }));
  const save = state.saveState === "saved" ? `Saved v${view.workspace.version}` : `${state.saveState.toUpperCase()} | read v${view.workspace.version}`;
  const shortcuts = state.failureOpen ? "Enter/y: confirm retry | r: refresh only | Esc: buffer | PgUp/PgDn: details"
    : state.modal?.kind === "form" ? "Enter: newline/next field | Tab: fields | Ctrl+Enter/Ctrl+S: save | Esc: cancel"
    : state.modal?.kind === "choice" ? "Up/Down/Tab: choose | Enter: explicit confirmation | Esc: cancel | PgDn: more"
    : state.modal?.kind === "help" ? "Up/Down/PgUp/PgDn: scroll help | Esc: return"
    : state.tab === "Changes" ? "Space: select | r: reject/restore | a: proposal | e: rationale | v: review"
    : state.tab === "World" && state.economy.open ? "o: World | [ ]: category | Enter: inspect | d: raw | v: review"
    : state.tab === "World" && state.atlas.open ? "m: World | [ ]: layer | { }: atlas | d: raw | v: review"
    : state.tab === "World" ? "m: map | o: economy | p: confirm pin | n: direction | d: raw | v: review"
    : state.tab === "Constraints" ? "p: confirm pin change | n: advisory direction | d: raw | v: review"
    : state.tab === "Review" ? state.reviewAvailable ? "c: build/check combined selection | d: raw receipt | PgUp/PgDn: more" : "c: review unavailable (older client) | d: raw | PgUp/PgDn: more"
    : "PgUp/PgDn: scroll | d: raw | v: review";
  const navigation = state.modal?.kind === "form" || state.failureOpen
    ? state.externalEditorAvailable && !state.failureOpen ? "Ctrl+E: external editor (buffer only) | Esc: cancel | Ctrl+C: quit" : "Input is local until save | Esc: cancel/return | Ctrl+C: quit"
    : state.modal ? "PgUp/PgDn: more | Esc: cancel/return | q/Ctrl+C: quit" : "1-5/Tab: views | Enter: inspect | Esc: back | PgUp/PgDn: more | ?: help | q: quit";
  const output = [ellipsis(`WMM / ${view.workspace.worldTitle}`, width), ellipsis(`Workspace: ${view.workspace.title}`, width),
    `Base ${crop(view.workspace.base.snapshotDigest, 12)} | ${save} | CANON READ-ONLY`,
    tabs.map((tab, index) => `${state.tab === tab ? "[" : " "}${index + 1} ${tab}${state.tab === tab ? "]" : " "}`).join(" "), "-".repeat(width),
    ...Array.from({ length: height }, (_, index) => body[index] ?? ""), "-".repeat(width),
    ellipsis(state.status, width), `Validation: ${reviewValidationLabel(view, state.reviewFailure)} | Approval: ${view.approval} | Canon: ${view.canon}`,
    ellipsis(shortcuts, width), navigation,
  ];
  return output.map(line => crop(line, width)).join("\n");
}

/** Linear, terminal-safe output. No prompts, terminal state changes or implicit reads. */
export function renderWorkspacePlain(view: WorkspaceViewV1): string {
  const width = 100;
  return prose([`WMM / ${view.workspace.worldTitle}`, `Workspace: ${view.workspace.title}`, `Workspace id: ${view.workspace.id}`, `Base world: ${view.workspace.base.worldId}`, `Base snapshot: ${view.workspace.base.snapshotDigest}`,
    `Saved workspace v${view.workspace.version} | CANON READ-ONLY`, `Goal: ${view.workspace.goal}`, "", "CHANGES",
    ...view.workspace.proposals.flatMap(group => [...changeLines(view, group, width), ""]), "", "WORLD / READ-ONLY",
    ...worldItems(view).flatMap((_, index) => [...worldLines(view, index, width, false), ""]), "", "CONSTRAINTS",
    ...view.workspace.pins.flatMap((_, index) => [...constraintLines(view, index, width, false), ""]), ...constraintLines(view, view.workspace.pins.length, width, false), "",
    ...historyLines(view, width), "", ...reviewLines(view, width),
  ], width).join("\n");
}
