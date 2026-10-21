import { describe, expect, it, vi } from "vitest";
import type { WorkspaceViewV1 } from "@wmm/wire-contracts";
import { WorkspaceController } from "../src/workspace/controller.js";
import { editText, textBuffer } from "../src/workspace/input.js";
import { renderWorkspacePlain, renderWorkspaceScreen } from "../src/workspace/presentation.js";
import { cells, terminalText, viewport, wrap } from "../src/workspace/text.js";

function fixture(): WorkspaceViewV1 {
  const document = { path: "prose/council.md", text: "The council advises the sovereign.\n中立 👩🏽‍💻", truncated: false, sha256: "a".repeat(64) };
  return {
    format: "wmm.workspace-view/1",
    workspace: { format: "wmm.workspace/1", id: "workspace-id", version: 7, title: "Succession deliberations", worldTitle: "Valen", goal: "Preserve a peaceful succession", mode: "world",
      base: { worldId: "world-id", snapshotDigest: "b".repeat(64) }, direction: "Avoid another war (advisory).", history: [],
      pins: [{ id: "neutral", kind: "document", path: document.path, sha256: document.sha256, active: true }],
      proposals: [{ id: "council", version: 2, title: "Establish an interim council", author: "Author", rationale: "Preserve continuity.", dependencies: ["absent"], exclusions: [],
        operations: [{ kind: "write-prose", path: document.path, text: "A council governs temporarily.", beforeSha256: document.sha256 }], decision: "undecided", rejectionReason: null }],
    },
    records: [{ id: "neutrality", kind: "active assertion", title: "Neighboring neutrality", summary: "Neutrality is an explicit base assertion." }], documents: [document],
    changes: [{ groupId: "council", representation: "explicit-prose", before: ["The service's original before text."], proposed: ["The service's exact proposed text."] }],
    // Deliberately differs from proposal.dependencies: the UI must trust this read model.
    prerequisites: [{ groupId: "council", required: [], missing: [], rejected: [] }],
    selection: { requested: [], required: [], missing: [], rejectedRequired: [], diagnostics: [] },
    validation: { status: "not-run", message: "Historical validation is not implemented." }, approval: "unavailable", canon: "unchanged",
  };
}
function controller(view = fixture()): WorkspaceController {
  return new WorkspaceController({ read: () => view, mutate: vi.fn(() => view) }, view);
}

