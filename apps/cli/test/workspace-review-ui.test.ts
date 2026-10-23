import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimBodyV1, WorkspaceReviewBindingV1, WorkspaceReviewV1, WorkspaceViewV1 } from "@wmm/wire-contracts";
import { WorkspaceEditor } from "../src/workspace/app.js";
import type { WorkspaceClient } from "../src/workspace/client.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { renderWorkspacePlain, renderWorkspaceScreen, reviewLines } from "../src/workspace/presentation.js";
import { reviewStatus } from "../src/workspace/review.js";
import { cells } from "../src/workspace/text.js";

function fixture(validity: WorkspaceReviewV1["validity"] = "valid"): WorkspaceViewV1 {
  const profile = "f".repeat(64);
  const claim: ClaimBodyV1 = {
    format: "wmm.claim/1", worldId: "valen", semanticProfileDigest: profile, polarity: "positive",
    proposition: { kind: "atom", subjectId: "council-entity", predicateDefinitionDigest: "9".repeat(64), value: { kind: "ref", id: "realm" } },
    scope: { account: { kind: "notApplicable" }, jurisdiction: { kind: "ref", id: "realm" }, recognitionFrame: { kind: "unresolved" } },
    applicability: { kind: "interval", axisDefinitionDigest: "8".repeat(64), start: { kind: "exact", position: "1442-06-01" }, endExclusive: { kind: "exact", position: "1443-01-01" } },
  };
  const review: WorkspaceReviewV1 = {
    format: "wmm.workspace-review/1",
    binding: { worldId: "valen", workspaceId: "succession", workspaceVersion: 7, baseSnapshotDigest: "b".repeat(64), semanticProfileDigest: profile,
      evaluator: "bundled-workspace-review-v1", selectedGroups: [{ id: "council", version: 2 }], operationsDigest: "1".repeat(64), steeringDigest: "2".repeat(64) },
    candidateDigest: "c".repeat(64), candidateSnapshotDigest: "d".repeat(64), evaluationDigest: "e".repeat(64), limits: { maxWorkUnits: 1200 },
    execution: "completed", validity,
    checks: [{ id: "selection", status: "passed" }, { id: "operations", status: "passed" }, { id: "references", status: "passed" },
      { id: "pins", status: "passed" }, { id: "explicit-opposition", status: validity === "invalid" ? "failed" : validity === "undetermined" ? "unresolved" : "passed" }],
    diff: { documents: [{ path: "prose/council.md", kind: "modified", beforeSha256: "a".repeat(64), afterSha256: "3".repeat(64),
      before: "Combined BEFORE from receipt", after: "Combined AFTER from receipt", truncated: true, groupIds: ["council"] },
      { path: "prose/new.md", kind: "added", beforeSha256: null, afterSha256: "4".repeat(64), before: null, after: "New combined document", truncated: false, groupIds: ["council"] }],
      assertions: [{ id: "new-claim", kind: "activated", body: claim, groupIds: ["council"] },
        { id: "old-claim", kind: "deactivated", body: { ...claim, polarity: "negative", applicability: { kind: "point", axisDefinitionDigest: "8".repeat(64), position: { kind: "boundedUnknown", lowerInclusive: "1441-01-01", upperExclusive: "1442-01-01" } } }, groupIds: ["council"] }] },
    diagnostics: [{ code: "RECEIPT_NOTE", severity: validity === "invalid" ? "error" : "warning", groupIds: ["council"], assertionIds: ["new-claim"], message: "Service diagnostic only" }],
    limitations: ["Only explicit opposition is checked; this does not establish all history.", "LIMITATION-END"],
  };
  return {
    format: "wmm.workspace-view/1",
    workspace: { format: "wmm.workspace/1", id: "succession", version: 7, title: "Succession choices", worldTitle: "Valen", goal: "Continuity", mode: "world",
      base: { worldId: "valen", snapshotDigest: review.binding.baseSnapshotDigest },
      proposals: [{ id: "council", version: 2, title: "Establish a council", author: "Human", rationale: "Protect continuity", dependencies: [], exclusions: [],
        operations: [{ kind: "write-prose", path: "prose/council.md", beforeSha256: "a".repeat(64), text: "OPERATION MUST NOT BE USED AS COMBINED DIFF" }], decision: "selected", rejectionReason: null },
        { id: "regency", version: 1, title: "Negotiate a regency", author: "Human", rationale: "Other intent", dependencies: [], exclusions: [], operations: [], decision: "undecided", rejectionReason: null }],
      pins: [], direction: "Prefer peace", history: [] },
    documents: [{ path: "prose/council.md", sha256: "a".repeat(64), text: "Base prose", truncated: false }],
    records: [{ id: "council-entity", kind: "entity", title: "Interim council", summary: "A named council" },
      { id: "realm", kind: "entity", title: "Kingdom of Valen", summary: "The realm" },
      { id: "9".repeat(64), kind: "predicate", title: "governs", summary: "Governing relation" },
      { id: "new-claim", kind: "active assertion", title: "Council governance", summary: "Unused descriptor summary" }],
    changes: [{ groupId: "council", representation: "mixed", before: ["PER-GROUP BEFORE"], proposed: ["PER-GROUP AFTER"] }],
    prerequisites: [{ groupId: "council", required: [], missing: [], rejected: [] }, { groupId: "regency", required: [], missing: [], rejected: [] }],
    selection: { requested: ["council"], required: ["council"], missing: [], rejectedRequired: [], diagnostics: [] },
    validation: { status: "current", message: "Service receipt available." }, review, approval: "unavailable", canon: "unchanged",
  };
}
function harness(initial = fixture()) {
  const read = vi.fn<WorkspaceClient["read"]>(() => initial);
  const mutate = vi.fn<WorkspaceClient["mutate"]>(() => initial);
  const review = vi.fn<NonNullable<WorkspaceClient["review"]>>(() => initial);
  const client = { read, mutate, review };
  const controller = new WorkspaceController(client, initial, () => "ui-key");
  return { controller, client, read, mutate, review };
}
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 40); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("combined review receipt presentation", () => {
  it.each(["valid", "invalid", "undetermined"] as const)("keeps completed execution separate from %s bounded validity", validity => {
    const view = fixture(validity);
    const text = reviewLines(view, 120).join("\n");
    expect(text).toContain("CURRENT RECEIPT — workspace v7");
    expect(text).toContain("Execution: completed");
    expect(text).toContain(`Validity: ${validity}`);
    expect(text).toContain(validity === "valid" ? "Valid for bounded checks" : validity === "invalid" ? "Invalid for bounded checks" : "Undetermined for bounded checks");
    expect(text).toContain("not proof that all history is true");
    for (const check of view.review!.checks) expect(text).toContain(`${check.id}: ${check.status}`);
    expect(text).toContain("Service diagnostic only");
    expect(text).toContain("LIMITATION-END");
    expect(text).toContain("Approval: unavailable");
    expect(text).toContain("Canon: unchanged");
  });

  it("reads the combined document diff, claim bodies and provenance instead of deriving proposal effects", () => {
    const view = fixture();
    const before = JSON.stringify(view);
    const text = reviewLines(view, 120).join("\n");
    for (const content of ["COMBINED DOCUMENT DIFF", "Combined BEFORE from receipt", "Combined AFTER from receipt", "Document absent in base.",
      "New combined document", "SERVICE EXCERPT TRUNCATED", "ACTIVATED / ACTIVE IN CANDIDATE: Council governance", "DEACTIVATED IN CANDIDATE: old-claim",
      "Positive claim: Interim council — governs — Kingdom of Valen", "Negative claim:", "1442-06-01", "1443-01-01", "1441-01-01", "Groups: Establish a council", "proposal v2 (receipt)"])
      expect(text).toContain(content);
    expect(text).not.toContain("OPERATION MUST NOT");
    expect(text).not.toContain("PER-GROUP AFTER");
    expect(text).not.toContain("Unused descriptor summary");
    expect(text).not.toContain("9".repeat(64));
    expect(JSON.stringify(view)).toBe(before);
  });

  it("renders existential/literal claims and unknown/unbounded timing without interpreting them", () => {
    const view = fixture();
    const receipt = view.review!;
    const body: ClaimBodyV1 = { ...receipt.diff.assertions[0]!.body,
      proposition: { kind: "exists", population: { descriptorId: "realm", definitionDigest: "5".repeat(64) },
        criterion: { definitionDigest: "6".repeat(64), arguments: { date: { kind: "literal", valueDefinitionDigest: "7".repeat(64), data: "1444-02-03" } } } },
      applicability: { kind: "interval", axisDefinitionDigest: "8".repeat(64), start: { kind: "unboundedPast" }, endExclusive: { kind: "unboundedFuture" } } };
    const text = reviewLines({ ...view, review: { ...receipt, diff: { ...receipt.diff, assertions: [{ ...receipt.diff.assertions[0]!, body }] } } }, 120).join("\n");
    expect(text).toContain("Exists in Kingdom of Valen");
    expect(text).toContain("date: 1444-02-03");
    expect(text).toContain("unbounded past, unbounded future");
  });

  it("uses service validity even when checks do not imply it", () => {
    const view = fixture("undetermined");
    const review = { ...view.review!, checks: view.review!.checks.map(check => ({ ...check, status: "passed" as const })) };
    expect(reviewLines({ ...view, review }, 120).join("\n")).toContain("Validity: undetermined");
    expect(reviewLines({ ...view, review }, 120).join("\n")).not.toContain("Valid for bounded checks");
  });

  it("annotates an old receipt after an acknowledged edit and separates current selected intent", () => {
    const initial = fixture();
    const next: WorkspaceViewV1 = { ...initial, workspace: { ...initial.workspace, version: 8,
      proposals: initial.workspace.proposals.map(group => ({ ...group, decision: group.id === "regency" ? "selected" : "undecided" })) },
      selection: { ...initial.selection, requested: ["regency"] }, validation: { status: "stale", message: "Workspace edited since review." } };
    const { controller, mutate } = harness(initial);
    mutate.mockReturnValue(next);
    controller.input("n"); controller.paste("New direction"); controller.input("s", { ctrl: true }); controller.input("v");
    const text = reviewLines(controller.getSnapshot().view, 120).join("\n");
    expect(text).toContain("STALE RECEIPT — workspace v7; current workspace v8. NOT CURRENT.");
    expect(text).toContain("Previous validity: valid — not a current result");
    expect(text).not.toContain("Valid for bounded checks");
    expect(text).toContain("CURRENT SELECTED INTENT — NOT A RECEIPT\nNegotiate a regency");
    expect(text).toContain("PREVIOUS RECEIPT / NOT CURRENT: SELECTED GROUPS / PROVENANCE\nEstablish a council");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 80, 24)).toContain("STALE v7 (now v8)");
  });

  it.each([
    ["workspaceId", "other-workspace"], ["workspaceVersion", 6], ["worldId", "other-world"], ["baseSnapshotDigest", "0".repeat(64)],
  ] as const)("never displays a current receipt with a mismatched %s", (key, value) => {
    const view = fixture();
    const binding: WorkspaceReviewBindingV1 = { ...view.review!.binding, [key]: value };
    const mismatched = { ...view, review: { ...view.review!, binding } };
    expect(reviewStatus(mismatched)).toBe("stale");
    expect(reviewLines(mismatched, 120).join("\n")).not.toContain("Valid for bounded checks");
    expect(renderWorkspacePlain(mismatched)).toContain("NOT CURRENT");
  });

  it("displays the service-bound profile, short candidate normally, and full receipt identifiers under d", () => {
    const view = fixture();
    const { controller, review } = harness(view);
    controller.input("v");
    const normal = reviewLines(view, 120).join("\n");
    expect(normal).toContain(`Candidate digest: ${"c".repeat(12)}…`);
    expect(normal).toContain(`Semantic profile (service binding): ${"f".repeat(12)}…`);
    expect(normal).not.toContain(view.review!.candidateDigest);
    controller.input("d");
    let raw = "";
    for (let i = 0; i < 65; i++) { raw += renderWorkspaceScreen(controller.getSnapshot(), 120, 36); controller.input("", { pageDown: true }); }
    for (const identifier of [view.review!.candidateDigest, view.review!.candidateSnapshotDigest!, view.review!.evaluationDigest,
      view.review!.binding.semanticProfileDigest, view.review!.binding.operationsDigest, view.review!.binding.steeringDigest]) expect(raw).toContain(identifier);
    expect(raw).toContain('"workspaceVersion": 7');
    expect(review).not.toHaveBeenCalled();
  });

  it.each([[80, 24], [100, 30], [120, 36]])("keeps review widths, scrolling and buffers at %ix%i", (columns, rows) => {
    const { controller } = harness();
    controller.input("v");
    let text = "";
    for (let i = 0; i < 45; i++) {
      let limit = Number.POSITIVE_INFINITY;
      const screen = renderWorkspaceScreen(controller.getSnapshot(), columns, rows, value => { limit = value; });
      controller.setScrollLimit(limit);
      expect(screen.split("\n")).toHaveLength(rows - 1);
      expect(screen.split("\n").every(line => cells(line) < columns)).toBe(true);
      text += screen;
      controller.input("", { pageDown: true });
    }
    expect(text).toContain("c: build/check combined selection");
    expect(text).toContain("Combined AFTER from receipt");
    expect(text).toContain("LIMITATION-END");
    const end = controller.getSnapshot().scroll;
    controller.input("", { pageUp: true });
    expect(controller.getSnapshot().scroll).toBeLessThan(end);
    controller.input("n"); controller.paste("Unsaved c 👩🏽‍💻");
    const form = controller.getSnapshot().modal;
    for (const width of [80, 100, 120, 80]) renderWorkspaceScreen(controller.getSnapshot(), width, rows);
    expect(controller.getSnapshot().modal).toBe(form);
  });

  it("keeps plain output linear, terminal-safe and bounded in authority", () => {
    const initial = fixture("invalid");
    const view = { ...initial, review: { ...initial.review!, limitations: ["\x1b[32mNOT GREEN\x1b[0m\u202e\x07"] } };
    const text = renderWorkspacePlain(view);
    expect(text).toContain("Validity: invalid");
    expect(text).toContain("Combined AFTER from receipt");
    expect(text).toContain("NOT GREEN");
    expect(text).toContain("Plain output never runs checks");
    expect(text).not.toMatch(/[\x1b\x07\u202e]/);
  });
});

