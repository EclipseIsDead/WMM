import type {
  ProposalGroupV1,
  WorkspaceActionV1,
  WorkspaceOperationV1,
  WorkspacePinV1,
  WorkspaceSelectionV1,
  WorkspaceStateV1,
  WorkspaceViewV1,
} from "@wmm/wire-contracts";

export class WorkspaceActionError extends Error {
  readonly code = "INVALID_WORKSPACE_ACTION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceActionError";
  }
}

type ProposalInput = Extract<WorkspaceActionV1, { kind: "put-proposal" }>["proposal"];

function invalid(message: string): never {
  throw new WorkspaceActionError(message);
}

function text(value: string, limit: number, label: string): void {
  if (typeof value !== "string" || value.length > limit) {
    invalid(`${label} must be a string of at most ${limit} UTF-16 code units`);
  }
}

function stableId(value: string): void {
  text(value, 256, "Stable ID");
  if (value.length === 0) invalid("Stable IDs must not be empty");
}

function title(value: string): string {
  if (typeof value !== "string") invalid("Title must be a string");
  const trimmed = value.trim();
  text(trimmed, 160, "Title");
  if (trimmed.length === 0) invalid("Title must not be blank");
  return trimmed;
}

function bounded<T>(values: readonly T[], limit: number, label: string): void {
  if (!Array.isArray(values) || values.length > limit) {
    invalid(`${label} must contain at most ${limit} items`);
  }
}

function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid("Version must be a positive safe integer");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function groupIds(values: readonly string[]): string[] {
  bounded(values, 256, "Group IDs");
  values.forEach(stableId);
  return sortedUnique(values);
}

function checkOperations(operations: readonly WorkspaceOperationV1[]): void {
  bounded(operations, 256, "Operations");
  for (const operation of operations) {
    switch (operation.kind) {
      case "write-prose":
        text(operation.path, 4096, "Document path");
        text(operation.text, 65536, "Prose");
        break;
      case "activate-assertion": stableId(operation.assertion.id); break;
      case "deactivate-assertion": stableId(operation.assertionId); break;
      default: invalid("Unsupported workspace operation");
    }
  }
}

function checkProposal(proposal: ProposalInput): void {
  stableId(proposal.id);
  stableId(proposal.author);
  title(proposal.title);
  text(proposal.rationale, 16000, "Rationale");
  groupIds(proposal.dependencies);
  groupIds(proposal.exclusions);
  checkOperations(proposal.operations);
}

function checkPin(pin: WorkspacePinV1): void {
  stableId(pin.id);
  if (typeof pin.active !== "boolean") invalid("Pin active must be a boolean");
  switch (pin.kind) {
    case "document": text(pin.path, 4096, "Document path"); break;
    case "assertion": stableId(pin.assertionId); break;
    default: invalid("Unsupported workspace pin");
  }
}

