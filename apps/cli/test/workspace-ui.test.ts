import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render as renderInk } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceViewV1 } from "@wmm/wire-contracts";
import { WorkspaceEditor } from "../src/workspace/app.js";
import type { WorkspaceClient } from "../src/workspace/client.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { runWorkspaceEditor } from "../src/workspace/index.js";
import { renderWorkspaceScreen } from "../src/workspace/presentation.js";

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(enabled: boolean): this { this.isRaw = enabled; return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
class TerminalOutput extends Writable {
  readonly isTTY = true;
  columns = 100;
  rows = 24;
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    done();
  }
}

function fixture(): WorkspaceViewV1 {
  const document = { path: "prose/council.md", text: "The base council.\nSecond line.", truncated: false, sha256: "a".repeat(64) };
  const group = { id: "council", version: 1, title: "Establish a council", author: "Author", rationale: "Original reason", dependencies: ["death"], exclusions: ["coup"],
    operations: [{ kind: "write-prose" as const, path: document.path, text: "A council governs.", beforeSha256: document.sha256 }], decision: "undecided" as const, rejectionReason: null };
  return {
    format: "wmm.workspace-view/1",
    workspace: { format: "wmm.workspace/1", id: "workspace", version: 3, title: "Succession", worldTitle: "Valen", mode: "world", goal: "Preserve continuity", base: { worldId: "world", snapshotDigest: "b".repeat(64) },
      proposals: [group, { ...group, id: "death", title: "Record death", dependencies: [], exclusions: [] }], pins: [], direction: "Neutrality", history: [] },
    documents: [document], records: [{ id: "neutrality", kind: "active assertion", title: "Neutrality", summary: "The neighbor is neutral." }],
    changes: [{ groupId: "council", representation: "explicit-prose", before: ["Service BEFORE"], proposed: ["Service PROPOSED"] }],
    prerequisites: [{ groupId: "council", required: ["death"], missing: ["death"], rejected: [] }, { groupId: "death", required: [], missing: [], rejected: [] }],
    selection: { requested: [], required: [], missing: [], rejectedRequired: [], diagnostics: [] },
    validation: { status: "not-run", message: "Historical validation not available." }, approval: "unavailable", canon: "unchanged",
  };
}
function harness(initial = fixture()) {
  const read = vi.fn<WorkspaceClient["read"]>(() => initial);
  const mutate = vi.fn<WorkspaceClient["mutate"]>(() => ({ ...initial, workspace: { ...initial.workspace, version: initial.workspace.version + 1 } }));
  let key = 0;
  const client = { read, mutate };
  const controller = new WorkspaceController(client, initial, () => `request-${++key}`);
  return { client, read, mutate, controller };
}
const save = (controller: WorkspaceController): void => { controller.input("", { ctrl: true, return: true }); };
const choose = (controller: WorkspaceController, index: number): void => {
  for (let i = 0; i < index; i++) controller.input("", { downArrow: true });
  controller.input("", { return: true });
};
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 40); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("service-driven workspace choices", () => {
  it("offers cancel / alone / explicit prerequisites without selecting implicitly", () => {
    const { controller, mutate } = harness();
    controller.input(" ");
    expect(mutate).not.toHaveBeenCalled();
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("REVIEW PREREQUISITES");
    controller.input("", { escape: true });
    expect(mutate).not.toHaveBeenCalled();
    controller.input(" "); choose(controller, 1);
    expect(mutate).toHaveBeenLastCalledWith({ kind: "decide", groupId: "council", decision: "selected" }, 3, expect.any(String));
    const explicit = harness(); explicit.controller.input(" "); choose(explicit.controller, 2);
    expect(explicit.mutate).toHaveBeenLastCalledWith({ kind: "select", groupIds: ["council", "death"] }, 3, expect.any(String));
  });

  it("retains unrelated selected intervention when including a new regency and its prerequisites", () => {
    const base = fixture();
    const council = base.workspace.proposals[0]!;
    const neutrality = { path: "prose/neutrality.md", text: "The neighboring kingdom remains neutral.", truncated: false, sha256: "c".repeat(64) };
    const intervention = { ...council, id: "intervention", title: "Invite foreign military intervention", dependencies: ["death"], exclusions: [], decision: "selected" as const,
      operations: [{ kind: "write-prose" as const, path: neutrality.path, beforeSha256: neutrality.sha256, text: "The neighboring army intervenes." }] };
    const diagnostic = { code: "PIN_CHANGED", groupIds: [intervention.id], message: "Invite foreign military intervention targets an active base-bound protection. Canon remains unchanged." };
    const initial: WorkspaceViewV1 = { ...base, documents: [...base.documents, neutrality],
      workspace: { ...base.workspace, mode: "succession-demo", proposals: [council, { ...base.workspace.proposals[1]!, decision: "selected" }, intervention],
        pins: [{ id: "neutrality-pin", kind: "document", path: neutrality.path, sha256: neutrality.sha256, active: true }] },
      prerequisites: [{ groupId: "council", required: ["death"], missing: [], rejected: [] }, { groupId: "death", required: [], missing: [], rejected: [] }, { groupId: "intervention", required: ["death"], missing: [], rejected: [] }],
      selection: { ...base.selection, requested: ["death", "intervention"], diagnostics: [diagnostic] },
    };
    const regency = { ...council, id: "regency", title: "Negotiate a regency", rationale: "Keep the dynasty.", dependencies: ["death", "council"], exclusions: ["coup"],
      operations: [{ kind: "write-prose" as const, path: "prose/developments/regency.md", text: "An explicit regency proposal.", beforeSha256: null }] };
    const withRegency: WorkspaceViewV1 = { ...initial, workspace: { ...initial.workspace, version: 4, proposals: [...initial.workspace.proposals, regency] },
      prerequisites: [...initial.prerequisites, { groupId: "regency", required: ["death", "council"], missing: ["council"], rejected: [] }],
    };
    const { controller, mutate } = harness(initial);
    mutate.mockReturnValueOnce(withRegency).mockImplementation(action => {
      if (action.kind !== "select") throw new Error("Expected a full replacement selection");
      // Model the API's replacement semantics, not an additive selection mock.
      return { ...withRegency, workspace: { ...withRegency.workspace, version: 5, proposals: withRegency.workspace.proposals.map(group => ({ ...group, decision: action.groupIds.includes(group.id) ? "selected" : "undecided" })) },
        selection: { ...withRegency.selection, requested: action.groupIds, diagnostics: action.groupIds.includes("intervention") ? [diagnostic] : [] },
        prerequisites: withRegency.prerequisites.map(item => ({ ...item, missing: [] })),
      };
    });
    controller.input("a"); choose(controller, 1);
    controller.input("", { tab: true }); controller.paste("Keep the dynasty."); save(controller);
    expect(mutate).toHaveBeenNthCalledWith(1, { kind: "add-regency", title: "Negotiate a regency", rationale: "Keep the dynasty." }, 3, expect.any(String));
    expect(controller.getSnapshot().view.workspace.proposals.find(group => group.id === "regency")?.decision).toBe("undecided");
    for (let i = 0; i < 3; i++) controller.input("", { downArrow: true });
    controller.input(" ");
    expect(mutate).toHaveBeenCalledTimes(1);
    choose(controller, 2);
    const action = mutate.mock.calls[1]?.[0];
    if (action?.kind !== "select") throw new Error("expected replacement selection");
    expect(new Set(action.groupIds)).toEqual(new Set(["death", "intervention", "regency", "council"]));
    expect(action.groupIds).toHaveLength(4);
    const acknowledged = controller.getSnapshot().view;
    expect(acknowledged.workspace.proposals.find(group => group.id === "intervention")?.decision).toBe("selected");
    expect(acknowledged.selection.diagnostics).toContainEqual(diagnostic);
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("[x] Selected | Invite foreign military intervention");
    controller.input("v");
    let review = "";
    for (let i = 0; i < 8; i++) { review += renderWorkspaceScreen(controller.getSnapshot(), 80, 24); controller.input("", { pageDown: true }); }
    expect(review).toContain("Invite foreign military intervention");
    expect(review).toContain("PIN_CHANGED");
  });

  it("uses per-group service prerequisites rather than deriving proposal dependencies", () => {
    const initial = fixture();
    const view: WorkspaceViewV1 = { ...initial, prerequisites: [{ groupId: "council", required: [], missing: [], rejected: [] }] };
    const { controller, mutate } = harness(view);
    controller.input(" ");
    expect(mutate).toHaveBeenCalledWith({ kind: "decide", groupId: "council", decision: "selected" }, 3, expect.any(String));
    const missing = harness({ ...initial, prerequisites: [] });
    missing.controller.input(" ");
    expect(missing.mutate).not.toHaveBeenCalled();
    expect(missing.controller.getSnapshot().status).toContain("unavailable");
  });

  it("blocks reviving rejected prerequisites and restores rejected groups only to undecided", () => {
    const initial = fixture();
    const rejected: WorkspaceViewV1 = { ...initial, prerequisites: [{ groupId: "council", required: ["death"], missing: ["death"], rejected: ["death"] }], workspace: { ...initial.workspace, proposals: initial.workspace.proposals.map(group => group.id === "death" ? { ...group, decision: "rejected", rejectionReason: "Keep the sovereign alive." } : group) } };
    const { controller, mutate } = harness(rejected);
    controller.input(" "); choose(controller, 2);
    expect(mutate).not.toHaveBeenCalled();
    controller.input("", { escape: true });
    controller.input("", { downArrow: true }); controller.input(" ");
    expect(mutate).not.toHaveBeenCalled();
    controller.input("r");
    expect(mutate).not.toHaveBeenCalled();
    choose(controller, 1);
    expect(mutate).toHaveBeenCalledWith({ kind: "decide", groupId: "death", decision: "undecided" }, 3, expect.any(String));
  });

  it("sanitizes only presentation, not imported operations or pasted source text", () => {
    const { controller, mutate } = harness();
    const source = "\nSource \x1b[31mbytes\x1b[0m\u202e remain stored 👩🏽‍💻";
    controller.input("e"); controller.paste(source);
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 80, 24);
    expect(screen).not.toMatch(/\x1b|\u202e/);
    save(controller);
    const action = mutate.mock.calls[0]?.[0];
    if (action?.kind !== "put-proposal") throw new Error("expected proposal");
    expect(action.proposal.rationale).toBe("Original reason" + source);
  });

  it("persists rejection reasons as a decision, not deletion", () => {
    const { controller, mutate } = harness();
    controller.input("r"); controller.paste("No coup.\nPreserve council."); save(controller);
    expect(mutate).toHaveBeenCalledWith({ kind: "decide", groupId: "council", decision: "rejected", reason: "No coup.\nPreserve council." }, 3, expect.any(String));
  });

  it("edits rationale with the exact original structured effects, not replacement prose", () => {
    const initial = fixture();
    const { controller, mutate } = harness(initial);
    controller.input("e"); controller.paste("\nNew rationale, not an effect."); save(controller);
    expect(mutate).toHaveBeenCalledWith({ kind: "put-proposal", proposal: {
      id: "council", title: "Establish a council", author: "Author", rationale: "Original reason\nNew rationale, not an effect.",
      dependencies: initial.workspace.proposals[0]?.dependencies, exclusions: initial.workspace.proposals[0]?.exclusions, operations: initial.workspace.proposals[0]?.operations,
    } }, 3, expect.any(String));
    const action = mutate.mock.calls[0]?.[0];
    if (action?.kind !== "put-proposal") throw new Error("expected proposal");
    expect(action.proposal.operations).toBe(initial.workspace.proposals[0]?.operations);
  });

  it.each([false, true])("creates a typed write-prose proposal using actual base metadata (existing=%s)", existing => {
    const { controller, mutate } = harness();
    controller.input("a"); controller.paste(existing ? "prose/council.md" : "prose/new.md");
    controller.input("", { tab: true }); controller.paste("A supported proposal");
    controller.input("", { tab: true }); controller.paste("Explain why.");
    controller.input("", { tab: true }); controller.paste("Explicit body\n👩🏽‍💻 中立"); save(controller);
    expect(mutate).toHaveBeenCalledWith({ kind: "put-proposal", proposal: {
      id: expect.any(String), title: "A supported proposal", author: "Human", rationale: "Explain why.", dependencies: [], exclusions: [],
      operations: [{ kind: "write-prose", path: existing ? "prose/council.md" : "prose/new.md", text: "Explicit body\n👩🏽‍💻 中立", beforeSha256: existing ? "a".repeat(64) : null }],
    } }, 3, expect.any(String));
  });

  it("fails closed when an older service omits an existing document hash", () => {
    const initial = fixture();
    // Exercise the compatibility guard even after sha256 becomes a required wire field.
    const noHash = { ...initial.documents[0], sha256: undefined } as unknown as WorkspaceViewV1["documents"][number];
    const { controller, mutate } = harness({ ...initial, documents: [noHash] });
    controller.input("a"); controller.paste("prose/council.md");
    controller.input("", { tab: true }); controller.paste("Replacement"); save(controller);
    expect(mutate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().modal?.kind).toBe("form");
    expect(controller.getSnapshot().status).toContain("SHA-256");
  });

  it("labels the explicit demo template and never exposes it in world mode", () => {
    const initial = fixture();
    const demo = harness({ ...initial, workspace: { ...initial.workspace, mode: "succession-demo" } });
    demo.controller.input("a"); choose(demo.controller, 1);
    expect(renderWorkspaceScreen(demo.controller.getSnapshot(), 80, 24)).toContain("NOT GENERATED");
    demo.controller.input("", { tab: true }); demo.controller.paste("A human-authored rationale."); save(demo.controller);
    expect(demo.mutate).toHaveBeenCalledWith({ kind: "add-regency", title: "Negotiate a regency", rationale: "A human-authored rationale." }, 3, expect.any(String));
    const world = harness(); world.controller.input("a");
    expect(renderWorkspaceScreen(world.controller.getSnapshot(), 80, 24)).toContain("WRITE-PROSE");
    expect(renderWorkspaceScreen(world.controller.getSnapshot(), 80, 24)).not.toContain("REGENCY TEMPLATE");
  });

  it.each([
    ["active assertion", true], ["inactive assertion", false], ["assertion", false], ["source", false],
  ] as const)("permits World pins only for active assertion descriptors (kind=%s)", (kind, pinnable) => {
    const base = fixture();
    const { controller, mutate } = harness({ ...base, records: base.records.map(record => ({ ...record, kind })) });
    controller.input("2"); controller.input("", { downArrow: true }); controller.input("p");
    expect(mutate).not.toHaveBeenCalled();
    if (pinnable) {
      expect(controller.getSnapshot().modal?.kind).toBe("choice");
      expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("ADD HARD PROTECTION");
      choose(controller, 1);
      expect(mutate).toHaveBeenCalledExactlyOnceWith({ kind: "put-pin", pin: { id: expect.any(String), kind: "assertion", assertionId: "neutrality", active: true } }, 3, expect.any(String));
    } else {
      expect(controller.getSnapshot().modal).toBeNull();
      controller.input("", { return: true });
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it("confirms exact document/assertion pins and unpins, separately from advice", () => {
    const { controller, mutate } = harness();
    controller.input("2"); controller.input("p");
    expect(mutate).not.toHaveBeenCalled();
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("ADD HARD PROTECTION");
    choose(controller, 1);
    expect(mutate).toHaveBeenCalledWith({ kind: "put-pin", pin: { id: expect.any(String), kind: "document", path: "prose/council.md", sha256: "a".repeat(64), active: true } }, 3, expect.any(String));
    const assertion = harness(); assertion.controller.input("2"); assertion.controller.input("", { downArrow: true }); assertion.controller.input("p"); choose(assertion.controller, 1);
    expect(assertion.mutate).toHaveBeenCalledWith({ kind: "put-pin", pin: { id: expect.any(String), kind: "assertion", assertionId: "neutrality", active: true } }, 3, expect.any(String));
    const initial = fixture();
    const unpin = harness({ ...initial, workspace: { ...initial.workspace, pins: [{ id: "pin", kind: "assertion", assertionId: "neutrality", active: true }] } });
    unpin.controller.input("3"); unpin.controller.input("p"); choose(unpin.controller, 1);
    expect(unpin.mutate).toHaveBeenCalledWith({ kind: "put-pin", pin: { id: "pin", kind: "assertion", assertionId: "neutrality", active: false } }, 3, expect.any(String));
  });
});

describe("save acknowledgement and recovery", () => {
  it("keeps the form and retry identity after an unknown save outcome", () => {
    const { controller, mutate, read } = harness();
    mutate.mockImplementationOnce(() => { throw new Error("Connection lost after send"); });
    controller.input("n"); controller.paste("\nMy buffer"); save(controller);
    const original = mutate.mock.calls[0];
    expect(read).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().saveState).toBe("failed");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("BUFFER RETAINED");
    controller.input("", { escape: true });
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("My buffer");
    save(controller); // Opens retry review, does not resubmit automatically.
    expect(mutate).toHaveBeenCalledTimes(1);
    controller.input("", { return: true });
    expect(mutate.mock.calls[1]).toEqual(original);
    expect(controller.getSnapshot().saveState).toBe("saved");
    expect(controller.getSnapshot().modal).toBeNull();
    expect(controller.getSnapshot().status).toContain("Saved workspace v4");
  });

  it("retains an unknown attempt's key even if refresh observes a newer saved version", () => {
    const initial = fixture();
    const { controller, mutate, read } = harness(initial);
    mutate.mockImplementationOnce(() => { throw new Error("Reply lost after commit"); });
    read.mockReturnValue({ ...initial, workspace: { ...initial.workspace, version: 4 } });
    controller.input("", { downArrow: true }); controller.input(" ");
    const original = mutate.mock.calls[0];
    controller.input("", { escape: true }); controller.input(" ");
    expect(mutate).toHaveBeenCalledTimes(1);
    controller.input("y");
    expect(mutate.mock.calls[1]).toEqual(original);
  });

  it("can refresh a failed stale read without resubmitting or losing the form", () => {
    const initial = fixture();
    const { controller, mutate, read } = harness(initial);
    mutate.mockImplementationOnce(() => { throw new Error("STALE_WORKSPACE"); });
    read.mockImplementationOnce(() => { throw new Error("Temporarily offline"); });
    controller.input("n"); controller.paste(" My text"); save(controller);
    controller.input("y"); expect(mutate).toHaveBeenCalledTimes(1);
    read.mockReturnValue({ ...initial, workspace: { ...initial.workspace, version: 8 } });
    controller.input("r");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().view.workspace.version).toBe(8);
    controller.input("y"); expect(mutate.mock.calls[1]?.[1]).toBe(8);
  });

  it("refreshes stale state, keeps input, and only explicitly retries with a new key/version", () => {
    const initial = fixture();
    const { controller, mutate, read } = harness(initial);
    mutate.mockImplementationOnce(() => { throw Object.assign(new Error("Newer work exists"), { code: "STALE_WORKSPACE" }); });
    read.mockReturnValue({ ...initial, workspace: { ...initial.workspace, version: 9, direction: "Other author's direction" } });
    controller.input("n"); controller.paste("\nMy direction"); save(controller);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().view.workspace.version).toBe(9);
    expect(controller.getSnapshot().saveState).toBe("stale");
    controller.input("", { escape: true });
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("My direction");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).not.toContain("Other author's direction");
    save(controller); expect(mutate).toHaveBeenCalledTimes(1);
    controller.input("y");
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0]);
    expect(mutate.mock.calls[1]?.[1]).toBe(9);
    expect(mutate.mock.calls[1]?.[2]).not.toBe(mutate.mock.calls[0]?.[2]);
  });

  it("does not overwrite newer structured operations during a stale rationale retry", () => {
    const initial = fixture();
    const { controller, mutate, read } = harness(initial);
    mutate.mockImplementationOnce(() => { throw new Error("STALE_WORKSPACE"); });
    read.mockReturnValue({ ...initial, workspace: { ...initial.workspace, version: 4, proposals: initial.workspace.proposals.map(group => ({ ...group, version: 2, operations: [{ kind: "write-prose", path: "prose/other.md", text: "New semantic effect", beforeSha256: null }] })) } });
    controller.input("e"); controller.paste("My explanation"); save(controller);
    controller.input("y");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status).toContain("Proposal structure changed");
    controller.input("b"); // Explicitly load current structure, not an automatic merge or save.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("My explanation");
    save(controller);
    expect(mutate.mock.calls[1]?.[1]).toBe(4);
    const action = mutate.mock.calls[1]?.[0];
    if (action?.kind !== "put-proposal") throw new Error("expected proposal");
    expect(action.proposal.rationale).toBe("Original reasonMy explanation");
    expect(action.proposal.operations).toEqual([{ kind: "write-prose", path: "prose/other.md", text: "New semantic effect", beforeSha256: null }]);
  });

  it("never optimistically changes decisions or calls a failed transaction saved", () => {
    const { controller, mutate, read } = harness();
    mutate.mockImplementation(() => { throw new Error("Disk full"); });
    read.mockImplementation(() => { throw new Error("Read unavailable"); });
    controller.input("", { downArrow: true }); controller.input(" ");
    expect(controller.getSnapshot().view.workspace.proposals[1]?.decision).toBe("undecided");
    expect(controller.getSnapshot().saveState).toBe("failed");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).not.toContain("Saved v4");
  });
});

