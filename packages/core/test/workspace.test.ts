import { describe, expect, it } from "vitest";

import type {
  AssertionRecordV1,
  ProposalGroupV1,
  WorkspaceActionV1,
  WorkspaceOperationV1,
  WorkspacePinV1,
  WorkspaceStateV1,
} from "@wmm/wire-contracts";
import {
  applyWorkspaceAction,
  WorkspaceActionError,
  workspacePrerequisites,
  workspaceSelection,
} from "../src/index.js";

type ProposalInput = Extract<WorkspaceActionV1, { kind: "put-proposal" }>["proposal"];
const digest = "a".repeat(64);
const assertionId = `asrt:${digest}` as const;
const documentPin: WorkspacePinV1 = {
  id: "neutrality-document", kind: "document", path: "prose/neutrality.md", sha256: digest, active: true,
};
const assertionPin: WorkspacePinV1 = {
  id: "neutrality-assertion", kind: "assertion", assertionId, active: true,
};
const assertion: AssertionRecordV1 = {
  format: "wmm.assertion-record/1", id: assertionId,
  body: {
    format: "wmm.claim/1", worldId: "world:workspace", semanticProfileDigest: digest,
    proposition: { kind: "atom", subjectId: "realm:neighbor", predicateDefinitionDigest: digest, value: { kind: "ref", id: "policy:neutrality" } },
    polarity: "positive",
    scope: { account: { kind: "notApplicable" }, jurisdiction: { kind: "notApplicable" }, recognitionFrame: { kind: "notApplicable" } },
    applicability: { kind: "invariant" },
  },
};

function write(path = "prose/neutrality.md", body = "The neighboring realm intervenes."): WorkspaceOperationV1 {
  return { kind: "write-prose", path, text: body, beforeSha256: digest };
}

