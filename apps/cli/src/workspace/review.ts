import type { ClaimBodyV1, EndEndpointV1, StartEndpointV1, TypedValueV1, WorkspaceViewV1 } from "@wmm/wire-contracts";
import { wrap } from "./text.js";

const short = (id: string): string => id.length > 24 ? `${id.slice(0, 12)}…` : id;
const name = (view: WorkspaceViewV1, id: string): string => view.records.find(record => record.id === id)?.title ?? short(id);
const groupName = (view: WorkspaceViewV1, id: string): string => view.workspace.proposals.find(group => group.id === id)?.title ?? short(id);
const provenance = (view: WorkspaceViewV1, ids: readonly string[]): string => ids.length ? ids.map(id => groupName(view, id)).join("; ") : "No group provenance supplied.";

/** Check only display binding, not canonical identity or historical validity. */
export function reviewStatus(view: WorkspaceViewV1): WorkspaceViewV1["validation"]["status"] {
  const receipt = view.review;
  if (!receipt) return "not-run";
  const binding = receipt.binding;
  // Workspace state has no profile field. The service validates semanticProfileDigest;
  // the displayed profile is taken directly from this same receipt's binding.
  return view.validation.status === "current" && binding.workspaceId === view.workspace.id &&
    binding.workspaceVersion === view.workspace.version && binding.worldId === view.workspace.base.worldId &&
    binding.baseSnapshotDigest === view.workspace.base.snapshotDigest ? "current" : "stale";
}

export function reviewValidationLabel(view: WorkspaceViewV1, failure: string | null = null): string {
  if (failure) return "FAILED / INCOMPLETE";
  const status = reviewStatus(view);
  if (status === "not-run") return "NOT RUN";
  return status === "current" ? `CURRENT v${view.workspace.version}` : `STALE v${view.review?.binding.workspaceVersion} (now v${view.workspace.version})`;
}

function claimLines(view: WorkspaceViewV1, body: ClaimBodyV1): string[] {
  const value = (item: TypedValueV1): string => item.kind === "ref"
    ? name(view, item.id) : typeof item.data === "string" ? item.data : JSON.stringify(item.data);
  const proposition = body.proposition;
  const statement = proposition.kind === "atom"
    ? `${name(view, proposition.subjectId)} — ${name(view, proposition.predicateDefinitionDigest)} — ${value(proposition.value)}`
    : `Exists in ${name(view, proposition.population.descriptorId)}; criterion ${name(view, proposition.criterion.definitionDigest)} (${Object.entries(proposition.criterion.arguments).map(([key, item]) => `${key}: ${value(item)}`).join("; ")})`;
  const scope = Object.entries(body.scope).map(([key, item]) => `${key}: ${item.kind === "ref" ? name(view, item.id) : item.kind === "notApplicable" ? "not applicable" : "unresolved"}`).join("; ");
  const endpoint = (item: StartEndpointV1 | EndEndpointV1): string => {
    switch (item.kind) {
      case "exact": return item.position;
      case "boundedUnknown": return `unknown within [${item.lowerInclusive}, ${item.upperExclusive})`;
      case "unknown": return "unknown";
      case "unboundedPast": return "unbounded past";
      case "unboundedFuture": return "unbounded future";
    }
  };
  const time = body.applicability;
  return [`${body.polarity === "negative" ? "Negative" : "Positive"} claim: ${statement}`, `Scope: ${scope}`,
    time.kind === "invariant" ? "Timing: invariant" : time.kind === "point" ? `Timing: ${endpoint(time.position)}`
      : `Timing: [${endpoint(time.start)}, ${endpoint(time.endExclusive)}) (end exclusive)`];
}