describe("optional host text editing", () => {
  it("uses Ctrl+E for the focused field and requires a separate explicit save", async () => {
    const { client, mutate } = harness();
    const editText = vi.fn<NonNullable<WorkspaceClient["editText"]>>(() => "External rationale\n中立 👩🏽‍💻");
    const initial = fixture();
    const controller = new WorkspaceController({ ...client, editText }, initial);
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle(); app.stdin.write("e"); await settle();
    expect(app.lastFrame()).toContain("Ctrl+E: external editor");
    app.stdin.write("\x05");
    await vi.waitFor(() => { expect(app.lastFrame()).toContain("External rationale"); });
    expect(editText).toHaveBeenCalledExactlyOnceWith("Original reason");
    expect(mutate).not.toHaveBeenCalled();
    app.stdin.write("\x13");
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce(); });
    const action = mutate.mock.calls[0]?.[0];
    if (action?.kind !== "put-proposal") throw new Error("expected proposal");
    expect(action.proposal.rationale).toBe("External rationale\n中立 👩🏽‍💻");
    expect(action.proposal.operations).toBe(initial.workspace.proposals[0]?.operations);
  });

  it("waits for suspension to resume before changing the buffer and ignores input during handoff", async () => {
    const { client, mutate } = harness();
    const order: string[] = [];
    const editText = vi.fn(() => { order.push("host"); return "Returned text"; });
    const controller = new WorkspaceController({ ...client, editText }, fixture());
    controller.input("n");
    const original = controller.getSnapshot().modal;
    let resume: () => void = () => { throw new Error("Suspension was not entered"); };
    const pendingResume = new Promise<void>(resolve => { resume = resolve; });
    const pendingEdit = controller.editExternally(async callback => {
      order.push("suspend");
      try { callback(); await pendingResume; }
      finally { order.push("resume"); }
    });
    expect(order).toEqual(["suspend", "host"]);
    controller.input("q"); controller.input("s", { ctrl: true }); controller.paste("Ignored input");
    await controller.editExternally(async callback => { callback(); });
    expect(editText).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().modal).toBe(original);
    expect(mutate).not.toHaveBeenCalled();
    resume(); await pendingEdit;
    expect(order).toEqual(["suspend", "host", "resume"]);
    const form = controller.getSnapshot().modal;
    if (form?.kind !== "form") throw new Error("expected form");
    expect(form.fields[0]?.buffer.text).toBe("Returned text");
  });

  it.each([false, true])("Ink releases and restores terminal modes around the host callback (throws=%s)", async throws => {
    const { client, mutate } = harness();
    const stdin = new TerminalInput();
    const stdout = new TerminalOutput();
    const hostText = "External text\n👩🏽‍💻";
    const editText = vi.fn(() => {
      expect(stdin.isRaw).toBe(false);
      expect(stdout.text.lastIndexOf("\x1b[?2004l")).toBeGreaterThan(stdout.text.lastIndexOf("\x1b[?2004h"));
      expect(stdout.text.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(stdout.text.lastIndexOf("\x1b[?1049h"));
      if (throws) throw new Error("Host editor cancelled");
      return hostText;
    });
    const controller = new WorkspaceController({ ...client, editText }, fixture());
    controller.input("e"); controller.input("", { leftArrow: true });
    const original = controller.getSnapshot().modal;
    if (original?.kind !== "form") throw new Error("expected form");
    const instance = renderInk(createElement(WorkspaceEditor, { controller }), {
      stdin, stdout, stderr: stdout, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await vi.waitFor(() => { expect(stdin.isRaw).toBe(true); });
      stdin.write("\x05");
      await vi.waitFor(() => {
        const form = controller.getSnapshot().modal;
        if (form?.kind !== "form") throw new Error("expected retained form");
        if (throws) {
          expect(form.error).toContain("Host editor cancelled");
          expect(form.fields[0]?.buffer).toBe(original.fields[0]?.buffer);
        } else {
          expect(form.fields[0]?.buffer.text).toBe(hostText);
          expect(form.proposal).toBe(original.proposal);
          expect(form.baseVersion).toBe(original.baseVersion);
        }
        expect(stdin.isRaw).toBe(true);
      });
      expect(editText).toHaveBeenCalledOnce();
      expect(stdout.text.lastIndexOf("\x1b[?2004h")).toBeGreaterThan(stdout.text.lastIndexOf("\x1b[?2004l"));
      expect(stdout.text.lastIndexOf("\x1b[?1049h")).toBeGreaterThan(stdout.text.lastIndexOf("\x1b[?1049l"));
      expect(mutate).not.toHaveBeenCalled();
      stdin.write("x");
      await vi.waitFor(() => {
        const form = controller.getSnapshot().modal;
        if (form?.kind !== "form") throw new Error("expected form");
        expect(form.fields[0]?.buffer.text).toContain(throws ? "Original reasoxn" : hostText + "x");
      });
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      expect(stdin.isRaw).toBe(false);
      stdin.destroy(); stdout.destroy();
    }
  });

  it("keeps Ctrl+E as end-of-buffer without a callback and ignores it outside forms", async () => {
    const { controller, mutate } = harness();
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle(); app.stdin.write("e"); await settle(); app.stdin.write("\x1b[D"); await settle(); app.stdin.write("\x05"); await settle();
    expect(app.lastFrame()).toContain("Original reason|");
    expect(app.lastFrame()).not.toContain("Ctrl+E: external editor");
    expect(mutate).not.toHaveBeenCalled();
    app.stdin.write("\x1b"); await settle(); app.stdin.write("\x05"); await settle();
    expect(controller.getSnapshot().modal).toBeNull();
  });
});