describe("workspace presentation", () => {
  it.each([[80, 24], [100, 30], [120, 36]])("bounds every line at %ix%i with a persistent, non-authoritative frame", (columns, rows) => {
    const screen = renderWorkspaceScreen(controller().getSnapshot(), columns, rows);
    expect(screen.split("\n")).toHaveLength(rows - 1);
    expect(screen.split("\n").every(line => cells(line) < columns)).toBe(true);
    expect(screen).toContain("Valen");
    expect(screen).toContain("Succession deliberations");
    expect(screen).toContain("Saved v7");
    expect(screen).toContain("CANON READ-ONLY");
    expect(screen).toContain("NOT RUN");
    expect(screen).toContain("Approval: unavailable");
    expect(screen).toContain("Canon: unchanged");
    expect(screen.includes("INSPECTOR")).toBe(columns >= 100);
    expect(screen).not.toContain("historically valid");
  });

  it("opens a full readable inspector at 80 columns, with before/proposed from the service", () => {
    const ui = controller();
    ui.input("", { return: true });
    const screen = renderWorkspaceScreen(ui.getSnapshot(), 80, 24);
    expect(screen).toContain("The service's original before text.");
    expect(screen).toContain("The service's exact proposed text.");
    expect(screen).toContain("[More:");
    expect(screen).not.toContain("A council governs temporarily.");
    ui.input("d");
    expect(renderWorkspaceScreen(ui.getSnapshot(), 80, 24)).toContain("\"base\"");
    ui.input("", { escape: true });
    expect(ui.getSnapshot().indices.Changes).toBe(0);
  });

  it("keeps long Unicode titles fully readable through the inspector rather than truncating the source", () => {
    const base = fixture();
    const title = "名".repeat(500) + "\nTITLE-END";
    const view: WorkspaceViewV1 = { ...base, workspace: { ...base.workspace, proposals: base.workspace.proposals.map(group => ({ ...group, title })) } };
    const ui = controller(view);
    ui.input("", { return: true }); ui.input("", { pageDown: true });
    const screen = renderWorkspaceScreen(ui.getSnapshot(), 80, 24);
    expect(screen).toContain("TITLE-END");
    expect(screen.split("\n").every(line => cells(line) < 80)).toBe(true);
  });

  it("has a bounded small-terminal state and retains the editor buffer across sizes", () => {
    const ui = controller();
    ui.input("n");
    ui.paste("\nLonger direction 👩🏽‍💻");
    const before = ui.getSnapshot().modal;
    for (const [columns, rows] of [[40, 12], [79, 24], [80, 24], [120, 36]]) {
      const screen = renderWorkspaceScreen(ui.getSnapshot(), columns ?? 80, rows ?? 24);
      expect(screen.split("\n").every(line => cells(line) < (columns ?? 80))).toBe(true);
    }
    expect(ui.getSnapshot().modal).toBe(before);
    expect(renderWorkspaceScreen(ui.getSnapshot(), 40, 12)).toContain("Terminal too small");
    expect(renderWorkspaceScreen(ui.getSnapshot(), 80, 24)).toContain("Longer direction");
  });

  it("scrolls to the end of arbitrarily long diagnostics, prose, history and rows", () => {
    const base = fixture();
    const view: WorkspaceViewV1 = { ...base, selection: { ...base.selection, diagnostics: [{ code: "LONG", groupIds: ["council"], message: "diagnostic ".repeat(100) + "\nDIAGNOSTIC-END" }] },
      workspace: { ...base.workspace, history: [{ version: 7, action: { kind: "set-direction", text: "historical prose ".repeat(100) + "\nHISTORY-END" } }] },
      documents: base.documents.map(document => ({ ...document, text: "source prose ".repeat(100) + "\nDOCUMENT-END" })),
    };
    const ui = controller(view);
    ui.input("v");
    let review = "";
    for (let i = 0; i < 100; i++) { review += renderWorkspaceScreen(ui.getSnapshot(), 80, 24); ui.input("", { pageDown: true }); }
    expect(review).toContain("DIAGNOSTIC-END");
    ui.input("4");
    ui.input("", { pageDown: true });
    expect(renderWorkspaceScreen(ui.getSnapshot(), 80, 24)).toContain("[More:");
    for (let i = 0; i < 50; i++) ui.input("", { pageDown: true });
    expect(renderWorkspaceScreen(ui.getSnapshot(), 80, 24)).toContain("HISTORY-END");
    ui.input("2"); ui.input("", { return: true });
    for (let i = 0; i < 50; i++) ui.input("", { pageDown: true });
    expect(renderWorkspaceScreen(ui.getSnapshot(), 80, 24)).toContain("DOCUMENT-END");
    const many: WorkspaceViewV1 = { ...base, workspace: { ...base.workspace, proposals: Array.from({ length: 60 }, (_, index) => ({ ...base.workspace.proposals[0]!, id: `g${index}`, title: `Proposal ${index}` })) } };
    const list = controller(many);
    for (let i = 0; i < 59; i++) list.input("", { downArrow: true });
    expect(renderWorkspaceScreen(list.getSnapshot(), 80, 24)).toContain("Proposal 59");
  });

  it("plain output is linear, uncolored, complete, and never invents validation success", () => {
    const view = fixture();
    const before = JSON.stringify(view);
    const plain = renderWorkspacePlain(view);
    for (const title of ["CHANGES", "WORLD / READ-ONLY", "CONSTRAINTS", "SAVED WORKSPACE DECISIONS", "REVIEW / DRAFT CANDIDATE"]) expect(plain).toContain(title);
    expect(plain).toContain(view.workspace.base.snapshotDigest);
    expect(plain).toContain("The service's exact proposed text.");
    expect(plain).toContain("中立 👩🏽‍💻");
    expect(plain).toContain("No prerequisites reported.");
    expect(plain).not.toContain("absent");
    expect(plain).toContain("Validation: NOT RUN");
    expect(plain).toContain("does NOT mean historically valid");
    expect(plain).not.toMatch(/\x1b|\x9b/);
    expect(JSON.stringify(view)).toBe(before);
  });
});

