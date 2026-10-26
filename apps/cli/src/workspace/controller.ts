import { randomUUID } from "node:crypto";
import type { AtlasPoint, ProposalGroupV1, WorkspaceActionV1, WorkspaceMapView, WorkspacePinV1, WorkspaceViewV1 } from "@wmm/wire-contracts";
import * as atlasCore from "@wmm/core";
import type { WorkspaceClient } from "./client.js";
import { editText, textBuffer } from "./input.js";
import type { TextBuffer, TextEdit } from "./input.js";
import { graphemes } from "./text.js";
import { reviewStatus } from "./review.js";
import { atlasViewError } from "./atlas-view.js";
import { atlasCellPosition, atlasLayout, projectAtlasViewport } from "./atlas-renderer.js";

export const tabs = ["Changes", "World", "Constraints", "History", "Review"] as const;
export type WorkspaceTab = typeof tabs[number];
export interface EditorField {
  readonly name: string;
  readonly label: string;
  readonly multiline: boolean;
  readonly buffer: TextBuffer;
}
export interface EditorForm {
  readonly kind: "form";
  readonly purpose: "prose" | "regency" | "rationale" | "rejection" | "direction";
  readonly title: string;
  readonly description: string;
  readonly fields: readonly EditorField[];
  readonly focused: number;
  readonly baseVersion: number;
  readonly proposal: ProposalGroupV1 | null;
  readonly proposalId: string;
  readonly documents: WorkspaceViewV1["documents"];
  readonly error: string | null;
}
export interface ChoiceDialog {
  readonly kind: "choice";
  readonly title: string;
  readonly lines: readonly string[];
  readonly options: readonly { readonly label: string; readonly action: WorkspaceActionV1 | null; readonly disabled?: boolean }[];
  readonly focused: number;
}
export type WorkspaceModal = EditorForm | ChoiceDialog | { readonly kind: "help" };
export interface SaveAttempt {
  readonly action: WorkspaceActionV1;
  readonly expectedVersion: number;
  readonly key: string;
}
export interface SaveFailure {
  readonly attempt: SaveAttempt;
  readonly stale: boolean;
  readonly message: string;
  readonly refreshError: string | null;
}
export interface WorkspaceUiState {
  readonly view: WorkspaceViewV1;
  readonly atlas: WorkspaceAtlasState;
  readonly tab: WorkspaceTab;
  readonly indices: Readonly<Record<WorkspaceTab, number>>;
  readonly detail: boolean;
  readonly raw: boolean;
  readonly inspectorFocus: boolean;
  readonly scroll: number;
  readonly modal: WorkspaceModal | null;
  readonly failure: SaveFailure | null;
  readonly failureOpen: boolean;
  readonly status: string;
  readonly saveState: "saved" | "saving" | "failed" | "stale";
  readonly quit: boolean;
  readonly externalEditorAvailable: boolean;
  readonly reviewAvailable: boolean;
  readonly reviewFailure: string | null;
}
export interface WorkspaceAtlasState {
  readonly open: boolean;
  readonly view: WorkspaceMapView | null;
  readonly error: string | null;
  readonly selectedFeatureId: string | null;
  readonly layer: "reference" | "physical";
  readonly canvasFocus: boolean;
  readonly cursor: AtlasPoint | null;
  readonly chooser: { readonly featureIds: readonly string[]; readonly focused: number } | null;
}
export interface EditorKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
}

export function documentHash(document: WorkspaceViewV1["documents"][number]): string | null {
  // Fail closed with older gateways; never calculate a canonical hash in the UI.
  const sha = (document as typeof document & { readonly sha256?: string }).sha256;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}
export const groupTitle = (view: WorkspaceViewV1, id: string): string => view.workspace.proposals.find(group => group.id === id)?.title ?? id;
export function worldItems(view: WorkspaceViewV1): readonly ({ readonly kind: "document"; readonly document: WorkspaceViewV1["documents"][number] } | { readonly kind: "record"; readonly record: WorkspaceViewV1["records"][number] })[] {
  return [...view.documents.map(document => ({ kind: "document" as const, document })), ...view.records.map(record => ({ kind: "record" as const, record }))];
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isStale(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const object = error as { code?: unknown; error?: { code?: unknown } };
    if (object.code === "STALE_WORKSPACE" || object.error?.code === "STALE_WORKSPACE") return true;
  }
  return errorMessage(error).includes("STALE_WORKSPACE");
}