describe("Ink rendering and input isolation", () => {
  it.each([[80, 24], [100, 30], [120, 36]])("renders the actual component at %ix%i", async (columns, rows) => {
    const { controller } = harness();
    const app = render(createElement(WorkspaceEditor, { controller, columns, rows }));
    Object.defineProperty(app.stdout, "columns", { configurable: true, value: columns });
    app.rerender(createElement(WorkspaceEditor, { controller, columns, rows }));
    await settle();
    expect(app.lastFrame()).toContain("CANON READ-ONLY");
    expect(app.lastFrame()).toContain("[1 Changes]");
    if (columns >= 100) expect(app.lastFrame()).toContain("INSPECTOR");
    else { app.stdin.write("\r"); await settle(); expect(app.lastFrame()).toContain("Service BEFORE"); }
  });

  it("does not fire shortcuts while typing or from single-character bracketed paste", async () => {
    const { controller, mutate } = harness();
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle();
    app.stdin.write("\x1b[200~q\x1b[201~"); await settle();
    expect(controller.getSnapshot().quit).toBe(false);
    app.stdin.write("n"); await settle();
    app.stdin.write("qravnpde12345 "); await settle();
    app.stdin.write("\x1b[200~first\n👩🏽‍💻 中立\x1b[201~"); await settle();
    app.stdin.write("\r"); await settle();
    expect(mutate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().quit).toBe(false);
    expect(controller.getSnapshot().tab).toBe("Changes");
    const modal = controller.getSnapshot().modal;
    if (modal?.kind !== "form") throw new Error("expected retained form");
    expect(modal.fields[0]?.buffer.text).toBe("Neutralityqravnpde12345 first\n👩🏽‍💻 中立\n");
    app.stdin.write("\x13"); await settle(); // Ctrl+S fallback for legacy terminals.
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("buffers split bracketed paste markers/content without acting on escape or shortcuts", async () => {
    const { controller, mutate } = harness();
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle(); app.stdin.write("n"); await settle();
    for (const chunk of ["\x1b[20", "0~", "q\n", "👩🏽‍💻", "\x1b[20", "1~"]) app.stdin.write(chunk);
    await settle();
    const modal = controller.getSnapshot().modal;
    expect(modal?.kind).toBe("form");
    if (modal?.kind === "form") expect(modal.fields[0]?.buffer.text).toBe("Neutralityq\n👩🏽‍💻");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves text/cursor/focus when rerendered from narrow to wide and back", async () => {
    const { controller } = harness();
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle(); app.stdin.write("e"); await settle(); app.stdin.write("\x1b[D"); await settle();
    const modal = controller.getSnapshot().modal;
    app.rerender(createElement(WorkspaceEditor, { controller, columns: 120, rows: 36 })); await settle();
    app.rerender(createElement(WorkspaceEditor, { controller, columns: 40, rows: 12 })); await settle();
    expect(app.lastFrame()).toContain("Terminal too small");
    app.rerender(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 })); await settle();
    expect(controller.getSnapshot().modal).toBe(modal);
    expect(app.lastFrame()).toContain("Original reaso|n");
  });

  it("handles real stdout resize events without recreating text input", async () => {
    const { controller } = harness();
    const app = render(createElement(WorkspaceEditor, { controller }));
    // ink-testing-library omits rows; avoid Ink's host-dependent terminal-size fallback.
    Object.defineProperty(app.stdout, "rows", { configurable: true, value: 24 });
    app.stdout.emit("resize"); await settle();
    expect(app.lastFrame()).not.toContain("Terminal too small");
    app.stdin.write("n"); await settle();
    expect(app.lastFrame()).toContain("ADVISORY DIRECTION");
    const modal = controller.getSnapshot().modal;
    Object.defineProperty(app.stdout, "columns", { configurable: true, value: 40 });
    app.stdout.emit("resize"); await settle();
    expect(app.lastFrame()).toContain("Terminal too small");
    Object.defineProperty(app.stdout, "columns", { configurable: true, value: 100 });
    app.stdout.emit("resize"); await settle();
    expect(controller.getSnapshot().modal).toBe(modal);
    expect(app.lastFrame()).toContain("ADVISORY DIRECTION");
  });

  it("clamps page scrolling at the end so Page Up immediately moves backward", async () => {
    const initial = fixture();
    const view: WorkspaceViewV1 = { ...initial, workspace: { ...initial.workspace, history: [{ version: 3, action: { kind: "set-direction", text: "Many rows of history.\n".repeat(100) } }] } };
    const { controller } = harness(view);
    const app = render(createElement(WorkspaceEditor, { controller, columns: 80, rows: 24 }));
    await settle(); app.stdin.write("4"); await settle();
    for (let i = 0; i < 100; i++) controller.input("", { pageDown: true });
    await settle();
    const atEnd = controller.getSnapshot().scroll;
    app.stdin.write("\x1b[5~"); await settle();
    expect(controller.getSnapshot().scroll).toBe(atEnd - 8);
  });

  it("refuses interactive startup for non-TTY/TERM=dumb without reading or prompting", async () => {
    const { client } = harness();
    vi.stubEnv("TERM", "dumb");
    try { await expect(runWorkspaceEditor(client, fixture())).rejects.toThrow("interactive terminal"); }
    finally { vi.unstubAllEnvs(); }
    expect(client.read).not.toHaveBeenCalled();
    expect(client.mutate).not.toHaveBeenCalled();
  });
});
