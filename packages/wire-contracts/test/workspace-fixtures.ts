import type {
  ApiSuccessResponseV1,
  AssertionRecordV1,
  WorkspaceActionV1,
  WorkspacePinV1,
  WorkspaceRequestV1,
  WorkspaceViewV1,
} from "../src/index.js";

export const workspaceDigest = "a".repeat(64);
export const workspaceAssertion: AssertionRecordV1 = {
  format: "wmm.assertion-record/1",
  id: `asrt:${workspaceDigest}`,
  body: {
    format: "wmm.claim/1",
    worldId: "world:workspace_test",
    semanticProfileDigest: workspaceDigest,
    proposition: {
      kind: "atom",
      subjectId: "person:regent",
      predicateDefinitionDigest: workspaceDigest,
      value: { kind: "ref", id: "office:regent" },
    },
    polarity: "positive",
    scope: {
      account: { kind: "notApplicable" },
      jurisdiction: { kind: "notApplicable" },
      recognitionFrame: { kind: "notApplicable" },
    },
    applicability: { kind: "invariant" },
  },
};
export const workspaceProposal: Extract<WorkspaceActionV1, { kind: "put-proposal" }>["proposal"] = {
  id: "proposal:regency",
  title: "Establish a regency",
  author: "author:writer",
  rationale: "Keep the succession explicit.",
  dependencies: ["proposal:succession"],
  exclusions: ["proposal:interregnum"],
  operations: [
    { kind: "write-prose", path: "documents/succession.md", text: "A regent governs.", beforeSha256: null },
    { kind: "activate-assertion", assertion: workspaceAssertion },
    { kind: "deactivate-assertion", assertionId: `asrt:${"b".repeat(64)}` },
  ],
};
export const workspacePins = [
  { id: "pin:document", kind: "document", path: "documents/succession.md", sha256: workspaceDigest, active: true },
  { id: "pin:assertion", kind: "assertion", assertionId: workspaceAssertion.id, active: false },
] as const satisfies readonly WorkspacePinV1[];
export const workspaceActions = [
  { kind: "decide", groupId: workspaceProposal.id, decision: "selected", reason: "Prefer a regency." },
  { kind: "decide", groupId: workspaceProposal.id, decision: "undecided" },
  { kind: "decide", groupId: workspaceProposal.id, decision: "rejected", reason: "Try another option." },
  { kind: "select", groupIds: [workspaceProposal.id] },
  { kind: "put-proposal", proposal: workspaceProposal },
  { kind: "set-direction", text: "Explore a disputed succession." },
  ...workspacePins.map((pin) => ({ kind: "put-pin" as const, pin })),
  { kind: "add-regency", title: "An alternative regency", rationale: "Offer another option." },
] as const satisfies readonly WorkspaceActionV1[];

export function workspaceMutate(action: WorkspaceActionV1): Extract<WorkspaceRequestV1, { operation: "workspace.mutate" }> {
  return {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId: "workspace-mutate",
    operation: "workspace.mutate",
    payload: { workspaceId: "workspace:succession", expectedVersion: 1, idempotencyKey: "mutation-1", action },
  };
}
export const workspaceRequests = [
  {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId: "workspace-create",
    operation: "workspace.create",
    payload: {
      workspaceId: "workspace:succession",
      bundlePath: "fixtures/v1/complete-world",
      title: "Succession",
      goal: "Explore a disputed succession.",
      mode: "succession-demo",
      idempotencyKey: "creation-1",
    },
  },
  {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId: "workspace-read",
    operation: "workspace.read",
    payload: { workspaceId: "workspace:succession" },
  },
  {
    format: "wmm.request/1",
    apiVersion: "wmm/1",
    requestId: "workspace-historical-read",
    operation: "workspace.read",
    payload: { workspaceId: "workspace:succession", atVersion: 1 },
  },
  ...workspaceActions.map(workspaceMutate),
] as const satisfies readonly WorkspaceRequestV1[];

export const workspaceView: WorkspaceViewV1 = {
  format: "wmm.workspace-view/1",
  workspace: {
    format: "wmm.workspace/1",
    id: "workspace:succession",
    version: 10,
    title: "Succession",
    worldTitle: "The succession world",
    goal: "Explore a disputed succession.",
    mode: "succession-demo",
    base: { worldId: "world:workspace_test", snapshotDigest: workspaceDigest },
    proposals: [{ ...workspaceProposal, version: 1, decision: "selected", rejectionReason: null }],
    pins: workspacePins,
    direction: "Explore a disputed succession.",
    history: workspaceActions.map((action, index) => ({ version: index + 2, action })),
  },
  records: [{ id: "person:regent", kind: "person", title: "The regent", summary: "A possible regent." }],
  documents: [{ path: "documents/succession.md", text: "The crown is disputed.", truncated: false }],
  changes: [{ groupId: workspaceProposal.id, representation: "mixed", before: ["The crown is disputed."], proposed: ["A regent governs."] }],
  prerequisites: [{ groupId: workspaceProposal.id, required: ["proposal:succession"], missing: ["proposal:succession"], rejected: [] }],
  selection: {
    requested: [workspaceProposal.id],
    required: ["proposal:succession"],
    missing: ["proposal:succession"],
    rejectedRequired: [],
    diagnostics: [{ code: "MISSING_PREREQUISITE", groupIds: [workspaceProposal.id], message: "Select the succession prerequisite." }],
  },
  validation: { status: "not-run", message: "Candidate validation has not run." },
  approval: "unavailable",
  canon: "unchanged",
};

export function workspaceResponse(
  data: WorkspaceViewV1 = workspaceView,
  operation: WorkspaceRequestV1["operation"] = "workspace.read",
): ApiSuccessResponseV1 {
  return {
    format: "wmm.response/1",
    apiVersion: "wmm/1",
    requestId: "workspace-result",
    operation,
    outcome: "success",
    execution: "completed",
    resolved: data.workspace.base,
    data,
    diagnostics: [],
  };
}