/** Transient UI state only. All durable decisions and previews belong to the client. */
export class WorkspaceController {
  private state: WorkspaceUiState;
  private scrollLimit = Number.POSITIVE_INFINITY;
  private editingExternally = false;
  private reviewing = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly client: WorkspaceClient, initial: WorkspaceViewV1, private readonly keyFactory: () => string = randomUUID) {
    this.state = {
      view: initial, tab: "Changes", indices: { Changes: 0, World: 0, Constraints: 0, History: 0, Review: 0 },
      detail: false, raw: false, inspectorFocus: false, scroll: 0, modal: null, failure: null, failureOpen: false,
      status: `Saved workspace v${initial.workspace.version}.`, saveState: "saved", quit: false,
      externalEditorAvailable: typeof client.editText === "function",
      reviewAvailable: typeof client.review === "function", reviewFailure: null,
      atlas: { open: false, view: null, error: null, selectedFeatureId: null, layer: "reference", canvasFocus: false, cursor: null, chooser: null },
    };
  }
  getSnapshot = (): WorkspaceUiState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setScrollLimit(limit: number): void {
    this.scrollLimit = limit;
    if (this.state.scroll > limit) this.update({ scroll: limit });
  }
  private scrollBy(delta: number): void {
    this.update({ scroll: Math.max(0, Math.min(this.scrollLimit, this.state.scroll + delta)) });
  }
  private update(patch: Partial<WorkspaceUiState>): void {
    if (patch.view) {
      const atlas = patch.atlas ?? this.state.atlas;
      const error = atlas.view ? atlasViewError(atlas.view, patch.view.workspace) : null;
      if (error) patch = { ...patch, atlas: { ...atlas, view: null, error, chooser: null } };
    }
    if (patch.modal !== undefined || patch.tab !== undefined || patch.detail !== undefined || patch.failureOpen !== undefined) this.scrollLimit = Number.POSITIVE_INFINITY;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private focusedGroup(): ProposalGroupV1 | undefined {
    return this.state.view.workspace.proposals[this.state.indices.Changes];
  }
  private setTab(tab: WorkspaceTab): void {
    this.update({ tab, detail: false, raw: false, inspectorFocus: false, scroll: 0 });
  }
  private toggleAtlas(): void {
    if (this.state.atlas.open) {
      this.update({ atlas: { ...this.state.atlas, open: false }, detail: false, raw: false, inspectorFocus: false, scroll: 0 });
      return;
    }
    this.readAtlas();
  }
  private readAtlas(options: { readonly atlasId?: string; readonly geometryVersion?: string } = {}): void {
    const read = this.client.readMap?.bind(this.client);
    let view: WorkspaceMapView | null = null;
    let error: string | null = null;
    try {
      if (!read) throw new Error("Map unavailable: older client has no WorkspaceClient.readMap capability.");
      const requested = this.state.view.workspace;
      const response = read({ ...options, atVersion: requested.version });
      error = atlasViewError(response, requested, options) ?? atlasViewError(response, this.state.view.workspace, options);
      if (!error) view = response;
    } catch (failure) { error = `Map unavailable: ${errorMessage(failure)}`; }
    const previous = this.state.atlas;
    const features = [...(view?.atlas?.features ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const retained = previous.view?.atlas?.id === view?.atlas?.id && features.some(item => item.id === previous.selectedFeatureId);
    this.update({ atlas: { ...previous, open: true, view, error, selectedFeatureId: retained ? previous.selectedFeatureId : features[0]?.id ?? null, canvasFocus: false, chooser: null, cursor: retained ? previous.cursor : null }, detail: false, raw: false, inspectorFocus: false, scroll: 0,
      status: error ?? (view?.atlas ? "Read captured-base reference atlas; workspace unchanged." : "No reference atlas in the captured base world."),
    });
  }
  private atlasInput(input: string, key: EditorKey, columns: number, rows: number): boolean {
    const current = this.state.atlas;
    const view = current.view;
    if (current.chooser) {
      const chooser = current.chooser;
      if (key.escape) this.update({ atlas: { ...current, chooser: null }, scroll: 0 });
      else if (key.upArrow || key.downArrow || input === "j" || input === "k") this.update({ atlas: { ...current, chooser: { ...chooser, focused: (chooser.focused + (key.upArrow || input === "k" ? chooser.featureIds.length - 1 : 1)) % chooser.featureIds.length } } });
      else if (key.return) this.update({ atlas: { ...current, chooser: null, selectedFeatureId: chooser.featureIds[chooser.focused] ?? null }, detail: true, raw: false, inspectorFocus: true, scroll: 0 });
      else if (key.pageUp || key.pageDown) this.scrollBy(key.pageDown ? 8 : -8);
      return true;
    }
    if (input === "a" || input === "n") return false; // Preserve existing explicit forms.
    if (key.escape) {
      if (this.state.detail || this.state.inspectorFocus) this.update({ detail: false, raw: false, inspectorFocus: false, scroll: 0 });
      else if (current.canvasFocus) this.update({ atlas: { ...current, canvasFocus: false }, scroll: 0 });
      else this.toggleAtlas();
    } else if (input === "f" && view?.atlas) {
      const extent = view.atlas.frame.extent;
      this.update({ atlas: { ...current, canvasFocus: !current.canvasFocus, cursor: current.cursor ?? [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2] }, detail: false, raw: false, inspectorFocus: false, scroll: 0 });
    } else if (current.canvasFocus && !this.state.detail && !this.state.inspectorFocus && this.canvasInput(input, key, columns, rows)) {
      return true;
    } else if (input === "p") this.update({ status: "Map is read-only. No hidden World row can be pinned; m returns to World." });
    else if ((input === "{" || input === "}") && view?.atlas) {
      const catalog = [...view.availableAtlases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const index = catalog.findIndex(item => item.id === view.atlas!.id);
      const next = catalog[(index + (input === "{" ? catalog.length - 1 : 1)) % catalog.length];
      if (next && catalog.length > 1) this.readAtlas({ atlasId: next.id, geometryVersion: next.geometryVersion });
    } else if (input === "[" || input === "]") this.update({ atlas: { ...current, layer: current.layer === "reference" ? "physical" : "reference" } });
    else if (input === "d") this.update({ raw: !this.state.raw, detail: true, inspectorFocus: true, scroll: 0 });
    else if (key.return) this.update({ detail: !this.state.detail, raw: false, inspectorFocus: !this.state.detail, scroll: 0 });
    else if (key.leftArrow) this.update({ detail: false, inspectorFocus: false, scroll: 0 });
    else if (key.rightArrow) this.update({ detail: columns < 100 || this.state.detail, inspectorFocus: true });
    else if (key.pageUp || key.pageDown || key.upArrow || key.downArrow || input === "j" || input === "k") {
      const direction = key.upArrow || key.pageUp || input === "k" ? -1 : 1;
      const delta = direction * (key.pageUp || key.pageDown ? 8 : 1);
      if (this.state.detail || this.state.inspectorFocus || !view?.atlas) this.scrollBy(delta);
      else {
        const features = [...view.atlas.features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const index = features.findIndex(item => item.id === current.selectedFeatureId);
        const feature = features[Math.max(0, Math.min(features.length - 1, index + delta))];
        this.update({ atlas: { ...current, selectedFeatureId: feature?.id ?? null }, scroll: 0 });
      }
    }
    return true;
  }
  private canvasInput(input: string, key: EditorKey, columns: number, rows: number): boolean {
    if (!key.return && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.home && !key.end && !["j", "k", "h", "l"].includes(input)) return false;
    const current = this.state.atlas;
    const atlas = current.view?.atlas;
    if (!atlas || !current.cursor) return true;
    try {
      const layout = atlasLayout(Math.max(1, columns - 1), Math.max(1, rows - 11));
      const grid = projectAtlasViewport(atlas, Math.min(160, layout.mapWidth), layout.mapRows);
      let [x, y] = atlasCellPosition(grid, current.cursor);
      if (key.return) {
        const cell = grid.cells[y]![x]!;
        const choice = atlasCore.selectAtlasCell(cell, current.selectedFeatureId);
        if (choice.kind === "choose") this.update({ atlas: { ...current, chooser: { featureIds: choice.featureIds, focused: 0 } }, scroll: 0 });
        else if (choice.kind === "selected") this.update({ atlas: { ...current, selectedFeatureId: choice.featureId }, detail: true, raw: false, inspectorFocus: true, scroll: 0 });
        else this.update({ status: `Empty cell: ${cell.surfaces.join(" / ")}. Persistent semantic selection is separate; no feature occupies this cell.` });
        return true;
      }
      if (key.home) { x = 0; y = 0; }
      else if (key.end) { x = grid.columns - 1; y = grid.rows - 1; }
      else {
        x = Math.max(0, Math.min(grid.columns - 1, x + (key.leftArrow || input === "h" ? -1 : key.rightArrow || input === "l" ? 1 : 0)));
        y = Math.max(0, Math.min(grid.rows - 1, y + (key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : 0)));
      }
      const cell = grid.cells[y]![x]!;
      this.update({ atlas: { ...current, cursor: [(cell.bounds[0] + cell.bounds[2]) / 2, (cell.bounds[1] + cell.bounds[3]) / 2] }, scroll: 0 });
    } catch (failure) { this.update({ status: `Map cell unavailable: ${errorMessage(failure)}. No workspace changes.` }); }
    return true;
  }
  private itemCount(): number {
    const { view, tab } = this.state;
    if (tab === "Changes") return view.workspace.proposals.length;
    if (tab === "World") return worldItems(view).length;
    if (tab === "Constraints") return view.workspace.pins.length + 1;
    return 0;
  }
  private form(purpose: EditorForm["purpose"], title: string, description: string, fields: readonly [string, string, string, boolean][], proposal: ProposalGroupV1 | null = null): void {
    this.update({ modal: {
      kind: "form", purpose, title, description, fields: fields.map(([name, label, text, multiline]) => ({ name, label, buffer: textBuffer(text), multiline })),
      focused: 0, baseVersion: this.state.view.workspace.version, proposal, proposalId: proposal?.id ?? this.keyFactory(), documents: this.state.view.documents, error: null,
    }, scroll: 0 });
  }
  private choose(title: string, lines: readonly string[], options: ChoiceDialog["options"]): void {
    this.update({ modal: { kind: "choice", title, lines, options, focused: 0 }, scroll: 0 });
  }
  private selectGroup(): void {
    const group = this.focusedGroup();
    if (!group) return;
    if (group.decision === "rejected") { this.update({ status: "Rejected: use r to explicitly restore to undecided before selecting." }); return; }
    if (group.decision === "selected") { this.submit({ kind: "decide", groupId: group.id, decision: "undecided" }); return; }
    const prerequisites = this.state.view.prerequisites.find(item => item.groupId === group.id);
    if (!prerequisites) { this.update({ status: "Prerequisite data unavailable. Refresh from the service before selecting." }); return; }
    if (prerequisites.missing.length || prerequisites.rejected.length) {
      // select replaces the full set; including prerequisites must retain other author decisions.
      const selectedIds = this.state.view.workspace.proposals.filter(item => item.decision === "selected").map(item => item.id);
      const includedIds = [...new Set([...selectedIds, group.id, ...prerequisites.required])];
      this.choose("REVIEW PREREQUISITES", [group.title, "Service-supplied prerequisites (not historical validation):", "Existing selected groups will be retained.",
        ...prerequisites.required.map(id => `${prerequisites.rejected.includes(id) ? "REJECTED" : prerequisites.missing.includes(id) ? "MISSING" : "REQUIRED"}: ${groupTitle(this.state.view, id)}`),
        ...(prerequisites.rejected.length ? ["Restore rejected prerequisites individually with r. No rejected group will be revived here."] : []),
      ], [
        { label: "Cancel; change nothing", action: null },
        { label: "Select this group alone; leave unresolved prerequisites visible", action: { kind: "decide", groupId: group.id, decision: "selected" } },
        { label: "Explicitly include this group and all displayed prerequisites", action: { kind: "select", groupIds: includedIds }, disabled: prerequisites.rejected.length > 0 },
      ]);
    } else this.submit({ kind: "decide", groupId: group.id, decision: "selected" });
  }
  private rejectOrRestore(): void {
    const group = this.focusedGroup();
    if (!group) return;
    if (group.decision === "rejected") {
      this.choose("RESTORE TO UNDECIDED?", [group.title, `Rejection reason: ${group.rejectionReason ?? "Not supplied"}`, "Restoration does not select the group. Earlier decisions remain in service history."], [
        { label: "Cancel", action: null },
        { label: "Restore to undecided", action: { kind: "decide", groupId: group.id, decision: "undecided" } },
      ]);
    } else this.form("rejection", "REJECT PROPOSAL", group.title, [["reason", "Rejection reason (optional)", "", true]], group);
  }
  private addAlternative(): void {
    if (this.state.view.workspace.mode === "succession-demo") {
      this.choose("ADD AN EXPLICIT ALTERNATIVE", ["No narrative inference or generation. New proposals start undecided.", "The regency template is supported only by the succession-demo service."], [
        { label: "Cancel", action: null },
        { label: "Use labelled demo regency template", action: null },
        { label: "Write an explicit prose document proposal", action: null },
      ]);
    } else this.proseForm();
  }
  private proseForm(): void {
    this.form("prose", "EXPLICIT WRITE-PROSE PROPOSAL", "This saves a draft operation, not canon. An existing path uses its service-supplied base hash; a new path uses null. No text is interpreted as claims.", [
      ["path", "Document path (exact, relative path)", "", false], ["title", "Proposal title", "", false],
      ["rationale", "Rationale", "", true], ["body", "Proposed document body", "", true],
    ]);
  }
  private pin(): void {
    const { view, tab, indices } = this.state;
    let pin: WorkspacePinV1 | undefined;
    if (tab === "Constraints") {
      const existing = view.workspace.pins[indices.Constraints];
      if (existing) pin = { ...existing, active: !existing.active };
    } else if (tab === "World") {
      const item = worldItems(view)[indices.World];
      if (item?.kind === "document") {
        const sha = documentHash(item.document);
        if (!sha) { this.update({ status: "Cannot pin: service did not supply this document's SHA-256." }); return; }
        const existing = view.workspace.pins.find(candidate => candidate.kind === "document" && candidate.path === item.document.path);
        pin = existing ? { ...existing, active: !existing.active } : { id: this.keyFactory(), kind: "document", path: item.document.path, sha256: sha, active: true };
      } else if (item?.kind === "record" && item.record.kind === "active assertion") {
        const existing = view.workspace.pins.find(candidate => candidate.kind === "assertion" && candidate.assertionId === item.record.id);
        pin = existing ? { ...existing, active: !existing.active } : { id: this.keyFactory(), kind: "assertion", assertionId: item.record.id, active: true };
      }
    }
    if (!pin) { this.update({ status: "Choose an existing pin in Constraints, or a document/active assertion in World, then p." }); return; }
    this.choose(pin.active ? "ADD HARD PROTECTION?" : "REMOVE HARD PROTECTION?", [
      "A hard pin is not advisory direction. Confirm the precise service protection below.",
      ...(pin.kind === "document" ? [`Document: ${pin.path}`, `SHA-256: ${pin.sha256}`] : [`Assertion: ${pin.assertionId}`]),
      `Pin id: ${pin.id}`, `New state: ${pin.active ? "ACTIVE" : "INACTIVE"}`,
    ], [{ label: "Cancel", action: null }, { label: pin.active ? "Confirm protection" : "Confirm removal of protection", action: { kind: "put-pin", pin } }]);
  }
  private formAction(form: EditorForm): WorkspaceActionV1 {
    const value = (name: string): string => form.fields.find(field => field.name === name)?.buffer.text ?? "";
    switch (form.purpose) {
      case "direction": return { kind: "set-direction", text: value("direction") };
      case "rejection": return { kind: "decide", groupId: form.proposalId, decision: "rejected", reason: value("reason") };
      case "regency": {
        if (!value("title").trim()) throw new Error("A title is required.");
        return { kind: "add-regency", title: value("title"), rationale: value("rationale") };
      }
      case "rationale": {
        const original = form.proposal;
        if (!original) throw new Error("The original proposal is unavailable.");
        return { kind: "put-proposal", proposal: {
          id: original.id, title: original.title, author: original.author, rationale: value("rationale"),
          dependencies: original.dependencies, exclusions: original.exclusions, operations: original.operations,
        } };
      }
      case "prose": {
        const path = value("path");
        if (!path.trim() || !value("title").trim()) throw new Error("A document path and title are required.");
        const document = form.documents.find(item => item.path === path);
        const sha = document ? documentHash(document) : null;
        if (document && !sha) throw new Error("The service must supply this existing document's SHA-256 before it can be proposed for replacement.");
        return { kind: "put-proposal", proposal: {
          id: form.proposalId, title: value("title"), rationale: value("rationale"), author: "Human", dependencies: [], exclusions: [],
          operations: [{ kind: "write-prose", path, text: value("body"), beforeSha256: sha }],
        } };
      }
    }
  }
  private submit(action: WorkspaceActionV1, expectedVersion = this.state.view.workspace.version, explicitAttempt?: SaveAttempt): void {
    const previous = this.state.failure?.attempt;
    if (!explicitAttempt && previous && JSON.stringify(previous.action) === JSON.stringify(action)) {
      this.update({ failureOpen: true, scroll: 0 });
      return;
    }
    const attempt = explicitAttempt ?? { action, expectedVersion, key: this.keyFactory() };
    this.update({ saveState: "saving", status: `Saving against v${attempt.expectedVersion}...` });
    try {
      const view = this.client.mutate(attempt.action, attempt.expectedVersion, attempt.key);
      this.update({ view, saveState: "saved", status: `Saved workspace v${view.workspace.version}.`, modal: null, failure: null, failureOpen: false, reviewFailure: null, scroll: 0 });
    } catch (error) {
      let view = this.state.view;
      let refreshError: string | null = null;
      try { view = this.client.read(); } catch (refresh) { refreshError = errorMessage(refresh); }
      const stale = isStale(error);
      this.update({ view, saveState: stale ? "stale" : "failed", failureOpen: true, scroll: 0,
        status: stale ? "Stale save. Input retained; no resubmission or merge." : "Save unconfirmed. Input and original retry key retained.",
        failure: { attempt, stale, message: errorMessage(error), refreshError },
      });
    }
  }
  private checkCombinedSelection(): void {
    if (this.reviewing) return;
    const review = this.client.review?.bind(this.client);
    if (!review) {
      this.update({ status: "Review NOT RUN: this older client has no review route. Use a gateway supporting WorkspaceClient.review." });
      return;
    }
    const requested = this.state.view.workspace;
    this.reviewing = true;
    this.update({ status: `Building/checking combined selection at workspace v${requested.version}...` });
    try {
      const view = review(requested.version);
      const current = this.state.view.workspace;
      if (view.workspace.id !== current.id || view.workspace.version < Math.max(requested.version, current.version) ||
        view.workspace.base.worldId !== current.base.worldId || view.workspace.base.snapshotDigest !== current.base.snapshotDigest) {
        this.discardReviewAndRefresh("Older or mismatched review view discarded.");
        return;
      }
      if (reviewStatus(view) !== "current") {
        this.update({ reviewFailure: "The service returned no current, matching receipt. No completed result for this attempt.",
          status: "Review FAILED / INCOMPLETE: no current matching receipt. Workspace and input unchanged." });
        return;
      }
      this.update({ view, reviewFailure: null, scroll: 0,
        status: `Review execution completed for workspace v${view.workspace.version}; validity: ${view.review!.validity} (service).` });
    } catch (error) {
      this.update({ reviewFailure: errorMessage(error),
        status: `Review FAILED / INCOMPLETE: ${errorMessage(error)}. Workspace and input unchanged.` });
    } finally {
      this.reviewing = false;
    }
  }
  private discardReviewAndRefresh(message: string): void {
    let detail = `${message} No resubmission; input retained.`;
    try {
      const view = this.client.read();
      const current = this.state.view.workspace;
      if (view.workspace.id === current.id && view.workspace.version >= current.version &&
        view.workspace.base.worldId === current.base.worldId && view.workspace.base.snapshotDigest === current.base.snapshotDigest) {
        this.update({ view });
        detail += ` Refreshed workspace v${view.workspace.version}.`;
      } else detail += " Refresh was also older or mismatched and was discarded.";
    } catch (error) { detail += ` Refresh failed: ${errorMessage(error)}.`; }
    this.update({ reviewFailure: detail, status: `Review FAILED / INCOMPLETE: ${detail}` });
  }
  private refreshAfterFailure(): void {
      const failure = this.state.failure;
      if (!failure) return;
      try {
        const view = this.client.read();
        this.update({ view, failure: { ...failure, refreshError: null }, status: `Read workspace v${view.workspace.version}; input retained, no retry performed.` });
      } catch (error) {
        this.update({ failure: { ...failure, refreshError: errorMessage(error) }, status: "Refresh failed; original input and attempt retained." });
      }
    }
    private loadCurrentRationaleForm(): void {
    const { failure, modal, view } = this.state;
    if (!failure?.stale || failure.refreshError !== null || modal?.kind !== "form" || modal.purpose !== "rationale") return;
    const proposal = view.workspace.proposals.find(group => group.id === modal.proposalId);
    if (!proposal) return;
    this.update({ modal: { ...modal, proposal, baseVersion: view.workspace.version, error: null }, failure: null, failureOpen: false, saveState: "saved", scroll: 0,
      status: "Current structure explicitly loaded; your rationale is retained but NOT SAVED. Ctrl+S saves separately." });
  }
  private retry(): void {
    const failure = this.state.failure;
    if (!failure) return;
    if (failure.stale && failure.refreshError !== null) {
      this.update({ status: "Latest version is unavailable. Esc returns to your buffer; refresh before retrying." });
      return;
    }
    const attempt = failure.stale
      ? { ...failure.attempt, expectedVersion: this.state.view.workspace.version, key: this.keyFactory() }
      : failure.attempt;
    // A stale proposal revision may contain newer executable operations. Never replace those
    // merely because the author was editing explanatory rationale.
    const form = this.state.modal;
    if (failure.stale && form?.kind === "form" && form.purpose === "rationale") {
      const current = this.state.view.workspace.proposals.find(group => group.id === form.proposalId);
      if (!current || JSON.stringify(current.operations) !== JSON.stringify(form.proposal?.operations) ||
        JSON.stringify(current.dependencies) !== JSON.stringify(form.proposal?.dependencies) ||
        JSON.stringify(current.exclusions) !== JSON.stringify(form.proposal?.exclusions) ||
        current.title !== form.proposal?.title || current.author !== form.proposal?.author) {
        this.update({ status: "Proposal structure changed; retry blocked. b explicitly loads current structure, retaining your rationale without saving." });
        return;
      }
    }
    this.submit(attempt.action, attempt.expectedVersion, attempt);
  }
  async editExternally(suspendTerminal: (callback: () => void) => Promise<void>): Promise<void> {
    const form = this.state.modal;
    const edit = this.client.editText?.bind(this.client);
    if (!edit || form?.kind !== "form" || this.state.failureOpen || this.state.quit || this.editingExternally || this.state.saveState === "saving") return;
    const field = form.fields[form.focused];
    if (!field) return;
    this.editingExternally = true;
    this.update({ status: "Opening host editor; the field remains unsaved." });
    try {
      let result: unknown;
      // Ink's callback API restores terminal ownership in finally, including on host failure.
      await suspendTerminal(() => { result = edit(field.buffer.text); });
      if (typeof result !== "string") throw new Error("The host editor did not return text.");
      if (this.state.quit || this.state.modal !== form) return;
      const text = field.multiline ? result : result.replace(/\r\n?|\n/g, " ");
      this.update({ modal: { ...form, error: null, fields: form.fields.map((item, index) => index === form.focused ? { ...item, buffer: textBuffer(text) } : item) },
        status: "Host editor returned; buffer updated but NOT SAVED. Ctrl+Enter/Ctrl+S saves separately." });
    } catch (error) {
      if (!this.state.quit && this.state.modal === form) {
        this.update({ modal: { ...form, error: `External editor failed: ${errorMessage(error)}. Original input retained.` },
          status: "External editor failed; original input and cursor retained. Nothing saved." });
      }
    } finally {
      this.editingExternally = false;
    }
  }
  paste(text: string): void {
    if (this.state.failureOpen || this.editingExternally) return;
    const modal = this.state.modal;
    if (modal?.kind !== "form") return;
    this.editField({ kind: "insert", text });
  }
  private editField(action: TextEdit): void {
    const form = this.state.modal;
    if (form?.kind !== "form") return;
    const field = form.fields[form.focused];
    if (!field) return;
    const edit = action.kind === "insert" && !field.multiline ? { ...action, text: action.text.replace(/\r\n?|\n/g, " ") } : action;
    this.update({ modal: { ...form, error: null, fields: form.fields.map((item, index) => index === form.focused ? { ...item, buffer: editText(item.buffer, edit) } : item) } });
  }
  input(input: string, key: EditorKey = {}, columns = 80, rows = 24): void {
    if (this.state.quit || this.state.saveState === "saving" || this.editingExternally) return;
    if (key.ctrl && input === "c") { this.update({ quit: true }); return; }
    if (input === "q" && !key.ctrl && !key.meta && this.state.modal?.kind !== "form") { this.update({ quit: true }); return; }
    if (this.state.failureOpen) {
      if (key.escape) this.update({ failureOpen: false, scroll: 0 });
      else if (key.return || input === "y") this.retry();
      else if (input === "r") this.refreshAfterFailure();
      else if (input === "b") this.loadCurrentRationaleForm();
      else if (key.pageDown || key.downArrow) this.scrollBy(key.pageDown ? 8 : 1);
      else if (key.pageUp || key.upArrow) this.scrollBy(key.pageUp ? -8 : -1);
      return;
    }
    const modal = this.state.modal;
    if (modal?.kind === "form") {
      if (key.escape) { this.update({ modal: null, scroll: 0, status: "Editing cancelled; nothing saved." }); return; }
      if ((key.ctrl && key.return) || (key.ctrl && input === "s")) {
        try { this.submit(this.formAction(modal), modal.baseVersion); }
        catch (error) { this.update({ status: errorMessage(error), modal: { ...modal, error: errorMessage(error) } }); }
        return;
      }
      if (key.pageUp || key.pageDown) {
              const field = modal.fields[modal.focused];
              if (field) {
                const length = graphemes(field.buffer.text).length;
                const cursor = Math.max(0, Math.min(length, field.buffer.cursor + (key.pageDown ? 1 : -1) * Math.max(1, columns - 1) * 8));
                this.update({ modal: { ...modal, error: null, fields: modal.fields.map((item, index) => index === modal.focused ? { ...item, buffer: { ...item.buffer, cursor, preferredColumn: null } } : item) } });
              }
              return;
            }
            if (key.tab) { this.update({ modal: { ...modal, error: null, focused: (modal.focused + (key.shift ? modal.fields.length - 1 : 1)) % modal.fields.length }, scroll: 0 }); return; }
      if (key.return) {
        if (modal.fields[modal.focused]?.multiline) this.editField({ kind: "insert", text: "\n" });
        else this.update({ modal: { ...modal, focused: (modal.focused + 1) % modal.fields.length } });
        return;
      }
      const movement: TextEdit["kind"] | undefined = key.leftArrow ? "left" : key.rightArrow ? "right" : key.upArrow ? "up" : key.downArrow ? "down" : key.home ? "home" : key.end ? "end" : key.backspace ? "backspace" : key.delete ? "delete" : key.ctrl && input === "a" ? "start" : key.ctrl && input === "e" ? "finish" : undefined;
      if (movement) this.editField({ kind: movement });
      else if (input && !key.ctrl && !key.meta) this.editField({ kind: "insert", text: input });
      return;
    }
    if (modal?.kind === "choice") {
      if (key.escape) { this.update({ modal: null, scroll: 0 }); return; }
      if (key.upArrow || key.downArrow || key.tab) {
        const backwards = key.upArrow || (key.tab && key.shift);
        this.update({ modal: { ...modal, focused: (modal.focused + (backwards ? modal.options.length - 1 : 1)) % modal.options.length } }); return;
      }
      if (key.pageDown || key.pageUp) { this.scrollBy(key.pageDown ? 8 : -8); return; }
      if (key.return) {
        const option = modal.options[modal.focused];
        if (!option || option.disabled) { this.update({ status: "Unavailable: restore rejected prerequisites explicitly first." }); return; }
        if (modal.title === "ADD AN EXPLICIT ALTERNATIVE" && modal.focused === 1) {
          this.form("regency", "DEMO REGENCY TEMPLATE — NOT GENERATED", "Explicit succession-demo add-regency action. The service defines the operations; the new proposal starts undecided.", [
            ["title", "Title", "Negotiate a regency", false], ["rationale", "Rationale", "", true],
          ]);
        } else if (modal.title === "ADD AN EXPLICIT ALTERNATIVE" && modal.focused === 2) this.proseForm();
        else if (option.action) this.submit(option.action);
        else this.update({ modal: null, scroll: 0 });
      }
      return;
    }
    if (modal?.kind === "help") {
      if (key.escape || input === "?") this.update({ modal: null, scroll: 0 });
      else if (key.pageDown || key.downArrow) this.scrollBy(key.pageDown ? 8 : 1);
      else if (key.pageUp || key.upArrow) this.scrollBy(key.pageUp ? -8 : -1);
      return;
    }
    // Multi-character input is paste, never a sequence of global shortcuts.
    if (key.ctrl || key.meta || (input.length > 1 && !key.return && !key.tab)) return;
    if (input === "m" && this.state.tab === "World") { this.toggleAtlas(); return; }
    if (input === "?") { this.update({ modal: { kind: "help" }, scroll: 0 }); return; }
    if (/^[1-5]$/.test(input)) { this.setTab(tabs[Number(input) - 1] ?? "Changes"); return; }
    if (key.tab) { this.setTab(tabs[(tabs.indexOf(this.state.tab) + (key.shift ? 4 : 1)) % tabs.length] ?? "Changes"); return; }
    if (input === "v") { this.setTab("Review"); return; }
    if (this.state.tab === "World" && this.state.atlas.open && this.atlasInput(input, key, columns, rows)) return;
    if (key.escape) { this.update({ detail: false, raw: false, inspectorFocus: false, scroll: 0 }); return; }
    if (input === "c" && this.state.tab === "Review") { this.checkCombinedSelection(); return; }
    if (key.pageDown || key.pageUp) {
      const delta = key.pageDown ? 8 : -8;
      if (!this.state.detail && !this.state.inspectorFocus && this.itemCount() > 0) {
        this.update({ indices: { ...this.state.indices, [this.state.tab]: Math.max(0, Math.min(this.itemCount() - 1, this.state.indices[this.state.tab] + delta)) }, scroll: 0 });
      } else this.scrollBy(delta);
      return;
    }
    if (key.return) { this.update({ detail: !this.state.detail, inspectorFocus: !this.state.detail, scroll: 0 }); return; }
    if (key.rightArrow) { this.update({ inspectorFocus: true, detail: columns < 100 || this.state.detail }); return; }
    if (key.leftArrow) { this.update({ inspectorFocus: false, detail: false }); return; }
    if (key.upArrow || key.downArrow || input === "j" || input === "k") {
      const direction = key.upArrow || input === "k" ? -1 : 1;
      if (this.state.detail || this.state.inspectorFocus || this.itemCount() === 0) this.scrollBy(direction);
      else this.update({ indices: { ...this.state.indices, [this.state.tab]: Math.max(0, Math.min(this.itemCount() - 1, this.state.indices[this.state.tab] + direction)) }, scroll: 0 });
      return;
    }
    if (input === "d") { this.update({ raw: !this.state.raw, detail: true, inspectorFocus: true, scroll: 0 }); return; }
    if (input === " " && this.state.tab === "Changes") this.selectGroup();
    else if (input === "r" && this.state.tab === "Changes") this.rejectOrRestore();
    else if (input === "a") this.addAlternative();
    else if (input === "e" && this.state.tab === "Changes") {
      const group = this.focusedGroup();
      if (group) this.form("rationale", "EDIT RATIONALE ONLY", "Structured operations, title, authorship, dependencies and exclusions are preserved exactly.", [["rationale", "Rationale", group.rationale, true]], group);
    } else if (input === "n") this.form("direction", "ADVISORY DIRECTION", "This prose is advisory, not an executable rule or a hard pin.", [["direction", "Direction", this.state.view.workspace.direction, true]]);
    else if (input === "p") this.pin();
  }
}