function proposal(id: string, overrides: Partial<ProposalGroupV1> = {}): ProposalGroupV1 {
  return {
    id, version: 1, title: id, author: "author", rationale: "An explicit proposal.",
    dependencies: [], exclusions: [], operations: [write(`prose/${id}.md`, id)],
    decision: "undecided", rejectionReason: null, ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceStateV1> = {}): WorkspaceStateV1 {
  return {
    format: "wmm.workspace/1", id: "workspace:succession", version: 1,
    title: "Succession", worldTitle: "The succession world", goal: "Explore a disputed succession.",
    mode: "succession-demo", base: { worldId: "world:workspace", snapshotDigest: digest },
    proposals: [
      proposal("death"),
      proposal("council", { dependencies: ["death"], exclusions: ["coup"] }),
      proposal("coup", { dependencies: ["death"], exclusions: ["council"] }),
      proposal("intervention", { operations: [write()] }),
    ],
    pins: [], direction: "", history: [], ...overrides,
  };
}

function group(state: WorkspaceStateV1, id: string): ProposalGroupV1 {
  const found = state.proposals.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Missing test proposal: ${id}`);
  return found;
}

function input(state: WorkspaceStateV1, id: string, overrides: Partial<ProposalInput> = {}): ProposalInput {
  const { version: _version, decision: _decision, rejectionReason: _reason, ...value } = group(state, id);
  return { ...value, ...overrides };
}

function expectInvalid(action: () => unknown): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WorkspaceActionError);
  expect(caught).toMatchObject({ name: "WorkspaceActionError", code: "INVALID_WORKSPACE_ACTION" });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("pure workspace selection and prerequisites", () => {
  it("defaults to selected IDs and includes explicit roots in the transitive closure", () => {
    const state = workspace({ proposals: [
      proposal("regency", { decision: "selected", dependencies: ["council", "death"] }),
      proposal("death"), proposal("council", { dependencies: ["death"] }), proposal("unused"),
    ] });
    const before = structuredClone(state);
    expect(workspaceSelection(state)).toEqual({
      requested: ["regency"], required: ["council", "death", "regency"],
      missing: ["council", "death"], rejectedRequired: [],
      diagnostics: [{ code: "MISSING_PREREQUISITE", groupIds: ["council", "death"], message: expect.any(String) }],
    });
    expect(workspaceSelection(state, ["death", "regency", "council", "death"])).toEqual({
      requested: ["council", "death", "regency"], required: ["council", "death", "regency"],
      missing: [], rejectedRequired: [], diagnostics: [],
    });
    expect(workspaceSelection(state, [])).toEqual({ requested: [], required: [], missing: [], rejectedRequired: [], diagnostics: [] });
    expect(state).toEqual(before);
  });

  it("computes missing against the requested set rather than the current decisions", () => {
    const state = workspace({ proposals: [proposal("death", { decision: "selected" }), proposal("council", { dependencies: ["death"] })] });
    expect(workspaceSelection(state, ["council"]).missing).toEqual(["death"]);
    expect(workspaceSelection(state, ["death", "council"]).missing).toEqual([]);
  });

  it("reports rejected transitive prerequisites without restoring them", () => {
    const state = workspace({ proposals: [
      proposal("regency", { decision: "selected", dependencies: ["council"] }),
      proposal("council", { dependencies: ["death"] }),
      proposal("death", { decision: "rejected", rejectionReason: "Keep the sovereign alive." }),
    ] });
    expect(workspaceSelection(state)).toMatchObject({ missing: ["council", "death"], rejectedRequired: ["death"] });
    expect(workspacePrerequisites(state)).toEqual([
      { groupId: "regency", required: ["council", "death"], missing: ["council", "death"], rejected: ["death"] },
      { groupId: "council", required: ["death"], missing: ["death"], rejected: ["death"] },
      { groupId: "death", required: [], missing: [], rejected: [] },
    ]);
    expect(group(state, "death").decision).toBe("rejected");
  });

  it("uses current explicit selections for per-group missing prerequisites", () => {
    const state = workspace({ proposals: [
      proposal("regency", { dependencies: ["council", "death"] }),
      proposal("death", { decision: "selected" }), proposal("council", { dependencies: ["death"] }),
    ] });
    expect(workspacePrerequisites(state)[0]).toEqual({ groupId: "regency", required: ["council", "death"], missing: ["council"], rejected: [] });
  });

  it("diagnoses asymmetric exclusions only when both groups are explicitly requested", () => {
    const state = workspace({ proposals: [
      proposal("regency", { dependencies: ["council"], exclusions: ["council"] }), proposal("council"),
    ] });
    expect(workspaceSelection(state, ["regency"]).diagnostics.map((item) => item.code)).toEqual(["MISSING_PREREQUISITE"]);
    expect(workspaceSelection(state, ["regency", "council"]).diagnostics).toEqual([
      { code: "INCOMPATIBLE_ALTERNATIVES", groupIds: ["council", "regency"], message: expect.any(String) },
    ]);
  });

  it("keeps diagnostics bounded and canonical even for densely conflicting selections", () => {
    const ids = Array.from({ length: 256 }, (_, index) => `group-${index}`);
    const state = workspace({ proposals: ids.map((id) => proposal(id, { decision: "selected", exclusions: ids.filter((other) => other !== id) })) });
    const selection = workspaceSelection(state);
    expect(selection.requested).toEqual([...ids].sort());
    expect(selection.diagnostics).toEqual([
      { code: "INCOMPATIBLE_ALTERNATIVES", groupIds: [...ids].sort(), message: expect.any(String) },
    ]);
  });

  it("reports actual supported operations against active pins, not explanatory prose", () => {
    const state = workspace({
      pins: [documentPin, assertionPin],
      proposals: [
        proposal("document", { decision: "selected", operations: [write()] }),
        proposal("assertion", { decision: "selected", operations: [{ kind: "deactivate-assertion", assertionId }] }),
        proposal("explanation", { decision: "selected", rationale: "Change prose/neutrality.md and reject neutrality.", operations: [] }),
        proposal("unselected", { operations: [write()] }),
      ],
    });
    expect(workspaceSelection(state).diagnostics).toEqual([
      { code: "DRAFT_PIN_CHANGE", groupIds: ["assertion", "document"], message: expect.any(String) },
    ]);
    expect(workspaceSelection({ ...state, pins: state.pins.map((pin) => ({ ...pin, active: false })) }).diagnostics).toEqual([]);
  });

  it("does not mistake a matching before hash for proof that a pinned document write is a no-op", () => {
    const state = workspace({ pins: [documentPin], proposals: [proposal("write", { decision: "selected", operations: [write()] })] });
    expect(workspaceSelection(state).diagnostics[0]?.code).toBe("DRAFT_PIN_CHANGE");
    const elsewhere = { ...state, proposals: [proposal("elsewhere", { decision: "selected", operations: [write("prose/elsewhere.md")] })] };
    expect(workspaceSelection(elsewhere).diagnostics).toEqual([]);
  });

  it("defers assertion tuple comparison to the base-bound application and never claims historical validity", () => {
    const opposite: AssertionRecordV1 = { ...assertion, id: `asrt:${"b".repeat(64)}`, body: { ...assertion.body, polarity: "negative" } };
    const state = workspace({ pins: [assertionPin], proposals: [proposal("opposite", { decision: "selected", operations: [{ kind: "activate-assertion", assertion: opposite }] })] });
    expect(workspaceSelection(state)).toEqual({ requested: ["opposite"], required: ["opposite"], missing: [], rejectedRequired: [], diagnostics: [] });
    expect(workspaceSelection(state)).not.toHaveProperty("validation");
    expect(workspaceSelection(state)).not.toHaveProperty("valid");
  });
});

describe("explicit workspace decisions", () => {
  it("selects a group alone without closing dependencies, then reports its blockers", () => {
    const initial = workspace();
    const selected = applyWorkspaceAction(initial, { kind: "decide", groupId: "council", decision: "selected" });
    expect(group(selected, "council").decision).toBe("selected");
    expect(group(selected, "death").decision).toBe("undecided");
    expect(workspaceSelection(selected).missing).toEqual(["death"]);
    const rejected = applyWorkspaceAction(selected, { kind: "decide", groupId: "death", decision: "rejected" });
    expect(group(rejected, "council").decision).toBe("selected");
    expect(workspaceSelection(rejected).rejectedRequired).toEqual(["death"]);
  });

  it("replaces only the explicit selected set, retaining rejected groups and their reasons", () => {
    let state = applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["death", "council"] });
    state = applyWorkspaceAction(state, { kind: "decide", groupId: "coup", decision: "rejected", reason: "No military takeover." });
    state = applyWorkspaceAction(state, { kind: "select", groupIds: ["council", "council"] });
    expect(state.proposals.map((item) => [item.id, item.decision])).toEqual([
      ["death", "undecided"], ["council", "selected"], ["coup", "rejected"], ["intervention", "undecided"],
    ]);
    expect(group(state, "coup").rejectionReason).toBe("No military takeover.");
    const empty = applyWorkspaceAction(state, { kind: "select", groupIds: [] });
    expect(workspaceSelection(empty).requested).toEqual([]);
    expect(group(empty, "coup").decision).toBe("rejected");
  });

  it.each([undefined, "", "Keep the sovereign alive."])("requires restoration and preserves rejection reason %j", (reason) => {
    const action: WorkspaceActionV1 = { kind: "decide", groupId: "death", decision: "rejected", ...(reason === undefined ? {} : { reason }) };
    const rejected = applyWorkspaceAction(workspace(), action);
    expect(group(rejected, "death").rejectionReason).toBe(reason ?? null);
    expectInvalid(() => applyWorkspaceAction(rejected, { kind: "decide", groupId: "death", decision: "selected" }));
    expectInvalid(() => applyWorkspaceAction(rejected, { kind: "select", groupIds: ["death", "council"] }));
    const restored = applyWorkspaceAction(rejected, { kind: "decide", groupId: "death", decision: "undecided" });
    expect(group(restored, "death")).toMatchObject({ decision: "undecided", rejectionReason: reason ?? null });
    expect(workspaceSelection(restored).requested).toEqual([]);
    const selected = applyWorkspaceAction(restored, { kind: "select", groupIds: ["death"] });
    expect(group(selected, "death")).toMatchObject({ decision: "selected", rejectionReason: reason ?? null });
    const rejectedAgain = applyWorkspaceAction(selected, { kind: "decide", groupId: "death", decision: "rejected" });
    expect(group(rejectedAgain, "death").rejectionReason).toBe(reason ?? null);
  });

  it("allows an explicitly incompatible draft but reports it instead of silently resolving it", () => {
    const state = applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["death", "council", "coup"] });
    expect(workspaceSelection(state).requested).toEqual(["council", "coup", "death"]);
    expect(workspaceSelection(state).diagnostics.map((item) => item.code)).toEqual(["INCOMPATIBLE_ALTERNATIVES"]);
  });

  it("appends one exact versioned action, including explicit no-op decisions", () => {
    const initial = workspace();
    const action = { kind: "decide", groupId: "death", decision: "undecided" } as const;
    const next = applyWorkspaceAction(initial, action);
    const again = applyWorkspaceAction(next, action);
    expect(next.version).toBe(2);
    expect(again.version).toBe(3);
    expect(again.history).toEqual([{ version: 2, action }, { version: 3, action }]);
    expect(group(again, "death").version).toBe(1);
    expect(initial.history).toEqual([]);
  });

  it("rejects unknown IDs and unsupported action kinds with the domain error", () => {
    expectInvalid(() => workspaceSelection(workspace(), ["missing"]));
    expectInvalid(() => applyWorkspaceAction(workspace(), { kind: "decide", groupId: "missing", decision: "selected" }));
    expectInvalid(() => applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["missing"] }));
    expectInvalid(() => applyWorkspaceAction(workspace(), { kind: "approve" } as unknown as WorkspaceActionV1));
  });
});

describe("proposal versions and graph invariants", () => {
  it("appends a new undecided version-one proposal in authored order with canonical references", () => {
    const state = applyWorkspaceAction(workspace(), { kind: "put-proposal", proposal: {
      id: "regency", title: "  A regency  ", author: "author", rationale: "A human-authored reason.",
      dependencies: ["death", "council", "death"], exclusions: ["intervention", "coup", "coup"], operations: [],
    } });
    expect(state.proposals.map((item) => item.id)).toEqual(["death", "council", "coup", "intervention", "regency"]);
    expect(group(state, "regency")).toMatchObject({
      title: "A regency", version: 1, decision: "undecided", rejectionReason: null,
      dependencies: ["council", "death"], exclusions: ["coup", "intervention"],
    });
  });

  it("keeps selection for explanatory-only revisions, including reordered object members and ID sets", () => {
    const initial = workspace({ proposals: [
      proposal("council", { decision: "selected", dependencies: ["death", "intervention"], exclusions: ["coup"], operations: [write()] }),
      proposal("death"), proposal("intervention"), proposal("coup"),
    ] });
    const revised = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "council", {
      title: "  The council  ", rationale: "Reworded explanation.", author: "editor",
      dependencies: ["intervention", "death", "death"], exclusions: ["coup", "coup"],
      operations: [{ beforeSha256: digest, text: "The neighboring realm intervenes.", path: "prose/neutrality.md", kind: "write-prose" }],
    }) });
    expect(group(revised, "council")).toMatchObject({ version: 2, decision: "selected", title: "The council", rationale: "Reworded explanation." });
    expect(revised.proposals.map((item) => item.id)).toEqual(initial.proposals.map((item) => item.id));
  });

  it.each([
    { operations: [write("prose/new.md")] },
    { operations: [write("prose/council.md", "Revised content.")] },
    { operations: [{ kind: "write-prose", path: "prose/council.md", text: "council", beforeSha256: null }] },
    { dependencies: ["death", "intervention"] },
    { exclusions: [] },
  ] satisfies Partial<ProposalInput>[])("resets selected to undecided for executable revision %j", (change) => {
    const selected = applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["council", "death"] });
    const revised = applyWorkspaceAction(selected, { kind: "put-proposal", proposal: input(selected, "council", change) });
    expect(group(revised, "council")).toMatchObject({ version: 2, decision: "undecided" });
    expect(group(revised, "death").decision).toBe("selected");
  });

  it("compares full assertion bodies and respects operation ordering", () => {
    const activation: WorkspaceOperationV1 = { kind: "activate-assertion", assertion };
    const initial = workspace({ proposals: [proposal("claim", { decision: "selected", operations: [activation, write()] })] });
    const reordered = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "claim", { operations: [write(), activation] }) });
    expect(group(reordered, "claim").decision).toBe("undecided");
    const changed = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "claim", {
      operations: [{ kind: "activate-assertion", assertion: { ...assertion, body: { ...assertion.body, polarity: "negative" } } }, write()],
    }) });
    expect(group(changed, "claim").decision).toBe("undecided");
  });

  it.each(["", "No coup."])("preserves rejected status and original reason %j through executable revisions", (reason) => {
    const rejected = applyWorkspaceAction(workspace(), { kind: "decide", groupId: "coup", decision: "rejected", reason });
    const revised = applyWorkspaceAction(rejected, { kind: "put-proposal", proposal: input(rejected, "coup", { operations: [] }) });
    expect(group(revised, "coup")).toMatchObject({ version: 2, decision: "rejected", rejectionReason: reason });
    expectInvalid(() => applyWorkspaceAction(revised, { kind: "select", groupIds: ["coup"] }));
  });

  it("advances proposal versions even for identical revisions without changing the decision", () => {
    const initial = workspace();
    const next = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "death") });
    expect(group(next, "death")).toEqual({ ...group(initial, "death"), version: 2 });
  });

  it.each([
    { dependencies: ["missing"] }, { exclusions: ["missing"] },
    { dependencies: ["regency"] }, { exclusions: ["regency"] },
  ])("rejects new proposals with missing or self references: %j", (change) => {
    expectInvalid(() => applyWorkspaceAction(workspace(), { kind: "put-proposal", proposal: { ...input(workspace(), "death"), id: "regency", ...change } }));
  });

  it("rejects a revision that introduces a dependency cycle without touching the input", () => {
    const initial = workspace();
    const before = structuredClone(initial);
    expectInvalid(() => applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "death", { dependencies: ["council"] }) }));
    expect(initial).toEqual(before);
  });

  it.each([
    [proposal("duplicate"), proposal("duplicate")],
    [proposal("self", { dependencies: ["self"] })],
    [proposal("self", { exclusions: ["self"] })],
    [proposal("missing", { dependencies: ["absent"] })],
    [proposal("missing", { exclusions: ["absent"] })],
    [proposal("a", { dependencies: ["b"] }), proposal("b", { dependencies: ["a"] })],
  ])("rejects malformed existing proposal graphs", (...proposals) => {
    const state = workspace({ proposals });
    expectInvalid(() => workspaceSelection(state));
    expectInvalid(() => workspacePrerequisites(state));
    expectInvalid(() => applyWorkspaceAction(state, { kind: "set-direction", text: "No repair by unrelated action." }));
  });

  it("rejects duplicate pin identities", () => {
    const state = workspace({ pins: [documentPin, { ...assertionPin, id: documentPin.id }] });
    expectInvalid(() => workspaceSelection(state));
    expectInvalid(() => applyWorkspaceAction(state, { kind: "put-pin", pin: documentPin }));
  });
});

describe("demo alternatives, pins and advisory direction", () => {
  it("supports rejecting the coup, retaining the council, adding a regency, and preserving neutrality", () => {
    const initial = workspace();
    const actions: WorkspaceActionV1[] = [
      { kind: "select", groupIds: ["death", "council"] },
      { kind: "decide", groupId: "coup", decision: "rejected", reason: "Prefer a negotiated settlement." },
      { kind: "add-regency", title: "  Negotiate a regency  ", rationale: "The council negotiates a regency." },
      { kind: "select", groupIds: ["regency", "council", "death"] },
      { kind: "put-pin", pin: documentPin },
      { kind: "put-pin", pin: assertionPin },
      { kind: "set-direction", text: "Avoid another war; this is advice, not a deterministic constraint." },
    ];
    const state = actions.reduce(applyWorkspaceAction, initial);
    expect(state.version).toBe(8);
    expect(state.history).toEqual(actions.map((action, index) => ({ version: index + 2, action })));
    expect(state.base).toEqual(initial.base);
    expect(workspaceSelection(state)).toMatchObject({ requested: ["council", "death", "regency"], missing: [], diagnostics: [] });
    expect(group(state, "coup")).toMatchObject({ decision: "rejected", rejectionReason: "Prefer a negotiated settlement." });
    expect(group(state, "regency")).toMatchObject({
      version: 1, decision: "selected", title: "Negotiate a regency", dependencies: ["council", "death"], exclusions: ["coup"],
      operations: [{ kind: "write-prose", path: "prose/developments/regency.md", beforeSha256: null, text: "# Negotiate a regency\n\nThe council negotiates a regency.\n" }],
    });
    expect(state.pins).toEqual([documentPin, assertionPin]);
    expect(state.direction).toBe(actions[6]?.kind === "set-direction" ? actions[6].text : "");
    expect(initial.version).toBe(1);
    expect(initial.proposals).toHaveLength(4);
  });

  it("does not select the regency or modify other decisions when adding the demo template", () => {
    const initial = applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["council"] });
    const state = applyWorkspaceAction(initial, { kind: "add-regency", title: "Regency", rationale: "Supplied body, not inferred effects." });
    expect(group(state, "regency").decision).toBe("undecided");
    expect(workspaceSelection(state).requested).toEqual(["council"]);
    expect(state.proposals.slice(0, 4)).toEqual(initial.proposals);
    expectInvalid(() => applyWorkspaceAction(state, { kind: "add-regency", title: "Another regency", rationale: "" }));
  });

  it("restricts the regency template to the seeded succession demo", () => {
    const action = { kind: "add-regency", title: "Regency", rationale: "" } as const;
    expectInvalid(() => applyWorkspaceAction(workspace({ mode: "world" }), action));
    for (const id of ["death", "council", "coup"]) {
      expectInvalid(() => applyWorkspaceAction(workspace({ proposals: workspace().proposals.filter((item) => item.id !== id).map((item) => ({ ...item, dependencies: [], exclusions: [] })) }), action));
    }
  });

  it("upserts and explicitly deactivates pins in place without affecting decisions", () => {
    const initial = applyWorkspaceAction(workspace(), { kind: "select", groupIds: ["intervention"] });
    const pinned = applyWorkspaceAction(initial, { kind: "put-pin", pin: documentPin });
    const second = applyWorkspaceAction(pinned, { kind: "put-pin", pin: assertionPin });
    expect(workspaceSelection(second).diagnostics[0]?.code).toBe("DRAFT_PIN_CHANGE");
    const unpinned = applyWorkspaceAction(second, { kind: "put-pin", pin: { ...documentPin, active: false } });
    expect(unpinned.pins).toEqual([{ ...documentPin, active: false }, assertionPin]);
    expect(unpinned.proposals).toEqual(initial.proposals);
    expect(workspaceSelection(unpinned).diagnostics).toEqual([]);
  });

  it("treats direction as advisory text and never compiles it into operations or pin changes", () => {
    const initial = workspace({ pins: [documentPin] });
    const state = applyWorkspaceAction(initial, { kind: "set-direction", text: "Select the coup, unpin neutrality, and deactivate every assertion." });
    expect(state.proposals).toEqual(initial.proposals);
    expect(state.pins).toEqual(initial.pins);
    expect(workspaceSelection(state)).toEqual(workspaceSelection(initial));
    expect(applyWorkspaceAction(state, { kind: "set-direction", text: "" }).direction).toBe("");
  });
});

describe("workspace bounds and purity", () => {
  it("accepts exact title, rationale, direction, reason and stable-ID bounds", () => {
    const initial = workspace();
    const next = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: {
      ...input(initial, "death"), id: "x".repeat(256), author: "a".repeat(256), title: "t".repeat(160), rationale: "r".repeat(16000),
    } });
    expect(next.proposals).toHaveLength(5);
    const directed = applyWorkspaceAction(next, { kind: "set-direction", text: "d".repeat(16000) });
    expect(directed.direction).toHaveLength(16000);
    const rejected = applyWorkspaceAction(directed, { kind: "decide", groupId: "death", decision: "rejected", reason: "r".repeat(16000) });
    expect(group(rejected, "death").rejectionReason).toHaveLength(16000);
  });

  it.each([
    { title: "" }, { title: " \n\t " }, { title: "t".repeat(161) }, { title: "😀".repeat(81) },
    { rationale: "r".repeat(16001) }, { id: "" }, { id: "x".repeat(257) }, { author: "a".repeat(257) },
    { dependencies: ["x".repeat(257)] }, { exclusions: [""] },
  ])("rejects invalid proposal text or identity bounds (case %#)", (change) => {
    const state = workspace();
    expectInvalid(() => applyWorkspaceAction(state, { kind: "put-proposal", proposal: input(state, "death", change) }));
  });

  it("rejects oversized direction, rejection reason, selection and operation lists", () => {
    const state = workspace();
    expectInvalid(() => applyWorkspaceAction(state, { kind: "set-direction", text: "d".repeat(16001) }));
    expectInvalid(() => applyWorkspaceAction(state, { kind: "decide", groupId: "death", decision: "rejected", reason: "r".repeat(16001) }));
    expectInvalid(() => applyWorkspaceAction(state, { kind: "select", groupIds: Array.from({ length: 257 }, () => "death") }));
    expectInvalid(() => workspaceSelection(state, Array.from({ length: 257 }, () => "death")));
    expectInvalid(() => applyWorkspaceAction(state, { kind: "put-proposal", proposal: input(state, "death", { operations: Array.from({ length: 257 }, () => write()) }) }));
  });

  it("allows the 256th proposal and revisions at capacity, but never a 257th proposal", () => {
    const initial = workspace({ proposals: Array.from({ length: 255 }, (_, index) => proposal(`group-${index}`)) });
    const full = applyWorkspaceAction(initial, { kind: "put-proposal", proposal: { ...input(initial, "group-0"), id: "last" } });
    expect(full.proposals).toHaveLength(256);
    expect(applyWorkspaceAction(full, { kind: "put-proposal", proposal: input(full, "last", { rationale: "Edited at capacity." }) }).proposals).toHaveLength(256);
    expectInvalid(() => applyWorkspaceAction(full, { kind: "put-proposal", proposal: { ...input(full, "last"), id: "overflow" } }));
    expectInvalid(() => workspaceSelection(workspace({ proposals: [...full.proposals, proposal("overflow")] })));
  });

  it("bounds pin count while allowing an existing pin to be changed at capacity", () => {
    const initial = workspace({ pins: Array.from({ length: 256 }, (_, index) => ({ ...documentPin, id: `pin-${index}` })) });
    expectInvalid(() => applyWorkspaceAction(initial, { kind: "put-pin", pin: documentPin }));
    const next = applyWorkspaceAction(initial, { kind: "put-pin", pin: { ...documentPin, id: "pin-0", active: false } });
    expect(next.pins).toHaveLength(256);
    expect(next.pins[0]?.active).toBe(false);
  });

  it("allows the 2000th history entry and rejects further actions without truncating history", () => {
    const action = { kind: "set-direction", text: "advice" } as const;
    const initial = workspace({ version: 2000, history: Array.from({ length: 1999 }, (_, index) => ({ version: index + 2, action })) });
    const full = applyWorkspaceAction(initial, action);
    expect(full.history).toHaveLength(2000);
    expect(full.history[1999]).toEqual({ version: 2001, action });
    expect(full.history.slice(0, 1999)).toEqual(initial.history);
    expectInvalid(() => applyWorkspaceAction(full, action));
  });

  it("rejects unsafe workspace or proposal version increments", () => {
    expectInvalid(() => applyWorkspaceAction(workspace({ version: Number.MAX_SAFE_INTEGER }), { kind: "set-direction", text: "" }));
    const initial = workspace({ proposals: [proposal("last", { version: Number.MAX_SAFE_INTEGER })] });
    expectInvalid(() => applyWorkspaceAction(initial, { kind: "put-proposal", proposal: input(initial, "last") }));
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalid(() => workspaceSelection(workspace({ version })));
    }
  });

  it("accepts frozen inputs, is deterministic, and does not retain mutable caller-owned data", () => {
    const initial = deepFreeze(workspace());
    const action = deepFreeze({ kind: "put-proposal", proposal: input(initial, "death", {
      rationale: "Edited prose.", operations: [{ kind: "activate-assertion", assertion }],
    }) } as const);
    const first = applyWorkspaceAction(initial, action);
    expect(applyWorkspaceAction(initial, action)).toEqual(first);
    expect(workspaceSelection(initial)).toEqual(workspaceSelection(initial));
    const mutableState = structuredClone(initial);
    const mutableAction = structuredClone(action);
    const result = applyWorkspaceAction(mutableState, mutableAction);
    Reflect.set(mutableState.base, "snapshotDigest", "b".repeat(64));
    Reflect.set(mutableAction.proposal, "rationale", "Changed after application.");
    const operation = mutableAction.proposal.operations[0];
    if (operation?.kind !== "activate-assertion") throw new Error("Expected the test assertion operation");
    Reflect.set(operation.assertion.body, "polarity", "negative");
    expect(result).toEqual(first);
    expect(initial.version).toBe(1);
    expect(initial.history).toEqual([]);
  });
});
