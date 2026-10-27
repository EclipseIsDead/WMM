import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";

import { assertionId, canonicalJson, sha256Hex, workspaceCandidateDigest, workspaceReviewDigest } from "@wmm/canonical";
import { applyWorkspaceAction, workspacePrerequisites, workspaceSelection, WorkspaceActionError, validateWorldSemantics, reviewWorkspace, workspaceReviewBinding, WorkspaceReviewBudgetError } from "@wmm/core";
import { exportWorldBundle, loadReleaseWorldBundle } from "@wmm/exchange";
import { WorkspaceStoreError, type WorkspaceStore } from "@wmm/ports";
import type {
  JsonValue, ProposalGroupV1, WorkspaceActionV1, WorkspaceBaseV1, WorkspaceOperationV1,
  WorkspaceRequestV1, WorkspaceStateV1, WorkspaceViewV1, WorkspaceReviewV1, WorkspaceMapReadRequest, WorkspaceMapView,
  WorkspaceEconomyReadRequest, WorkspaceEconomyView,
} from "@wmm/wire-contracts";
import { validateApiResponse, validateWorkspaceReviewReceipt } from "@wmm/wire-contracts";
import { readWorkspaceAtlas } from "./atlas.js";
import { readWorkspaceEconomy } from "./economy.js";