describe("explicit review gateway and failure isolation", () => {
  it("calls only review with the exact displayed version on c in Review; navigation never evaluates", () => {
    const { controller, review, read, mutate } = harness();
    controller.input("c"); controller.input("v"); controller.input("5"); controller.input("", { return: true }); controller.input("d");
    expect(review).not.toHaveBeenCalled();
    controller.input("c");
    expect(review.mock.calls).toEqual([[7]]);
    expect(read).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toContain("execution completed");
    controller.input("approve"); controller.input("commit"); controller.input("y");
    expect(review).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("discards a late older review and an older refresh without overwriting newer diagnostics or a buffer", () => {
    const older = fixture();
    const latest: WorkspaceViewV1 = { ...older, workspace: { ...older.workspace, version: 9 }, validation: { status: "stale", message: "Edited" },
      selection: { ...older.selection, diagnostics: [{ code: "LATEST_ONLY", groupIds: ["council"], message: "Do not overwrite newer diagnostics" }] } };
    const { controller, review, read, mutate } = harness(older);
    mutate.mockReturnValue(latest);
    let retained: unknown;
    review.mockImplementation(() => {
      controller.input("n"); controller.paste("Saved during review"); controller.input("s", { ctrl: true });
      controller.input("n"); controller.paste("UNSAVED BUFFER c"); controller.input("", { leftArrow: true });
      retained = controller.getSnapshot().modal;
      return older;
    });
    read.mockReturnValue(older);
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(latest);
    expect(controller.getSnapshot().view.selection.diagnostics[0]!.code).toBe("LATEST_ONLY");
    expect(controller.getSnapshot().modal).toBe(retained);
    expect(controller.getSnapshot().status).toContain("Older or mismatched review view discarded");
    expect(controller.getSnapshot().reviewFailure).toContain("Refresh was also older");
    expect(review.mock.calls).toEqual([[7]]);
    expect(read.mock.calls).toEqual([[]]);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("refreshes an older review once, without automatic resubmission", () => {
    const current = fixture();
    const older: WorkspaceViewV1 = { ...current, workspace: { ...current.workspace, version: 6 } };
    const { controller, review, read, mutate } = harness(current);
    review.mockReturnValue(older);
    const refreshed: WorkspaceViewV1 = { ...current, workspace: { ...current.workspace, version: 8 }, validation: { status: "stale", message: "Latest state" } };
    read.mockReturnValue(refreshed);
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(refreshed);
    expect(controller.getSnapshot().status).toContain("No resubmission");
    expect(review).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps state unchanged and explicitly incomplete on review error (stale=%s)", stale => {
    const initial = fixture();
    const { controller, review, read, mutate } = harness(initial);
    review.mockImplementation(() => { throw Object.assign(new Error("Review service failed"), { code: stale ? "STALE_WORKSPACE" : "STORAGE_FAILURE" }); });
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(initial);
    const screen = renderWorkspaceScreen(controller.getSnapshot(), 100, 30);
    expect(screen).toContain("REVIEW FAILED / INCOMPLETE");
    expect(screen).toContain("Review service failed");
    expect(screen).not.toContain("Valid for bounded checks");
    expect(screen).not.toContain("Validation: CURRENT");
    expect(controller.getSnapshot().status).not.toContain("execution completed");
    expect(read).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("reports refresh failure without replacing state or retrying review", () => {
    const current = fixture();
    const { controller, review, read } = harness(current);
    review.mockReturnValue({ ...current, workspace: { ...current.workspace, version: 6 } });
    read.mockImplementation(() => { throw new Error("Read unavailable"); });
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(current);
    expect(controller.getSnapshot().reviewFailure).toContain("Refresh failed: Read unavailable");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("rejects a nominally completed response with no matching current receipt", () => {
    const initial = fixture();
    const { controller, review } = harness(initial);
    review.mockReturnValue({ ...initial, review: { ...initial.review!, binding: { ...initial.review!.binding, workspaceId: "foreign" } } });
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(initial);
    expect(controller.getSnapshot().reviewFailure).toContain("no current, matching receipt");
    expect(renderWorkspaceScreen(controller.getSnapshot(), 100, 30)).not.toContain("Valid for bounded checks");
  });

  it("supports older clients without review as NOT RUN with an explicit hint", () => {
    const { review: _receipt, ...base } = fixture();
    const initial: WorkspaceViewV1 = { ...base, validation: { status: "not-run", message: "Checks not run" } };
    const read = vi.fn(() => initial);
    const mutate = vi.fn(() => initial);
    const controller = new WorkspaceController({ read, mutate }, initial);
    controller.input("v"); controller.input("c");
    expect(controller.getSnapshot().view).toBe(initial);
    expect(controller.getSnapshot().status).toContain("NOT RUN");
    expect(controller.getSnapshot().status).toContain("WorkspaceClient.review");
    const text = renderWorkspaceScreen(controller.getSnapshot(), 100, 30);
    expect(text).toContain("Validation: NOT RUN");
    expect(text).toContain("older client");
    expect(read).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });

  it("does not run c in forms, dialogs, help, non-Review tabs, or paste", () => {
    const { controller, review } = harness();
    controller.input("c"); controller.input("v"); controller.paste("c"); controller.input("cc");
    controller.input("pasted c"); controller.input("?"); controller.input("c"); controller.input("", { escape: true });
    controller.input("n"); controller.input("c"); controller.paste("c");
    const form = controller.getSnapshot().modal;
    expect(form?.kind).toBe("form");
    if (form?.kind === "form") expect(form.fields[0]!.buffer.text).toContain("cc");
    controller.input("", { escape: true }); controller.input("2"); controller.input("p");
    expect(controller.getSnapshot().modal?.kind).toBe("choice");
    controller.input("c");
    expect(review).not.toHaveBeenCalled();
  });

  it("isolates actual Ink typing and single-character/split bracketed paste from review shortcuts", async () => {
    const { controller, review, mutate } = harness();
    controller.input("v");
    const app = render(createElement(WorkspaceEditor, { controller, columns: 100, rows: 30 }));
    await settle();
    app.stdin.write("\x1b[200~c\x1b[201~"); await settle();
    app.stdin.write("\x1b[20"); await settle(); app.stdin.write("0~c\x1b[20"); await settle(); app.stdin.write("1~"); await settle();
    expect(review).not.toHaveBeenCalled();
    app.stdin.write("n"); await settle(); app.stdin.write("c"); await settle(); app.stdin.write("\x1b[200~c\x1b[201~"); await settle();
    const form = controller.getSnapshot().modal;
    expect(form?.kind).toBe("form");
    if (form?.kind === "form") expect(form.fields[0]!.buffer.text).toContain("cc");
    expect(review).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    app.stdin.write("\x1b"); await settle(); app.stdin.write("c"); await settle();
    expect(review.mock.calls).toEqual([[7]]);
  });
});