/** Every combined effect and result comes from the receipt, never proposal operations. */
export function reviewLines(view: WorkspaceViewV1, width: number, failure: string | null = null, available = true): string[] {
  const receipt = view.review;
  const current = reviewStatus(view) === "current" && failure === null;
  const lines = ["REVIEW / DRAFT CANDIDATE", `${view.workspace.worldTitle} / ${view.workspace.title} — workspace v${view.workspace.version}`,
    `Validation: ${reviewValidationLabel(view, failure)}`, view.validation.message];
  if (failure) lines.push(`REVIEW FAILED / INCOMPLETE: ${failure}`, "No completed result for this attempt. Previous receipts are not its result.");
  if (receipt) {
    lines.push(current ? `CURRENT RECEIPT — workspace v${receipt.binding.workspaceVersion}`
      : failure ? `PREVIOUS RECEIPT — workspace v${receipt.binding.workspaceVersion}; latest attempt incomplete`
      : `STALE RECEIPT — workspace v${receipt.binding.workspaceVersion}; current workspace v${view.workspace.version}. NOT CURRENT.`,
    `${current ? "Execution" : "Previous execution"}: ${receipt.execution}`,
    current ? `Validity: ${receipt.validity} — ${receipt.validity === "valid" ? "Valid for bounded checks" : receipt.validity === "invalid" ? "Invalid for bounded checks" : "Undetermined for bounded checks"}`
      : `Previous validity: ${receipt.validity} — not a current result.`,
    "Bounded checks are not proof that all history is true.", `Candidate digest: ${short(receipt.candidateDigest)} (d: full identifiers)`,
    `Semantic profile (service binding): ${short(receipt.binding.semanticProfileDigest)}`,
    `Base snapshot (receipt binding): ${short(receipt.binding.baseSnapshotDigest)}`);
  } else lines.push("No combined-candidate receipt supplied. Validation NOT RUN.");
  lines.push(`Approval: ${view.approval}`, `Canon: ${view.canon}`,
    "No validation or authorization is performed by this editor. The service owns checks and validity.",
    available ? "Review tab: c builds/checks the combined selection; v only navigates. No approval or commit route." : "Review NOT RUN: this older client has no review route. Use a gateway supporting WorkspaceClient.review.",
    "", "CURRENT SELECTED INTENT — NOT A RECEIPT", ...(
      view.selection.requested.length ? view.selection.requested.map(id => groupName(view, id)) : ["Nothing selected."]),
    "", "SELECTION DIAGNOSTICS (current service view)", ...(view.selection.diagnostics.length ? view.selection.diagnostics.map(item => `${item.code}: ${item.message}`) : ["No selection diagnostics reported. This does NOT mean historically valid."]),
    "", "MISSING PREREQUISITES", ...(view.selection.missing.length ? view.selection.missing.map(id => groupName(view, id)) : ["None reported."]),
    "", "REJECTED PREREQUISITES", ...(view.selection.rejectedRequired.length ? view.selection.rejectedRequired.map(id => groupName(view, id)) : ["None reported."]));
  if (receipt) {
    const context = current ? "RECEIPT" : "PREVIOUS RECEIPT / NOT CURRENT";
    lines.push("", `${context}: SELECTED GROUPS / PROVENANCE`, ...(receipt.binding.selectedGroups.length
      ? receipt.binding.selectedGroups.map(group => `${groupName(view, group.id)} — proposal v${group.version} (receipt)`) : ["No selected groups in this receipt."]),
    "", `${context}: MANDATORY CHECK OUTCOMES`, ...receipt.checks.map(check => `${check.id}: ${check.status}`),
    `Work limit (service): ${receipt.limits.maxWorkUnits} units`, "", `${context}: COMBINED DOCUMENT DIFF`);
    if (!receipt.diff.documents.length) lines.push("No document changes in this receipt.");
    for (const document of receipt.diff.documents) {
      lines.push(`${document.kind.toUpperCase()}: ${document.path}`, `Groups: ${provenance(view, document.groupIds)}`,
        "BEFORE (combined receipt)", document.before ?? "Document absent in base.", "AFTER (combined receipt)", document.after,
        ...(document.truncated ? ["[SERVICE EXCERPT TRUNCATED: full combined document not supplied]"] : []), "");
    }
    lines.push(`${context}: ACTIVE / DEACTIVATED CLAIM SUMMARIES`);
    if (!receipt.diff.assertions.length) lines.push("No assertion changes in this receipt.");
    for (const assertion of receipt.diff.assertions) {
      const record = view.records.find(item => item.id === assertion.id);
      lines.push(`${assertion.kind === "activated" ? "ACTIVATED / ACTIVE IN CANDIDATE" : "DEACTIVATED IN CANDIDATE"}: ${record?.title ?? short(assertion.id)}`,
        `Groups: ${provenance(view, assertion.groupIds)}`, ...claimLines(view, assertion.body), "");
    }
    lines.push(`${context}: DIAGNOSTICS`, ...(receipt.diagnostics.length ? receipt.diagnostics.flatMap(diagnostic => [
      `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`,
      `Groups: ${provenance(view, diagnostic.groupIds)}`,
      ...(diagnostic.assertionIds.length ? [`Assertions: ${diagnostic.assertionIds.map(id => name(view, id)).join("; ")}`] : []),
    ]) : ["No receipt diagnostics supplied; validity remains the service's stated result."]),
    "", `${context}: LIMITATIONS`, ...(receipt.limitations.length ? receipt.limitations : ["No additional limitations supplied by the service."]));
  } else {
    lines.push("", "READABLE SELECTED EFFECTS — PER-GROUP SERVICE VIEW, NOT A COMBINED DIFF");
    for (const id of view.selection.requested) {
      const change = view.changes.find(item => item.groupId === id);
      lines.push(groupName(view, id), "BEFORE", ...(change?.before ?? ["Unavailable."]), "PROPOSED", ...(change?.proposed ?? ["Unavailable."]));
    }
  }
  lines.push("", "CURRENT HARD PINS", ...view.workspace.pins.map(pin => `${pin.active ? "ACTIVE" : "INACTIVE"}: ${pin.kind === "document" ? pin.path : name(view, pin.assertionId)}`),
    "CURRENT ADVISORY DIRECTION", view.workspace.direction || "No direction supplied.",
    "", "d: raw receipt, binding, candidate/evaluation digests and full identifiers.", "Plain output never runs checks.");
  return lines.flatMap(line => wrap(line, width));
}