function invalid(message: string): never { throw new WorkspaceActionError(message); }
function json(value: unknown): string { return canonicalJson(value as JsonValue); }
function clipped(text: string, length = 16000): string {
  if (text.length <= length) return text;
  let end = length;
  if (!text.slice(0, end).isWellFormed()) end -= 1;
  return `${text.slice(0, end)}\n[Preview truncated; full source is retained in the pinned base.]`;
}
function documentText(base: WorkspaceBaseV1, path: string): string | undefined {
  const document = base.documents.find((item) => item.path === path);
  if (document === undefined || document.mediaType !== "text/markdown") return undefined;
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(document.base64, "base64"));
}
function operationSummary(operation: WorkspaceOperationV1, base: WorkspaceBaseV1): { before: string; proposed: string } {
  switch (operation.kind) {
    case "write-prose": return {
      before: `${operation.path}\n${clipped(documentText(base, operation.path) ?? "No document is recorded at this path in the pinned base.")}`,
      proposed: `Authored prose: ${operation.path}\n${clipped(operation.text)}`,
    };
    case "activate-assertion": return {
      before: base.world.world.activeAssertionIds.includes(operation.assertion.id) ? "This exact claim is already active." : "This exact claim is not active in the pinned base; its opposite is not thereby established.",
      proposed: describeAssertion(operation.assertion, base),
    };
    case "deactivate-assertion": return {
      before: describeAssertion(base.world.assertions.find((record) => record.id === operation.assertionId)!, base),
      proposed: "Deactivate this claim. Retain its immutable body; do not assert its opposite.",
    };
  }
}
function label(id: string): string {
  const tail = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return tail.replace(/[_-]/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
function describeAssertion(record: WorkspaceBaseV1["world"]["assertions"][number], base: WorkspaceBaseV1): string {
  const claim = record.body;
  const proposition = claim.proposition;
  const definitions = new Map(base.world.definitions.map((definition) => [definition.digest, definition.body]));
  const fact = proposition.kind === "atom"
    ? `${label(proposition.subjectId)} ${claim.polarity === "negative" ? "explicitly not: " : ""}${definitions.get(proposition.predicateDefinitionDigest)?.key.replace(/_/g, " ") ?? proposition.predicateDefinitionDigest}: ${proposition.value.kind === "ref" ? label(proposition.value.id) : clipped(json(proposition.value.data), 1000)}`
    : `${claim.polarity === "negative" ? "No" : "At least one"} qualifying member of ${label(proposition.population.descriptorId)} (${definitions.get(proposition.criterion.definitionDigest)?.key ?? "pinned criterion"}).`;
  const time = claim.applicability.kind === "invariant" ? "Invariant applicability" : json(claim.applicability);
  const sourceIds = base.world.supports.filter((support) => support.body.claimId === record.id).map((support) => support.body.sourceId);
  return clipped(`${fact}\nTime: ${time}\nScope: ${json(claim.scope)}\nSources: ${sourceIds.length ? sourceIds.map(label).join(", ") : "No documentary support recorded; not a truth judgment."}`);
}

function validateOperations(state: WorkspaceStateV1, base: WorkspaceBaseV1): void {
  const documentPaths = base.snapshot.manifest.files.map((entry) => entry.path.toLowerCase());
  for (const group of state.proposals) {
    if (group.operations.length === 0) invalid("A reviewable group needs at least one explicit operation");
    const written = new Set<string>();
    for (const operation of group.operations) {
      if (operation.kind === "write-prose") {
        const path = operation.path;
        if (!/^prose\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(path) ||
          path.split("/").some((part) => part === "." || part === "..")) invalid("Prose edits require a portable prose/*.md path, never a record, asset, or traversal path");
        const folded = path.toLowerCase();
        if (written.has(folded)) invalid("A group cannot write a document twice");
        if ([...written].some((other) => other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`))) {
          invalid("Prose operations in one group collide as a file and directory");
        }
        written.add(folded);
        if (documentPaths.some((other) => other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`))) invalid("Prose path collides with an existing file/directory");
        const original = base.documents.find((document) => document.path === path);
        if (original === undefined && documentPaths.includes(folded)) invalid("Prose path differs only by case from a pinned file");
        if (original !== undefined && original.mediaType !== "text/markdown") invalid("Only Markdown documents can be revised");
        if (operation.beforeSha256 !== (original?.sha256 ?? null)) invalid("The prose edit does not bind the exact pinned-base document");
      } else if (operation.kind === "deactivate-assertion") {
        if (!base.world.world.activeAssertionIds.includes(operation.assertionId)) invalid("Only active pinned-base assertions can be deactivated");
      } else {
        const record = operation.assertion;
        if (record.id !== assertionId(record.body) || record.body.worldId !== state.base.worldId ||
          record.body.semanticProfileDigest !== base.world.world.semanticProfileDigest) invalid("Assertion identity, world and semantic profile must match admitted content");
        const existing = base.world.assertions.find((assertion) => assertion.id === record.id);
        if (existing !== undefined && !isDeepStrictEqual(existing, record)) invalid("An immutable assertion ID cannot be reassigned");
        const assertions = existing === undefined ? [...base.world.assertions, record] : base.world.assertions;
        try {
          validateWorldSemantics({
            world: { ...base.world.world, assertionIds: assertions.map((assertion) => assertion.id).sort(),
              activeAssertionIds: [...new Set([...base.world.world.activeAssertionIds, record.id])].sort() },
            assertions, descriptors: base.world.descriptors, sources: base.world.sources,
            supports: base.world.supports, rosters: base.world.rosters,
            definitionsByDigest: Object.fromEntries(base.world.definitions.map((definition) => [definition.digest, definition.body])),
          });
        } catch (error) { invalid(`Assertion admission failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
  for (const pin of state.pins) {
    if (pin.kind === "document") {
      if (!base.documents.some((document) => document.path === pin.path && document.sha256 === pin.sha256)) invalid("A document pin must identify an exact pinned-base document");
    } else if (!base.world.world.activeAssertionIds.includes(pin.assertionId)) invalid("An assertion pin must identify an active pinned-base claim");
  }
}

function selectionView(state: WorkspaceStateV1, base: WorkspaceBaseV1): WorkspaceViewV1["selection"] {
  const selection = workspaceSelection(state);
  const selected = state.proposals.filter((group) => group.decision === "selected");
  const diagnostics = selection.diagnostics.filter((diagnostic) => diagnostic.code !== "DRAFT_PIN_CHANGE");
  for (const group of selected) {
    const violated = state.pins.some((pin) => pin.active && group.operations.some((operation) => {
      if (pin.kind === "document" && operation.kind === "write-prose" && pin.path === operation.path) {
        return sha256Hex(Buffer.from(operation.text)) !== pin.sha256;
      }
      if (pin.kind !== "assertion") return false;
      if (operation.kind === "deactivate-assertion") return pin.assertionId === operation.assertionId;
      if (operation.kind !== "activate-assertion") return false;
      const pinned = base.world.assertions.find((record) => record.id === pin.assertionId)?.body;
      const proposed = operation.assertion.body;
      return pinned !== undefined && pinned.polarity !== proposed.polarity &&
        isDeepStrictEqual(pinned.proposition, proposed.proposition) && isDeepStrictEqual(pinned.scope, proposed.scope);
    }));
    if (violated) diagnostics.push({ code: "PIN_CHANGED", groupIds: [group.id], message: `${group.title} targets an active base-bound protection. Canon remains unchanged.` });
  }
  const writes = new Map<string, { groupId: string; text: string }>();
  for (const group of selected) {
    for (const operation of group.operations) {
      if (operation.kind !== "write-prose") continue;
      const path = operation.path.toLowerCase();
      const other = writes.get(path);
      if (other !== undefined && other.text !== operation.text) diagnostics.push({ code: "CONFLICTING_PROSE_EDITS", groupIds: [other.groupId, group.id], message: `Selected groups propose different document contents at ${operation.path}.` });
      writes.set(path, { groupId: group.id, text: operation.text });
    }
  }
  return { ...selection, diagnostics };
}

function boundReview(state: WorkspaceStateV1, base: WorkspaceBaseV1, receipt?: WorkspaceReviewV1): Pick<WorkspaceViewV1, "validation" | "review"> {
  if (receipt === undefined) return { validation: { status: "not-run", message: "Run Review checks for this exact selection. Prose meaning and general historical reasoning are not evaluated." } };
  if (!validateWorkspaceReviewReceipt(receipt).valid) return { validation: { status: "stale", message: "Stored review is outside the current receipt contract; run checks again." } };
  const { evaluationDigest, ...body } = receipt;
  if (evaluationDigest !== workspaceReviewDigest(body)) return { validation: { status: "stale", message: "Stored review integrity failed; run checks again." } };
  let current = false;
  try {
    const binding = workspaceReviewBinding(state, base);
    current = isDeepStrictEqual(binding, receipt.binding) && receipt.candidateDigest === workspaceCandidateDigest(binding);
  } catch (error) {
    if (!(error instanceof WorkspaceReviewBudgetError)) throw error;
  }
  return {
    review: receipt,
    validation: current
      ? { status: "current", message: `Completed ${receipt.validity} result for the exact current candidate, within ${receipt.binding.evaluator}. Narrative truth is not inferred.` }
      : { status: "stale", message: `Review belongs to workspace v${receipt.binding.workspaceVersion}, not the current selection/steering/evaluator binding. Run checks again.` },
  };
}

export function workspaceView(state: WorkspaceStateV1, base: WorkspaceBaseV1, receipt?: WorkspaceReviewV1): WorkspaceViewV1 {
  const definitions = new Map(base.world.definitions.map((entry) => [entry.digest, entry.body]));
  const records: WorkspaceViewV1["records"][number][] = [
    ...base.world.descriptors.map((record) => ({ id: record.id, kind: definitions.get(record.birthTypeDefinitionDigest)?.key ?? "descriptor", title: label(record.id), summary: "Stable identity in the pinned base. Display label is derived from its ID; no authored name has been inferred." })),
    ...base.world.assertions.map((record) => ({ id: record.id, kind: base.world.world.activeAssertionIds.includes(record.id) ? "active assertion" : "inactive assertion", title: describeAssertion(record, base).split("\n")[0]!.slice(0, 140).toWellFormed(), summary: describeAssertion(record, base) })),
    ...base.world.sources.map((record) => ({ id: record.id, kind: "source", title: label(record.id), summary: clipped(json(record)) })),
  ];
  if (records.length > 256 || base.documents.length > 256) invalid("This U1/U2 workspace supports at most 256 base records and 256 documents; pagination is not implemented");
  return {
    format: "wmm.workspace-view/1", workspace: state, records,
    documents: base.documents.map((document) => {
      const text = documentText(base, document.path);
      return { path: document.path, sha256: document.sha256, text: text === undefined ? `[Retained ${document.mediaType} asset; not decoded as prose.]` : clipped(text), truncated: (text?.length ?? 0) > 16000 };
    }),
    changes: state.proposals.map((group) => {
      const summaries = group.operations.map((operation) => operationSummary(operation, base));
      const prose = group.operations.some((operation) => operation.kind === "write-prose");
      const claims = group.operations.some((operation) => operation.kind !== "write-prose");
      return { groupId: group.id, representation: prose && claims ? "mixed" : prose ? "explicit-prose" : "explicit-claims", before: summaries.map((summary) => summary.before), proposed: summaries.map((summary) => summary.proposed) };
    }),
    prerequisites: workspacePrerequisites(state), selection: selectionView(state, base),
    ...boundReview(state, base, receipt),
    approval: "unavailable", canon: "unchanged",
  };
}
function checkView(state: WorkspaceStateV1, base: WorkspaceBaseV1, receipt?: WorkspaceReviewV1): void {
  const view = workspaceView(state, base, receipt);
  // Reserve the longest workspace operation and worst-case JSON escaping for any
  // permitted correlation ID, including retries that carry a different requestId.
  const response = { format: "wmm.response/1", apiVersion: "wmm/1", requestId: "\u0000".repeat(256), operation: "workspace.review", outcome: "success", execution: "completed", resolved: state.base, diagnostics: [], data: view };
  if (!validateApiResponse(response).valid || Buffer.byteLength(json(response)) > 4 * 1024 * 1024) invalid("Workspace read model exceeds the bounded draft contract; split the authoring work into smaller workspaces");
}

function demoGroups(base: WorkspaceBaseV1): readonly ProposalGroupV1[] {
  const neutrality = base.documents.find((document) => document.path === "prose/neutrality.md");
  if (neutrality === undefined || documentText(base, "prose/succession.md") === undefined) invalid("Succession demo requires its worked-demo bundle, not an arbitrary world");
  const group = (id: string, title: string, text: string, dependencies: readonly string[] = []): ProposalGroupV1 => ({
    id, version: 1, title, author: "Worked demo", rationale: "Explicit authored-prose proposal. This is not a prediction or an inferred historical assertion.", dependencies, exclusions: [], operations: [{ kind: "write-prose", path: `prose/developments/${id}.md`, text, beforeSha256: null }], decision: "undecided", rejectionReason: null,
  });
  return [
    group("death", "Record King Edric's death", "# King Edric's death\n\nProposed authorial account: King Edric dies in 1172. No conclusion about eligible heirs is inferred.\n"),
    group("council", "Establish an interim council", "# Interim council\n\nThe existing council temporarily administers Valen after Edric's death.\n", ["death"]),
    group("coup", "Stage a military coup", "# Military coup\n\nThe commander seizes control after Edric's death. This is an alternative, not a necessary consequence.\n", ["death"]),
    { ...group("intervention", "Invite foreign military intervention", "", ["death"]), operations: [{ kind: "write-prose", path: neutrality.path, beforeSha256: neutrality.sha256, text: "# Neighboring kingdom\n\nThe neighboring army intervenes in Valen's succession crisis.\n" }] },
  ];
}
function normalizedAction(action: WorkspaceActionV1): WorkspaceActionV1 {
  const ids = (values: readonly string[]) => [...new Set(values)].sort();
  if (action.kind === "select") return { ...action, groupIds: ids(action.groupIds) };
  if (action.kind === "put-proposal") return { ...action, proposal: { ...action.proposal, title: action.proposal.title.trim(), dependencies: ids(action.proposal.dependencies), exclusions: ids(action.proposal.exclusions) } };
  return action;
}

/** Same draft operations for Ink, plain CLI, and machine clients; no authority/commit methods. */
export class WorkspaceApplication {
  constructor(private readonly store: WorkspaceStore) {}

  readMap(payload: WorkspaceMapReadRequest["payload"]): WorkspaceMapView {
    const state = this.store.read(payload.workspaceId, payload.atVersion);
    return readWorkspaceAtlas(state, this.store.readBase(payload.workspaceId), payload);
  }

  readEconomy(payload: WorkspaceEconomyReadRequest["payload"]): WorkspaceEconomyView {
    const state = this.store.read(payload.workspaceId, payload.atVersion);
    if (state.id !== payload.workspaceId) throw new WorkspaceStoreError("STORAGE_FAILURE", "Workspace read returned a different workspace identity");
    if (payload.atVersion !== undefined && state.version !== payload.atVersion) {
      throw new WorkspaceStoreError("STALE_WORKSPACE", `Workspace ${payload.workspaceId} read did not return requested v${payload.atVersion}`);
    }
    return readWorkspaceEconomy(state, this.store.readBase(payload.workspaceId));
  }

  execute(request: WorkspaceRequestV1): WorkspaceViewV1 {
    const payload = request.payload;
    let state: WorkspaceStateV1;
    switch (request.operation) {
      case "workspace.create": {
        const value = request.payload;
        const { idempotencyKey, ...intent } = value;
        state = this.store.create(value.workspaceId, { idempotencyKey, intent: json({ operation: request.operation, ...intent, bundlePath: resolve(value.bundlePath) }) }, () => {
          const loaded = loadReleaseWorldBundle(value.bundlePath);
          const base: WorkspaceBaseV1 = {
            snapshot: loaded.snapshot, world: exportWorldBundle(loaded),
            documents: loaded.documents.map((document) => ({ path: document.path, sha256: document.sha256, mediaType: document.mediaType, base64: Buffer.from(document.bytes).toString("base64") })),
          };
          const demo = value.mode === "succession-demo";
          const initial: WorkspaceStateV1 = {
            format: "wmm.workspace/1", id: value.workspaceId, version: 1,
            title: value.title.trim(), worldTitle: demo ? "Kingdom of Valen / worked demo" : label(loaded.world.worldId),
            goal: value.goal, mode: value.mode, base: { worldId: loaded.world.worldId, snapshotDigest: loaded.snapshot.snapshotDigest },
            proposals: demo ? demoGroups(base) : [],
            pins: demo ? [{ id: "neutrality", kind: "document", path: "prose/neutrality.md", sha256: base.documents.find((document) => document.path === "prose/neutrality.md")!.sha256, active: true }] : [],
            direction: demo ? "Keep the existing dynasty. Prefer diplomacy." : "", history: [],
          };
          validateOperations(initial, base);
          checkView(initial, base);
          return { state: initial, base };
        });
        break;
      }
      case "workspace.read": state = this.store.read(payload.workspaceId, request.payload.atVersion); break;
      case "workspace.review": {
        const value = request.payload;
        state = this.store.read(value.workspaceId);
        if (state.version !== value.expectedVersion) throw new WorkspaceStoreError("STALE_WORKSPACE", `Workspace ${state.id} is at v${state.version}, not v${value.expectedVersion}`);
        const base = this.store.readBase(state.id);
        const { review } = reviewWorkspace(state, base, value.limits);
        if (!validateWorkspaceReviewReceipt(review).valid) throw new Error("Kernel produced an invalid workspace review receipt");
        try { checkView(state, base, review); }
        catch (error) {
          if (error instanceof WorkspaceActionError) throw new WorkspaceReviewBudgetError("Combined workspace/review response exceeds its bounded output contract");
          throw error;
        }
        // Store performs a second expected-version check under its write lock.
        this.store.putReview(state.id, value.expectedVersion, review);
        return workspaceView(state, base, review);
      }
      case "workspace.mutate": {
        const value = request.payload;
        const action = normalizedAction(value.action);
        state = this.store.mutate(value.workspaceId, value.expectedVersion,
          { idempotencyKey: value.idempotencyKey, intent: json({ operation: request.operation, workspaceId: value.workspaceId, expectedVersion: value.expectedVersion, action }) },
          (current) => {
            const next = applyWorkspaceAction(current, action);
            const base = this.store.readBase(current.id);
            validateOperations(next, base);
            checkView(next, base, this.store.readReview(current.id));
            return next;
          });
        break;
      }
    }
    // Mutation retries replay the original associated control view, not a review saved later.
    const receipt = request.operation === "workspace.mutate"
      ? this.store.readOutcomeReview(state.id, request.payload.idempotencyKey)
      : request.operation === "workspace.read"
        ? this.store.readReview(state.id, state.version) ?? this.store.readReview(state.id)
        : undefined;
    return workspaceView(state, this.store.readBase(state.id), receipt);
  }
}