function proposalIndex(state: WorkspaceStateV1): Map<string, ProposalGroupV1> {
  stableId(state.id);
  version(state.version);
  title(state.title);
  title(state.worldTitle);
  text(state.goal, 16000, "Goal");
  text(state.direction, 16000, "Direction");
  bounded(state.proposals, 256, "Proposals");
  bounded(state.pins, 256, "Pins");
  bounded(state.history, 2000, "History");
  const proposals = new Map<string, ProposalGroupV1>();
  for (const proposal of state.proposals) {
    checkProposal(proposal);
    version(proposal.version);
    if (!["undecided", "selected", "rejected"].includes(proposal.decision)) invalid("Unknown proposal decision");
    if (proposal.rejectionReason !== null) text(proposal.rejectionReason, 16000, "Rejection reason");
    if (proposals.has(proposal.id)) invalid(`Duplicate proposal ID: ${proposal.id}`);
    proposals.set(proposal.id, proposal);
  }
  const pins = new Set<string>();
  for (const pin of state.pins) {
    checkPin(pin);
    if (pins.has(pin.id)) invalid(`Duplicate pin ID: ${pin.id}`);
    pins.add(pin.id);
  }
  for (const proposal of proposals.values()) {
    for (const id of [...proposal.dependencies, ...proposal.exclusions]) {
      if (!proposals.has(id)) invalid(`Unknown group reference: ${id}`);
      if (id === proposal.id) invalid(`A proposal cannot depend on or exclude itself: ${id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid(`Cyclic proposal dependencies: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of proposals.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of proposals.keys()) visit(id);
  return proposals;
}

function requireGroup(proposals: ReadonlyMap<string, ProposalGroupV1>, id: string): ProposalGroupV1 {
  stableId(id);
  const proposal = proposals.get(id);
  if (proposal === undefined) invalid(`Unknown proposal: ${id}`);
  return proposal;
}

function closure(proposals: ReadonlyMap<string, ProposalGroupV1>, roots: readonly string[]): string[] {
  const required = new Set<string>();
  const visit = (id: string): void => {
    if (required.has(id)) return;
    required.add(id);
    for (const dependency of requireGroup(proposals, id).dependencies) visit(dependency);
  };
  roots.forEach(visit);
  return [...required].sort();
}

function selectedIds(state: WorkspaceStateV1): string[] {
  return state.proposals.filter((proposal) => proposal.decision === "selected").map((proposal) => proposal.id);
}

/** Selection diagnostics are draft guidance, not historical validation or approval. */
export function workspaceSelection(
  state: WorkspaceStateV1,
  requestedIds: readonly string[] = selectedIds(state),
): WorkspaceSelectionV1 {
  const proposals = proposalIndex(state);
  const requested = groupIds(requestedIds);
  const explicit = new Set(requested);
  const required = closure(proposals, requested);
  const missing = required.filter((id) => !explicit.has(id));
  const rejectedRequired = missing.filter((id) => proposals.get(id)!.decision === "rejected");
  const diagnostics: WorkspaceSelectionV1["diagnostics"][number][] = [];
  if (missing.length > 0) {
    diagnostics.push({
      code: "MISSING_PREREQUISITE", groupIds: missing,
      message: "Required groups are not explicitly selected. Rejected prerequisites must first be restored to undecided.",
    });
  }
  const incompatible = new Set<string>();
  const pinChanges: string[] = [];
  for (const id of requested) {
    const proposal = proposals.get(id)!;
    for (const exclusion of proposal.exclusions) {
      if (explicit.has(exclusion)) {
        incompatible.add(id);
        incompatible.add(exclusion);
      }
    }
    if (proposal.operations.some((operation) => state.pins.some((pin) => pin.active && (
      (pin.kind === "document" && operation.kind === "write-prose" && pin.path === operation.path)
      || (pin.kind === "assertion" && operation.kind === "deactivate-assertion" && pin.assertionId === operation.assertionId)
    )))) pinChanges.push(id);
  }
  if (incompatible.size > 0) {
    diagnostics.push({
      code: "INCOMPATIBLE_ALTERNATIVES", groupIds: [...incompatible].sort(),
      message: "Explicitly selected groups contain incompatible alternatives.",
    });
  }
  // State has neither base document bodies nor pinned assertion tuples. The application
  // must verify no-op writes and opposite-polarity additions against the actual base.
  if (pinChanges.length > 0) {
    diagnostics.push({
      code: "DRAFT_PIN_CHANGE", groupIds: pinChanges,
      message: "Explicit draft operations target active pins. Base-bound verification is still required.",
    });
  }
  return { requested, required, missing, rejectedRequired, diagnostics };
}

export function workspacePrerequisites(state: WorkspaceStateV1): WorkspaceViewV1["prerequisites"] {
  const proposals = proposalIndex(state);
  const selected = new Set(selectedIds(state));
  return state.proposals.map((proposal) => {
    const required = closure(proposals, [proposal.id]).filter((id) => id !== proposal.id);
    return {
      groupId: proposal.id,
      required,
      missing: required.filter((id) => !selected.has(id)),
      rejected: required.filter((id) => proposals.get(id)!.decision === "rejected"),
    };
  });
}

/** Compare JSON data structurally; object member order is not an executable change. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameData(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}

function putProposal(state: WorkspaceStateV1, input: ProposalInput): readonly ProposalGroupV1[] {
  checkProposal(input);
  const previous = state.proposals.find((proposal) => proposal.id === input.id);
  if (previous === undefined && state.proposals.length === 256) invalid("Workspace already has 256 proposals");
  if (previous?.version === Number.MAX_SAFE_INTEGER) invalid("Proposal version cannot advance safely");
  const dependencies = groupIds(input.dependencies);
  const exclusions = groupIds(input.exclusions);
  const executableChange = previous !== undefined && (
    !sameData(previous.operations, input.operations)
    || !sameData(groupIds(previous.dependencies), dependencies)
    || !sameData(groupIds(previous.exclusions), exclusions)
  );
  const proposal: ProposalGroupV1 = {
    ...input, title: title(input.title), dependencies, exclusions,
    version: previous === undefined ? 1 : previous.version + 1,
    decision: previous === undefined || (previous.decision === "selected" && executableChange) ? "undecided" : previous.decision,
    rejectionReason: previous?.rejectionReason ?? null,
  };
  return previous === undefined ? [...state.proposals, proposal]
    : state.proposals.map((group) => group.id === proposal.id ? proposal : group);
}

/** Wire-shaped input; the caller verifies operations and pins against the immutable base. */
export function applyWorkspaceAction(state: WorkspaceStateV1, action: WorkspaceActionV1): WorkspaceStateV1 {
  const proposalsById = proposalIndex(state);
  if (state.version === Number.MAX_SAFE_INTEGER) invalid("Workspace version cannot advance safely");
  if (state.history.length === 2000) invalid("Workspace history already has 2000 entries");
  // Snapshot caller-owned data so later edits cannot rewrite proposals or decision history.
  const snapshot = structuredClone(state);
  const intent = structuredClone(action);
  let proposals = snapshot.proposals;
  let pins = snapshot.pins;
  let direction = snapshot.direction;
  switch (intent.kind) {
    case "decide": {
      const previous = requireGroup(proposalsById, intent.groupId);
      if (!["selected", "undecided", "rejected"].includes(intent.decision)) invalid("Unknown proposal decision");
      if (intent.reason !== undefined) text(intent.reason, 16000, "Rejection reason");
      if (previous.decision === "rejected" && intent.decision === "selected") {
        invalid("Restore a rejected proposal to undecided before selecting it");
      }
      proposals = proposals.map((proposal) => proposal.id === intent.groupId ? {
        ...proposal, decision: intent.decision,
        rejectionReason: intent.decision === "rejected" ? intent.reason ?? proposal.rejectionReason : proposal.rejectionReason,
      } : proposal);
      break;
    }
    case "select": {
      const selected = new Set(groupIds(intent.groupIds));
      for (const id of selected) {
        if (requireGroup(proposalsById, id).decision === "rejected") invalid("Restore rejected proposals before selecting them");
      }
      proposals = proposals.map((proposal) => ({
        ...proposal,
        decision: selected.has(proposal.id) ? "selected" : proposal.decision === "selected" ? "undecided" : proposal.decision,
      }));
      break;
    }
    case "put-proposal": proposals = putProposal(snapshot, intent.proposal); break;
    case "set-direction":
      text(intent.text, 16000, "Direction");
      direction = intent.text;
      break;
    case "put-pin": {
      checkPin(intent.pin);
      const exists = pins.some((pin) => pin.id === intent.pin.id);
      if (!exists && pins.length === 256) invalid("Workspace already has 256 pins");
      pins = exists ? pins.map((pin) => pin.id === intent.pin.id ? intent.pin : pin) : [...pins, intent.pin];
      break;
    }
    case "add-regency":
      if (snapshot.mode !== "succession-demo") invalid("The regency template is only available in succession-demo mode");
      if (proposalsById.has("regency")) invalid("The regency template proposal already exists");
      proposals = putProposal(snapshot, {
        id: "regency", title: intent.title, rationale: intent.rationale, author: "author",
        dependencies: ["death", "council"], exclusions: ["coup"],
        operations: [{
          kind: "write-prose", path: "prose/developments/regency.md", beforeSha256: null,
          text: `# ${title(intent.title)}\n\n${intent.rationale}\n`,
        }],
      });
      break;
    default: invalid("Unsupported workspace action");
  }
  const nextVersion = snapshot.version + 1;
  const next: WorkspaceStateV1 = {
    ...snapshot,
    version: nextVersion,
    proposals: proposals.map((proposal) => ({
      ...proposal, dependencies: groupIds(proposal.dependencies), exclusions: groupIds(proposal.exclusions),
    })),
    pins, direction,
    history: [...snapshot.history, { version: nextVersion, action: intent }],
  };
  proposalIndex(next);
  return next;
}