describe("terminal-safe Unicode presentation", () => {
  it("removes ANSI/OSC/C0/C1/bidi controls but retains Unicode and intentional newlines", () => {
    const unsafe = "α\x1b[31mred\x1b[0m\n中立 👩🏽‍💻 e\u0301\x1b]8;;https://evil.test\x07link\x1b]8;;\x1b\\\x00\x07\x9b2J\u202eevil\u2066!\u2069";
    expect(terminalText(unsafe)).toBe("αred\n中立 👩🏽‍💻 e\u0301linkevil!");
    expect(terminalText("safe\x1b]52;c;payload")).toBe("safe");
    expect(terminalText("safe\x1bPsecret\x1b\\end")).toBe("safeend");
        expect(terminalText("before\x1b7\x1b8\x1b(0after")).toBe("beforeafter");
    const view = fixture();
    const hostile: WorkspaceViewV1 = { ...view, workspace: { ...view.workspace, title: unsafe, worldTitle: unsafe, direction: unsafe, proposals: view.workspace.proposals.map(group => ({ ...group, title: unsafe, rationale: unsafe })) },
      changes: view.changes.map(change => ({ ...change, before: [unsafe], proposed: [unsafe] })) };
    expect(renderWorkspacePlain(hostile)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066\u2069]/);
    expect(renderWorkspaceScreen(controller(hostile).getSnapshot(), 100, 30)).not.toContain("\x1b");
  });

  it("wraps without splitting graphemes and shows a more indicator in both directions", () => {
    const text = "👩🏽‍💻中e\u0301\n  indented";
    expect(wrap(text, 4).join("")).toBe(text.replace("\n", ""));
    expect(wrap(text, 4).every(line => cells(line) <= 4)).toBe(true);
    expect(viewport(Array.from({ length: 20 }, (_, i) => `line ${i}`), 100, 5, 79).join("\n")).toContain("line 19");
    expect(viewport(Array.from({ length: 20 }, (_, i) => `line ${i}`), 100, 5, 79).join("\n")).toContain("[More:");
  });
});

describe("grapheme-safe multiline editing", () => {
  it("moves a cursor and deletes complete emoji/combining clusters", () => {
    let buffer = textBuffer("A👩🏽‍💻e\u0301中");
    buffer = editText(buffer, { kind: "left" });
    buffer = editText(buffer, { kind: "backspace" });
    expect(buffer.text).toBe("A👩🏽‍💻中");
    buffer = editText(buffer, { kind: "backspace" });
    expect(buffer.text).toBe("A中");
    buffer = editText(buffer, { kind: "insert", text: "e\u0301\n世界" });
    expect(buffer.text).toBe("Ae\u0301\n世界中");
    buffer = editText(buffer, { kind: "delete" });
    expect(buffer.text).toBe("Ae\u0301\n世界");
  });
  it("preserves a preferred column across short lines and handles empty first lines", () => {
    let buffer = { ...textBuffer("abcd\nx\n12345"), cursor: 4 };
    buffer = editText(buffer, { kind: "down" });
    expect(buffer.cursor).toBe(6);
    buffer = editText(buffer, { kind: "down" });
    expect(buffer.cursor).toBe(11);
    buffer = editText(buffer, { kind: "up" });
    expect(buffer.cursor).toBe(6);
    const emptyFirst = { ...textBuffer("\nnext"), cursor: 0 };
    expect(editText(emptyFirst, { kind: "home" }).cursor).toBe(0);
    expect(editText(emptyFirst, { kind: "down" }).cursor).toBe(1);
    expect(editText({ ...emptyFirst, cursor: 1 }, { kind: "up" }).cursor).toBe(0);
  });
  it("joins separately typed combining marks safely and normalizes pasted line endings", () => {
    let buffer = editText(textBuffer("e"), { kind: "insert", text: "\u0301" });
    expect(buffer.cursor).toBe(1);
    expect(editText(buffer, { kind: "backspace" }).text).toBe("");
    buffer = editText(textBuffer(), { kind: "insert", text: "line1\r\nline2\rline3\x1b[31m" });
    expect(buffer.text).toBe("line1\nline2\nline3\x1b[31m");
        expect(terminalText(buffer.text)).toBe("line1\nline2\nline3");
    expect(editText(buffer, { kind: "home" }).cursor).toBe(12);
    expect(editText(buffer, { kind: "start" }).cursor).toBe(0);
    expect(editText(buffer, { kind: "end" }).cursor).toBe(buffer.cursor);
  });
});
