import { types } from "node:util";

import {
  assertionId, canonicalJson, canonicalJsonBytes, framedJsonDigest, populationRosterDigest,
  semanticDefinitionDigest, semanticProfileDigest, sha256Hex, snapshotDigest, supportId,
  workspaceCandidateDigest, workspaceReviewDigest,
} from "@wmm/canonical";
import { evaluateApplicability } from "@wmm/temporal";
import { validateWorldRecord } from "@wmm/wire-contracts";
import type {
  ApplicabilityV1, AssertionRecordV1, JsonValue, ProposalGroupV1, SnapshotFileEntryV1, TemporalQueryV1,
  WorkspaceBaseV1, WorkspaceOperationV1, WorkspaceReviewBindingV1, WorkspaceReviewBodyV1,
  WorkspaceReviewDiagnosticV1, WorkspaceReviewDiffV1, WorkspaceReviewLimitsV1,
  WorkspaceReviewV1, WorkspaceStateV1, WorldRecordV1,
} from "@wmm/wire-contracts";

import { admitSemanticProfile } from "./admission.js";
import { compareScope } from "./scope.js";
import { validateWorldSemantics } from "./world-validation.js";

const DEFAULT_WORK = 2_000_000;
const MAX_WORK = 50_000_000;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_RECEIPT_NODES = 75_000;
const CHECK_IDS = ["selection", "operations", "references", "pins", "explicit-opposition"] as const;
const LIMITATIONS = [
  "Validity covers only the five bounded checks under the bound semantic profile using bundled operations; it is not approval or a general historical truth judgment.",
  "Narrative prose, goals and direction are not interpreted as claims or executable instructions.",
  "Cardinality, causality and general inference (including age and succession rules) are not implemented.",
  "Explicit opposition compares only the exact same proposition with opposite polarity, comparable scope and recorded applicability; source accounts are not resolved.",
];

export class WorkspaceReviewBudgetError extends Error {
  readonly code = "WORKSPACE_REVIEW_BUDGET_EXHAUSTED";

  constructor(message = "Workspace review work or receipt budget exhausted") {
    super(message);
    this.name = "WorkspaceReviewBudgetError";
  }
}

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
function object(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, expected: readonly string[]): boolean {
  return object(value) && Object.keys(value as object).length === expected.length &&
    expected.every((key) => Object.hasOwn(value as object, key));
}
function text(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}
function version(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }
function portablePath(path: unknown): path is string {
  return text(path, 4096, 1) && /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$(?![\s\S])/.test(path);
}
function prosePath(path: unknown): path is string {
  return portablePath(path) && path.startsWith("prose/") && path.endsWith(".md");
}
function limitsFor(input: Partial<WorkspaceReviewLimitsV1>): WorkspaceReviewLimitsV1 {
  requireInput(object(input) && !types.isProxy(input) && Object.getPrototypeOf(input) === Object.prototype, "Review limits must be an ordinary data object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireInput(Reflect.ownKeys(input).every((key) => key === "maxWorkUnits"), "Unknown review limit");
  const property = descriptors["maxWorkUnits"];
  requireInput(property === undefined || ("value" in property && property.enumerable), "Review limits must be data properties");
  const maxWorkUnits: unknown = property === undefined ? DEFAULT_WORK : property.value;
  requireInput(Number.isSafeInteger(maxWorkUnits) && Number(maxWorkUnits) >= 1 && Number(maxWorkUnits) <= MAX_WORK,
    "maxWorkUnits must be an integer in [1, 50000000]");
  return { maxWorkUnits: maxWorkUnits as number };
}

/** Preflight precedes cloning, schema validation and hashing, including for typed callers.
 * Counts serialized occurrences (not just distinct objects), scalar bytes, keys and work
 * before allocation. Accessors/proxies are never evaluated to obtain JSON data. */
class Budget {
  private work = 0;
  constructor(readonly limits: WorkspaceReviewLimitsV1) {}
  charge(units = 1, message?: string): void {
    this.work += units;
    if (this.work > this.limits.maxWorkUnits) throw new WorkspaceReviewBudgetError(message);
  }
  measure(value: unknown, receipt = false): { nodes: number; bytes: number } {
    let nodes = 0;
    let bytes = 0;
    const ancestors = new Set<object>();
    const add = (n: number, b: number): void => {
      nodes += n;
      bytes += b;
      this.charge(n + b);
      if (receipt && (nodes > MAX_RECEIPT_NODES || bytes > MAX_RECEIPT_BYTES)) throw new WorkspaceReviewBudgetError();
    };
    const scalarString = (s: string): number => {
      this.charge(s.length);
      requireInput(s.isWellFormed(), "Review input contains non-scalar Unicode");
      return Buffer.byteLength(JSON.stringify(s), "utf8");
    };
    const visit = (node: unknown, depth: number): void => {
      if (depth > 128) throw new WorkspaceReviewBudgetError("Review JSON nesting budget exhausted");
      if (typeof node === "string") { add(1, scalarString(node)); return; }
      if (node === null || typeof node === "boolean" || typeof node === "number") {
        requireInput(typeof node !== "number" || Number.isSafeInteger(node), "Review numbers must be safe integers");
        add(1, JSON.stringify(node).length);
        return;
      }
      requireInput(typeof node === "object" && !types.isProxy(node), "Review input must be ordinary JSON data");
      requireInput(!ancestors.has(node), "Cyclic review input");
      const array = Array.isArray(node);
      requireInput(array || Object.getPrototypeOf(node) === Object.prototype, "Review input must have an ordinary JSON prototype");
      ancestors.add(node);
      try {
        if (array) this.charge(node.length);
        const own = Reflect.ownKeys(node);
        this.charge(own.length);
        requireInput(!array || own.length === node.length + 1, "Sparse or decorated arrays are not JSON");
        add(1, 2 + Math.max(0, own.length - (array ? 2 : 1)));
        for (const key of own) {
          if (array && key === "length") continue;
          requireInput(typeof key === "string", "JSON keys must be strings");
          requireInput(!array || (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < node.length), "Invalid JSON array index");
          const property = Object.getOwnPropertyDescriptor(node, key);
          requireInput(property !== undefined && "value" in property && property.enumerable, "JSON properties must be enumerable data properties");
          if (!array) add(0, scalarString(key) + 1);
          visit(property.value, depth + 1);
        }
      } finally { ancestors.delete(node); }
    };
    visit(value, 0);
    return { nodes, bytes };
  }
  json(value: unknown): string {
    const size = this.measure(value);
    this.charge(size.bytes);
    return canonicalJson(value as JsonValue);
  }
  clone<T>(value: T): T {
    const serialized = this.json(value);
    this.charge(Buffer.byteLength(serialized));
    return JSON.parse(serialized) as T;
  }
  bytes(value: unknown): Uint8Array {
    const size = this.measure(value);
    this.charge(size.bytes);
    return canonicalJsonBytes(value as JsonValue);
  }
  hash(bytes: Uint8Array): string { this.charge(bytes.length); return sha256Hex(bytes); }
  identity<T>(fn: (value: T) => string, value: T): string {
    const size = this.measure(value);
    this.charge(size.bytes * 2);
    return fn(value);
  }
  equal(left: unknown, right: unknown): boolean { return this.json(left) === this.json(right); }
}

type BindingState = Pick<WorkspaceStateV1, "format" | "id" | "version" | "base" | "goal" | "direction" | "pins"> & {
  readonly proposals: readonly Pick<ProposalGroupV1, "id" | "version" | "decision" | "operations">[];
};
type BindingBase = { readonly world: { readonly world: Pick<WorkspaceBaseV1["world"]["world"], "semanticProfileDigest"> } };

function bindingFor(state: BindingState, base: BindingBase, budget: Budget): WorkspaceReviewBindingV1 {
  requireInput(object(state) && state.format === "wmm.workspace/1" && text(state.id, 256, 1) && version(state.version), "Invalid workspace identity");
  requireInput(object(state.base) && text(state.base.worldId, 256, 1) && /^world:[a-z0-9_-]+$(?![\s\S])/.test(state.base.worldId) && digest(state.base.snapshotDigest), "Invalid workspace base binding");
  requireInput(object(base) && object(base.world) && object(base.world.world) && digest(base.world.world.semanticProfileDigest), "Missing base semantic profile binding");
  requireInput(text(state.goal, 16000) && text(state.direction, 16000), "Invalid workspace steering");
  requireInput(Array.isArray(state.proposals) && state.proposals.length <= 256 && Array.isArray(state.pins) && state.pins.length <= 256, "Invalid workspace proposal or pin list");
  for (const group of state.proposals) {
    requireInput(object(group) && text(group.id, 256, 1) && version(group.version) && ["selected", "undecided", "rejected"].includes(group.decision), "Invalid proposal identity or decision");
  }
  for (const pin of state.pins) requireInput(object(pin) && text(pin.id, 256, 1), "Invalid pin identity");
  const selected = state.proposals.filter((group) => group.decision === "selected").sort((a, b) => compare(a.id, b.id));
  const operations = selected.map((group) => ({ groupId: group.id, operations: group.operations }));
  const steering = { goal: state.goal, direction: state.direction, pins: [...state.pins].sort((a, b) => compare(a.id, b.id)) };
  return {
    worldId: state.base.worldId, workspaceId: state.id, workspaceVersion: state.version,
    baseSnapshotDigest: state.base.snapshotDigest, semanticProfileDigest: base.world.world.semanticProfileDigest,
    evaluator: "bundled-workspace-review-v1",
    selectedGroups: selected.map(({ id, version: groupVersion }) => ({ id, version: groupVersion })),
    operationsDigest: budget.identity((value) => framedJsonDigest("wmm.workspace-operations/v1", value as unknown as JsonValue), operations),
    steeringDigest: budget.identity((value) => framedJsonDigest("wmm.workspace-steering/v1", value as unknown as JsonValue), steering),
  };
}

function bindingField(value: unknown, key: string, budget: Budget): unknown {
  budget.charge(key.length + 1);
  requireInput(value !== null && typeof value === "object" && !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype, "Binding containers must be ordinary data objects");
  const property = Object.getOwnPropertyDescriptor(value, key);
  requireInput(property !== undefined && "value" in property && property.enumerable,
    "Bound fields must be own enumerable data properties");
  return property.value;
}

function bindingProposals(value: unknown, budget: Budget): unknown[] {
  requireInput(value !== null && typeof value === "object" && !types.isProxy(value) && Array.isArray(value) &&
    value.length <= 256, "Invalid workspace proposal list");
  const own = Reflect.ownKeys(value);
  budget.charge(own.length + value.length);
  requireInput(own.length === value.length + 1, "Sparse or decorated proposal arrays are not JSON");
  const selected = [];
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, index);
    requireInput(property !== undefined && "value" in property && property.enumerable,
      "Proposals must be own enumerable data elements");
    const group: unknown = property.value;
    const decision = bindingField(group, "decision", budget);
    requireInput(decision === "selected" || decision === "undecided" || decision === "rejected", "Invalid proposal decision");
    if (decision === "selected") selected.push({
      id: bindingField(group, "id", budget), version: bindingField(group, "version", budget), decision,
      operations: bindingField(group, "operations", budget),
    });
  }
  return selected;
}

/** Content binding only, not full admission or proof of validity. Inspect only bound
 * fields: retained payloads, history and unselected proposal content are not traversed. */
export function workspaceReviewBinding(state: WorkspaceStateV1, base: WorkspaceBaseV1): WorkspaceReviewBindingV1 {
  // Reviews can use custom limits up to this ceiling; binding those same executable
  // inputs must not fail merely because the review exceeded the default allowance.
  const budget = new Budget({ maxWorkUnits: MAX_WORK });
  const stateBase = bindingField(state, "base", budget);
  const catalog = bindingField(bindingField(base, "world", budget), "world", budget);
  const projection = budget.clone({
    state: {
      format: bindingField(state, "format", budget), id: bindingField(state, "id", budget),
      version: bindingField(state, "version", budget),
      base: { worldId: bindingField(stateBase, "worldId", budget), snapshotDigest: bindingField(stateBase, "snapshotDigest", budget) },
      goal: bindingField(state, "goal", budget), direction: bindingField(state, "direction", budget),
      proposals: bindingProposals(bindingField(state, "proposals", budget), budget),
      pins: bindingField(state, "pins", budget),
    },
    base: { world: { world: { semanticProfileDigest: bindingField(catalog, "semanticProfileDigest", budget) } } },
  }) as { state: BindingState; base: BindingBase };
  return bindingFor(projection.state, projection.base, budget);
}

function assertRecord(value: WorldRecordV1, format: WorldRecordV1["format"], budget: Budget): void {
  const size = budget.measure(value);
  requireInput(object(value) && value.format === format, `Invalid ${format} record`);
  if (value.format === "wmm.snapshot-record/1" && object(value.manifest) && Array.isArray(value.manifest.files)) {
    const count = value.manifest.files.length;
    // Object-valued uniqueItems can compare every pair deeply. Each entry occurs
    // in count - 1 pairs; the measured whole snapshot conservatively bounds their
    // total nodes/scalar bytes. Reserve before either base or candidate validation.
    budget.charge(count * Math.max(0, count - 1) / 2 + Math.max(0, count - 1) * (size.nodes + size.bytes),
      "Snapshot manifest uniqueness comparison budget exhausted");
  }
  requireInput(validateWorldRecord(value).valid, `Invalid ${format} record`);
}
function semanticInput(world: WorkspaceBaseV1["world"]) {
  return {
    world: world.world, definitionsByDigest: Object.fromEntries(world.definitions.map(({ digest: id, body }) => [id, body])),
    descriptors: world.descriptors, sources: world.sources, assertions: world.assertions,
    supports: world.supports, rosters: world.rosters,
  };
}
function validateSemantics(world: WorkspaceBaseV1["world"], budget: Budget): void {
  const input = semanticInput(world);
  budget.measure(input);
  validateWorldSemantics(input);
}
function sourceIntegrity(base: WorkspaceBaseV1): void {
  const files = new Map(base.snapshot.manifest.files.map((file) => [file.path, file]));
  for (const source of base.world.sources) {
    if (source.content.availability === "bundled") {
      requireInput(files.get(source.content.path)?.sha256 === source.content.sha256,
        "Bundled source bytes differ from their immutable source content digest");
    }
  }
}

/** Reconstruct every pinned payload entry from retained data, rather than trusting
 * a caller's snapshot wrapper or document metadata as evidence of those bytes. */
function admitBase(state: WorkspaceStateV1, base: WorkspaceBaseV1, budget: Budget): void {
  assertRecord(base.snapshot, "wmm.snapshot-record/1", budget);
  const exported = base.world;
  requireInput(exported.format === "wmm.world-export/1", "Invalid world export");
  assertRecord(exported.world, "wmm.world/1", budget);
  requireInput(base.snapshot.manifest.worldId === state.base.worldId && exported.world.worldId === state.base.worldId &&
    base.snapshot.snapshotDigest === state.base.snapshotDigest && exported.snapshotDigest === state.base.snapshotDigest &&
    budget.identity(snapshotDigest, base.snapshot.manifest) === state.base.snapshotDigest, "Base world or snapshot digest mismatch");
  requireInput(budget.identity(semanticProfileDigest, exported.semanticProfile) === exported.world.semanticProfileDigest, "Semantic profile identity mismatch");
  for (const name of ["definitions", "rosters", "descriptors", "sources", "assertions", "supports", "documents"] as const) {
    requireInput(Array.isArray(exported[name]), `Missing base ${name}`);
  }
  requireInput(Array.isArray(base.documents), "Missing retained document bytes");
  const files = new Map<string, SnapshotFileEntryV1>();
  const folded = new Set<string>();
  let previous = "";
  for (const file of base.snapshot.manifest.files) {
    requireInput(portablePath(file.path) && file.path > previous, "Manifest paths must be portable, sorted and unique");
    const path = file.path.toLowerCase();
    requireInput(!folded.has(path), "Case-folded base path collision");
    for (const part of path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))) {
      budget.charge(part.length + 1);
      requireInput(!folded.has(part), "Base file/directory collision");
    }
    folded.add(path);
    files.set(file.path, file);
    previous = file.path;
  }
  const reconstructed = new Set<string>();
  const verifyBytes = (path: string, mediaType: string, bytes: Uint8Array): void => {
    const entry = files.get(path);
    requireInput(!reconstructed.has(path) && entry !== undefined && entry.mediaType === mediaType &&
      entry.byteLength === String(bytes.length) && entry.sha256 === budget.hash(bytes), "Retained payload does not match the base manifest");
    reconstructed.add(path);
  };
  const verifyJson = (path: string, value: unknown): void => verifyBytes(path, "application/json", budget.bytes(value));
  verifyJson("world.json", exported.world);
  verifyJson(`types/${exported.world.semanticProfileDigest}.json`, exported.semanticProfile);
  const definitionIds: string[] = [];
  for (const definition of exported.definitions) {
    requireInput(object(definition) && digest(definition.digest) && budget.identity(semanticDefinitionDigest, definition.body) === definition.digest, "Semantic definition identity mismatch");
    definitionIds.push(definition.digest);
    verifyJson(`types/${definition.digest}.json`, definition.body);
  }
  requireInput(budget.equal([...definitionIds].sort(compare), exported.semanticProfile.definitions), "Profile definition set mismatch");
  const definitions = exported.definitions.map(({ body }) => body);
  budget.measure({ profile: exported.semanticProfile, definitions });
  // The adapter captures the profile's authority. Re-admission here checks the
  // pinned data's grammar, operation roles and dependency closure, not external trust.
  admitSemanticProfile({
    profile: exported.semanticProfile, definitions,
    trustedDefinitionDigests: new Set(definitionIds),
    trustedProfileDigests: new Set([exported.world.semanticProfileDigest]),
  });
  const verifyRecords = (records: readonly WorldRecordV1[], ids: readonly string[], format: WorldRecordV1["format"], path: (id: string) => string): void => {
    const observed: string[] = [];
    for (const record of records) {
      assertRecord(record, format, budget);
      requireInput("id" in record, "Missing record ID");
      if (record.format === "wmm.assertion-record/1") requireInput(budget.identity(assertionId, record.body) === record.id, "Base assertion identity mismatch");
      if (record.format === "wmm.support-record/1") requireInput(budget.identity(supportId, record.body) === record.id, "Base support identity mismatch");
      observed.push(record.id);
      verifyJson(path(record.id), record);
    }
    requireInput(budget.equal(observed.sort(compare), ids), "Catalog and retained record set differ");
  };
  verifyRecords(exported.descriptors, exported.world.descriptorIds, "wmm.descriptor/1", (id) => `records/descriptors/${id.replace(":", "/")}.json`);
  verifyRecords(exported.sources, exported.world.sourceIds, "wmm.source/1", (id) => `records/sources/${id.slice(7)}.json`);
  verifyRecords(exported.assertions, exported.world.assertionIds, "wmm.assertion-record/1", (id) => `records/assertions/${id.slice(5)}.json`);
  verifyRecords(exported.supports, exported.world.supportIds, "wmm.support-record/1", (id) => `records/supports/${id.slice(4)}.json`);
  for (const roster of exported.rosters) {
    requireInput(object(roster) && digest(roster.digest) && budget.identity(populationRosterDigest, roster.body) === roster.digest, "Roster identity mismatch");
    verifyJson(`rosters/${roster.digest}.json`, roster.body);
  }
  const metadata = [];
  for (const document of base.documents) {
    requireInput(object(document) && portablePath(document.path) && document.path !== "world.json" &&
          !["records/", "types/", "rosters/"].some((prefix) => document.path.startsWith(prefix)) &&
          typeof document.base64 === "string" && digest(document.sha256), "Invalid retained document");
    budget.charge(document.base64.length * 2);
    const bytes = Buffer.from(document.base64, "base64");
    requireInput(bytes.toString("base64") === document.base64, "Document base64 must encode exact bytes canonically");
    requireInput(budget.hash(bytes) === document.sha256, "Document byte digest mismatch");
    verifyBytes(document.path, document.mediaType, bytes);
    metadata.push({ path: document.path, mediaType: document.mediaType, sha256: document.sha256, byteLength: String(bytes.length) });
  }
  requireInput(reconstructed.size === files.size, "Base manifest contains unretained or reserved payload entries");
  requireInput(budget.equal(metadata.sort((a, b) => compare(a.path, b.path)), [...exported.documents].sort((a, b) => compare(a.path, b.path))), "Exported document metadata differs from retained bytes");
  validateSemantics(exported, budget);
  sourceIntegrity(base);
}

type Write = { operation: Extract<WorkspaceOperationV1, { kind: "write-prose" }>; groupIds: string[] };
type Effect = { record: AssertionRecordV1; activate: string[]; deactivate: string[] };
type Report = (code: string, severity: "error" | "warning", message: string, groupIds?: readonly string[], assertionIds?: readonly string[]) => void;

function selectionChecks(state: WorkspaceStateV1, selected: readonly ProposalGroupV1[], report: Report, budget: Budget): void {
  const groups = new Map<string, ProposalGroupV1>();
  for (const group of state.proposals) {
    if (groups.has(group.id)) report("DUPLICATE_GROUP", "error", "Proposal IDs must be unique.", [group.id]);
    groups.set(group.id, group);
  }
  if (selected.length === 0) report("EMPTY_SELECTION", "error", "Select at least one explicit proposal group before reviewing a candidate.");
  const selectedIds = new Set(selected.map((group) => group.id));
  for (const group of selected) {
    for (const name of ["dependencies", "exclusions"] as const) {
      const refs = group[name];
      if (!Array.isArray(refs) || refs.length > 256 || !refs.every((id) => text(id, 256, 1))) {
        report("INVALID_GROUP_REFERENCES", "error", "Dependencies and exclusions must be bounded group ID lists.", [group.id]);
        continue;
      }
      for (const id of unique(refs)) {
        budget.charge(id.length + 1);
        if (!groups.has(id) || id === group.id) report("INVALID_GROUP_REFERENCE", "error", "A selected group has an unknown or self reference.", [group.id]);
        else if (name === "dependencies" && !selectedIds.has(id)) report("MISSING_PREREQUISITE", "error", "A required group is not explicitly selected; dependencies are never auto-selected.", [group.id, id]);
        else if (name === "exclusions" && selectedIds.has(id)) report("INCOMPATIBLE_ALTERNATIVES", "error", "Explicitly selected groups exclude one another.", [group.id, id]);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    budget.charge();
    if (visiting.has(id)) { report("DEPENDENCY_CYCLE", "error", "Selected dependencies contain a cycle.", [id]); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const group = groups.get(id)!;
    if (Array.isArray(group.dependencies)) for (const dependency of group.dependencies) if (selectedIds.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const group of selected) visit(group.id);
}

function collectEffects(selected: readonly ProposalGroupV1[], base: WorkspaceBaseV1, report: Report, budget: Budget) {
  const documents = new Map(base.documents.map((document) => [document.path, document]));
  const records = new Map(base.world.assertions.map((record) => [record.id, record]));
  const active = new Set(base.world.world.activeAssertionIds);
  const writes = new Map<string, Write>();
  const effects = new Map<string, Effect>();
  for (const group of selected) {
    if (!Array.isArray(group.operations) || group.operations.length === 0 || group.operations.length > 256) {
      report("INVALID_OPERATIONS", "error", "A selected group needs between one and 256 explicit operations.", [group.id]);
      continue;
    }
    for (const operation of group.operations) {
      budget.charge();
      try {
        requireInput(object(operation), "An operation must be a data object");
        switch (operation.kind) {
          case "write-prose": {
            requireInput(keys(operation, ["kind", "path", "text", "beforeSha256"]) && prosePath(operation.path) && text(operation.text, 65536), "Only explicit portable prose/**/*.md UTF-8 writes are supported");
            const original = documents.get(operation.path);
            requireInput(original === undefined || original.mediaType === "text/markdown", "Only Markdown documents can be revised");
            requireInput(operation.beforeSha256 === (original?.sha256 ?? null), "Prose beforeSha256 does not bind the exact base document");
            for (const file of base.snapshot.manifest.files) {
              budget.charge(file.path.length + operation.path.length + 1);
              const a = file.path.toLowerCase();
              const b = operation.path.toLowerCase();
              requireInput(!(a === b && file.path !== operation.path) && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`), "Prose path collides with a base file or directory");
              requireInput(a !== b || original !== undefined, "Prose cannot overwrite a reserved manifest entry");
            }
            for (const write of writes.values()) {
              const other = write.operation;
              budget.charge(other.path.length + operation.path.length + 1);
              const a = other.path.toLowerCase();
              const b = operation.path.toLowerCase();
              if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
                budget.charge(other.text.length + operation.text.length);
                if (other.path !== operation.path || other.text !== operation.text || other.beforeSha256 !== operation.beforeSha256) {
                  report("CONFLICTING_WRITES", "error", "Selected writes conflict at the same, case-folded or ancestor path; there is no last-writer-wins.", [...write.groupIds, group.id]);
                }
              }
            }
            const existing = writes.get(operation.path);
            if (existing === undefined) writes.set(operation.path, { operation, groupIds: [group.id] });
            else existing.groupIds = unique([...existing.groupIds, group.id]);
            break;
          }
          case "activate-assertion": {
            requireInput(keys(operation, ["kind", "assertion"]), "Invalid activation operation shape");
            const record = operation.assertion;
            assertRecord(record, "wmm.assertion-record/1", budget);
            requireInput(record.id === budget.identity(assertionId, record.body) && record.body.worldId === base.world.world.worldId &&
              record.body.semanticProfileDigest === base.world.world.semanticProfileDigest, "Assertion identity, world or profile mismatch");
            const existing = records.get(record.id);
            requireInput(existing === undefined || budget.equal(existing, record), "An immutable assertion cannot be reassigned");
            const effect = effects.get(record.id) ?? { record, activate: [], deactivate: [] };
            requireInput(budget.equal(effect.record, record), "Conflicting immutable assertion bodies");
            effect.activate = unique([...effect.activate, group.id]);
            effects.set(record.id, effect);
            break;
          }
          case "deactivate-assertion": {
            requireInput(keys(operation, ["kind", "assertionId"]) && active.has(operation.assertionId), "Only active pinned-base assertions can be deactivated");
            const record = records.get(operation.assertionId)!;
            const effect = effects.get(record.id) ?? { record, activate: [], deactivate: [] };
            effect.deactivate = unique([...effect.deactivate, group.id]);
            effects.set(record.id, effect);
            break;
          }
          default: throw new TypeError("Unsupported workspace operation");
        }
      } catch (error) {
        if (error instanceof WorkspaceReviewBudgetError) throw error;
        report("INVALID_OPERATION", "error", error instanceof Error ? error.message : "Operation admission failed.", [group.id]);
      }
    }
  }
  for (const [id, effect] of effects) {
    if (effect.activate.length > 0 && effect.deactivate.length > 0) report("CONFLICTING_ASSERTION_EFFECTS", "error", "The same assertion is both activated and deactivated, including within a single group.", [...effect.activate, ...effect.deactivate], [id]);
  }
  return { writes, effects };
}

function preview(value: string): string {
  let end = Math.min(value.length, 16000);
  if (!value.slice(0, end).isWellFormed()) end -= 1;
  return value.slice(0, end);
}
function compile(base: WorkspaceBaseV1, writes: ReadonlyMap<string, Write>, effects: ReadonlyMap<string, Effect>, budget: Budget): { candidate: WorkspaceBaseV1; diff: WorkspaceReviewDiffV1 } {
  const files = new Map(base.snapshot.manifest.files.map((entry) => [entry.path, entry]));
  const documents = new Map(base.documents.map((document) => [document.path, document]));
  const metadata = new Map(base.world.documents.map((document) => [document.path, document]));
  const assertions = new Map(base.world.assertions.map((record) => [record.id, record]));
  const active = new Set(base.world.world.activeAssertionIds);
  const documentDiff: WorkspaceReviewDiffV1["documents"][number][] = [];
  const assertionDiff: WorkspaceReviewDiffV1["assertions"][number][] = [];
  const jsonFile = (path: string, value: unknown): void => {
    const bytes = budget.bytes(value);
    files.set(path, { path, mediaType: "application/json", byteLength: String(bytes.length), sha256: budget.hash(bytes) });
  };
  for (const [path, { operation, groupIds }] of [...writes].sort(([a], [b]) => compare(a, b))) {
    budget.charge(operation.text.length * 2);
    const bytes = Buffer.from(operation.text, "utf8");
    const sha256 = budget.hash(bytes);
    const original = documents.get(path);
    let before: string | null = null;
    if (original !== undefined) {
      budget.charge(original.base64.length);
      before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(original.base64, "base64"));
    }
    const mediaType = "text/markdown";
    files.set(path, { path, mediaType, byteLength: String(bytes.length), sha256 });
    documents.set(path, { path, mediaType, sha256, base64: bytes.toString("base64") });
    metadata.set(path, { path, mediaType, sha256, byteLength: String(bytes.length) });
    if (before !== operation.text) documentDiff.push({
      path, kind: original === undefined ? "added" : "modified", beforeSha256: original?.sha256 ?? null, afterSha256: sha256,
      before: before === null ? null : preview(before), after: preview(operation.text),
      truncated: (before?.length ?? 0) > 16000 || operation.text.length > 16000, groupIds,
    });
  }
  for (const [id, effect] of [...effects].sort(([a], [b]) => compare(a, b))) {
    if (effect.activate.length > 0) {
      if (!assertions.has(id)) { assertions.set(id, effect.record); jsonFile(`records/assertions/${id.slice(5)}.json`, effect.record); }
      if (!active.has(id)) assertionDiff.push({ id, kind: "activated", body: effect.record.body, groupIds: effect.activate });
      active.add(id);
    } else {
      active.delete(id);
      assertionDiff.push({ id, kind: "deactivated", body: effect.record.body, groupIds: effect.deactivate });
    }
  }
  const world = { ...base.world.world, assertionIds: [...assertions.keys()].sort(compare), activeAssertionIds: [...active].sort(compare) };
  jsonFile("world.json", world);
  const manifest = { ...base.snapshot.manifest, files: [...files.values()].sort((a, b) => compare(a.path, b.path)) };
  const digest = budget.identity(snapshotDigest, manifest);
  const snapshot = { ...base.snapshot, snapshotDigest: digest, manifest };
  // The snapshot contract currently has narrower paths than the workspace contract.
  assertRecord(snapshot, "wmm.snapshot-record/1", budget);
  const candidate: WorkspaceBaseV1 = {
    snapshot, documents: [...documents.values()].sort((a, b) => compare(a.path, b.path)),
    world: { ...base.world, snapshotDigest: digest, world, assertions: [...assertions.values()].sort((a, b) => compare(a.id, b.id)), documents: [...metadata.values()].sort((a, b) => compare(a.path, b.path)) },
  };
  budget.measure(candidate);
  if (documentDiff.length > 256 || assertionDiff.length > 1024) throw new WorkspaceReviewBudgetError("Review diff cardinality budget exhausted");
  return { candidate, diff: { documents: documentDiff, assertions: assertionDiff } };
}

type Extent = { start: bigint | null; end: bigint | null; exact: boolean };
function extent(value: ApplicabilityV1, budget: Budget): Extent {
  const integer = (s: string): bigint => { budget.charge(s.length * s.length + 1); return BigInt(s); };
  if (value.kind === "invariant") return { start: null, end: null, exact: true };
  if (value.kind === "point") {
    const p = value.position;
    if (p.kind === "exact") { const t = integer(p.position); return { start: t, end: t + 1n, exact: true }; }
    return p.kind === "unknown" ? { start: null, end: null, exact: false }
      : { start: integer(p.lowerInclusive), end: integer(p.upperExclusive), exact: false };
  }
  const start = value.start;
  const end = value.endExclusive;
  return {
    start: start.kind === "exact" ? integer(start.position) : start.kind === "boundedUnknown" ? integer(start.lowerInclusive) : null,
    end: end.kind === "exact" ? integer(end.position) : end.kind === "boundedUnknown" ? integer(end.upperExclusive) - 1n : null,
    exact: (start.kind === "exact" || start.kind === "unboundedPast") && (end.kind === "exact" || end.kind === "unboundedFuture"),
  };
}

function exactIntersectionQuery(value: ApplicabilityV1): TemporalQueryV1 | null {
  if (value.kind === "point" && value.position.kind === "exact") return {
    format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: value.axisDefinitionDigest, position: value.position.position,
  };
  if (value.kind === "interval" && value.start.kind === "exact" && value.endExclusive.kind === "exact") return {
    format: "wmm.temporal-query/1", mode: "intersects", axisDefinitionDigest: value.axisDefinitionDigest,
    start: value.start.position, endExclusive: value.endExclusive.position,
  };
  return null;
}

function applicabilityEvaluationWork(value: ApplicabilityV1): number {
  if (value.kind === "invariant") return 1;
  const positions = value.kind === "point" ? [value.position] : [value.start, value.endExclusive];
  let cost = 1;
  for (const position of positions) {
    if (position.kind === "exact") cost += position.position.length ** 2;
    if (position.kind === "boundedUnknown") cost += position.lowerInclusive.length ** 2 + position.upperExclusive.length ** 2;
  }
  // Reserve repeated parsing, discrete-chronon arithmetic and feasibility checks,
  // including bounds not needed by the coarse possible-extent envelope.
  return cost * 8;
}

function oppositionChecker(candidate: WorkspaceBaseV1, budget: Budget) {
  const axes = new Set(candidate.world.definitions.filter(({ body }) => body.kind === "axis" &&
    body.operation === "integer-chronon-half-open-v1").map(({ digest }) => digest));
  const prepared = new Map<string, { proposition: string; extent: Extent; cost: number; query: TemporalQueryV1 | null; evaluationWork: number }>();
  const prepare = (record: AssertionRecordV1) => {
    let value = prepared.get(record.id);
    if (value === undefined) {
      value = {
        proposition: budget.json(record.body.proposition), extent: extent(record.body.applicability, budget),
        cost: budget.measure(record.body).bytes, query: exactIntersectionQuery(record.body.applicability),
        evaluationWork: applicabilityEvaluationWork(record.body.applicability),
      };
      prepared.set(record.id, value);
    }
    return value;
  };
  return (left: AssertionRecordV1, right: AssertionRecordV1): "different" | "opposed" | "unresolved-scope" | "unmapped-axis" | "uncertain-applicability" | "unsupported-applicability-comparison" => {
    const a = prepare(left);
    const b = prepare(right);
    budget.charge(1 + a.cost + b.cost);
    if (left.body.polarity === right.body.polarity || a.proposition !== b.proposition) return "different";
    const scope = compareScope(left.body.scope, right.body.scope);
    if (scope.result === "different") return "different";
    const x = left.body.applicability;
    const y = right.body.applicability;
    if (x.kind !== "invariant" && y.kind !== "invariant" && x.axisDefinitionDigest !== y.axisDefinitionDigest) return "unmapped-axis";
    for (const applicability of [x, y]) {
      if (applicability.kind !== "invariant" && !axes.has(applicability.axisDefinitionDigest)) return "unmapped-axis";
    }
    let temporal: "opposed" | "uncertain-applicability" | "unsupported-applicability-comparison" = "opposed";
    // Combined semantic admission already established that every admissible
    // extent is nonempty, so invariance guarantees intersection even with unknown bounds.
    if (x.kind !== "invariant" && y.kind !== "invariant") {
      const query = b.query ?? a.query;
      if (query !== null) {
        budget.charge(a.evaluationWork + b.evaluationWork, "Workspace opposition temporal evaluation budget exhausted");
        const comparison = evaluateApplicability(b.query !== null ? x : y, query);
        if (comparison.kind === "comparable") {
          if (comparison.truth === "never") return "different";
          if (comparison.truth === "sometimes") temporal = "uncertain-applicability";
        } else if (comparison.kind === "incomparable" && comparison.reason === "unmappedAxis") return "unmapped-axis";
        else temporal = "unsupported-applicability-comparison";
      } else {
        if ((a.extent.end !== null && b.extent.start !== null && a.extent.end <= b.extent.start) ||
          (b.extent.end !== null && a.extent.start !== null && b.extent.end <= a.extent.start)) return "different";
        if (!a.extent.exact || !b.extent.exact) temporal = "unsupported-applicability-comparison";
      }
    }
    return scope.result === "unresolved" ? "unresolved-scope" : temporal;
  };
}

/** Pure, bounded evaluation of exactly the explicitly selected proposal effects.
 * A compiled candidate is hypothetical, even when its bounded review is valid. */
export function reviewWorkspace(
  state: WorkspaceStateV1, base: WorkspaceBaseV1, requestedLimits: Partial<WorkspaceReviewLimitsV1> = {},
): { candidate: WorkspaceBaseV1 | null; review: WorkspaceReviewV1 } {
  const limits = limitsFor(requestedLimits);
  const budget = new Budget(limits);
  state = budget.clone(state);
  base = budget.clone(base);
  const binding = bindingFor(state, base, budget);
  const candidateDigest = budget.identity(workspaceCandidateDigest, binding);
  const selected = state.proposals.filter((group) => group.decision === "selected").sort((a, b) => compare(a.id, b.id));
  const diagnostics: WorkspaceReviewDiagnosticV1[] = [];
  let errorCount = 0;
  const checks: { id: typeof CHECK_IDS[number]; status: WorkspaceReviewBodyV1["checks"][number]["status"] }[] = CHECK_IDS.map((id) => ({ id, status: "blocked" }));
  const setCheck = (id: typeof CHECK_IDS[number], status: WorkspaceReviewBodyV1["checks"][number]["status"]): void => { checks.find((check) => check.id === id)!.status = status; };
  const report: Report = (code, severity, message, groupIds = [], assertionIds = []) => {
    if (diagnostics.length === 1024) throw new WorkspaceReviewBudgetError("Review diagnostic cardinality budget exhausted");
    const diagnostic = { code, severity, message: preview(message), groupIds: unique(groupIds), assertionIds: unique(assertionIds) };
    budget.measure(diagnostic, true);
    diagnostics.push(diagnostic);
    if (severity === "error") errorCount += 1;
  };
  const errors = (): number => errorCount;
  let candidate: WorkspaceBaseV1 | null = null;
  let diff: WorkspaceReviewDiffV1 = { documents: [], assertions: [] };
  selectionChecks(state, selected, report, budget);
  setCheck("selection", errors() === 0 ? "passed" : "failed");
  if (errors() === 0) {
    try { admitBase(state, base, budget); }
    catch (error) {
      if (error instanceof WorkspaceReviewBudgetError) throw error;
      report("INVALID_BASE", "error", error instanceof Error ? error.message : "Base admission failed.");
    }
    if (errors() === 0) {
      const { writes, effects } = collectEffects(selected, base, report, budget);
      if (errors() === 0) {
        try { ({ candidate, diff } = compile(base, writes, effects, budget)); }
        catch (error) {
          if (error instanceof WorkspaceReviewBudgetError) throw error;
          report("CANDIDATE_COMPILATION_FAILED", "error", error instanceof Error ? error.message : "Candidate compilation failed.");
        }
      }
      setCheck("operations", candidate === null ? "failed" : "passed");
      if (candidate !== null) {
        const beforeReferences = errors();
        try { validateSemantics(candidate.world, budget); }
        catch (error) {
          if (error instanceof WorkspaceReviewBudgetError) throw error;
          report("INVALID_REFERENCES", "error", error instanceof Error ? error.message : "Combined semantic reference validation failed.");
        }
        try { budget.charge(candidate.world.sources.length + candidate.snapshot.manifest.files.length); sourceIntegrity(candidate); }
        catch (error) {
          if (error instanceof WorkspaceReviewBudgetError) throw error;
          report("SOURCE_DIGEST_MISMATCH", "error", "A bundled source's immutable content digest does not match candidate bytes.");
        }
        setCheck("references", errors() === beforeReferences ? "passed" : "failed");
        if (errors() === beforeReferences) {
          const opposition = oppositionChecker(candidate, budget);
          const activeIds = new Set(candidate.world.world.activeAssertionIds);
          const active = candidate.world.assertions.filter((record) => activeIds.has(record.id));
          const records = new Map(base.world.assertions.map((record) => [record.id, record]));
          const candidateRecords = new Map(candidate.world.assertions.map((record) => [record.id, record]));
          const baseActiveIds = new Set(base.world.world.activeAssertionIds);
          const baseDocuments = new Map(base.documents.map((document) => [document.path, document]));
          const candidateDocuments = new Map(candidate.documents.map((document) => [document.path, document]));
          const provenance = (id: string): string[] => effects.get(id)?.activate ?? [];
          const beforePins = errors();
          let unresolvedPins = false;
          const pinIds = new Set<string>();
          for (const pin of [...state.pins].sort((a, b) => compare(a.id, b.id))) {
            budget.charge();
            if (pinIds.has(pin.id)) report("DUPLICATE_PIN", "error", "Pin IDs must be unique.");
            pinIds.add(pin.id);
            if (typeof pin.active !== "boolean") { report("INVALID_PIN", "error", "Pin active must be a boolean."); continue; }
            if (!pin.active) continue;
            if (pin.kind === "document") {
              budget.charge(typeof pin.path === "string" ? pin.path.length + 128 : 1);
              const original = baseDocuments.get(pin.path);
              const changed = candidateDocuments.get(pin.path);
              if (!keys(pin, ["id", "kind", "path", "sha256", "active"]) || original === undefined || original.sha256 !== pin.sha256) report("INVALID_PIN", "error", "A document pin must bind the exact base document digest.");
              else if (changed?.sha256 !== pin.sha256) report("PIN_CHANGED", "error", "A protected document's exact bytes changed.", writes.get(pin.path)?.groupIds);
            } else if (pin.kind === "assertion") {
              const original = records.get(pin.assertionId);
              if (!keys(pin, ["id", "kind", "assertionId", "active"]) || original === undefined || !baseActiveIds.has(pin.assertionId)) {
                report("INVALID_PIN", "error", "An assertion pin must identify an active base assertion.");
                continue;
              }
              const retained = candidateRecords.get(pin.assertionId);
              if (!activeIds.has(pin.assertionId) || retained === undefined || !budget.equal(original.body, retained.body)) report("PIN_CHANGED", "error", "A protected assertion must retain its exact immutable body and active status.", effects.get(pin.assertionId)?.deactivate, [pin.assertionId]);
              for (const addition of active) {
                budget.charge();
                if (baseActiveIds.has(addition.id)) continue;
                const result = opposition(original, addition);
                if (result === "different") continue;
                if (result === "opposed") report("PIN_OPPOSITION", "error", "An activated assertion explicitly opposes a protected claim in the same scope and intersecting applicability.", provenance(addition.id), [original.id, addition.id]);
                else { unresolvedPins = true; report("PIN_OPPOSITION_UNRESOLVED", "warning", `Protection comparison is unresolved: ${result}.`, provenance(addition.id), [original.id, addition.id]); }
              }
            } else report("INVALID_PIN", "error", "Unsupported active pin kind.");
          }
          setCheck("pins", errors() > beforePins ? "failed" : unresolvedPins ? "unresolved" : "passed");
          const beforeOpposition = errors();
          let unresolvedOpposition = false;
          for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
            const left = active[i]!;
            const right = active[j]!;
            const result = opposition(left, right);
            if (result === "different") continue;
            const groupIds = [...provenance(left.id), ...provenance(right.id)];
            if (result === "opposed") report("EXPLICIT_OPPOSITION", "error", "Active assertions have the exact same proposition, opposite polarity, the same scope and definitely intersecting applicability.", groupIds, [left.id, right.id]);
            else { unresolvedOpposition = true; report("OPPOSITION_UNRESOLVED", "warning", `Explicit-opposition comparison is unresolved: ${result}.`, groupIds, [left.id, right.id]); }
          }
          setCheck("explicit-opposition", errors() > beforeOpposition ? "failed" : unresolvedOpposition ? "unresolved" : "passed");
        }
      }
    } else setCheck("operations", "failed");
  }
  const ordered = diagnostics.map((diagnostic) => ({ diagnostic, key: budget.json(diagnostic) }));
  ordered.sort((a, b) => { budget.charge(a.key.length + b.key.length + 1); return compare(a.key, b.key); });
  const body: WorkspaceReviewBodyV1 = {
    format: "wmm.workspace-review/1", binding, candidateDigest, candidateSnapshotDigest: candidate?.snapshot.snapshotDigest ?? null,
    limits, execution: "completed",
    validity: errors() > 0 ? "invalid" : candidate !== null && checks.every((check) => check.status === "passed") ? "valid" : "undetermined",
    checks, diff, diagnostics: ordered.map(({ diagnostic }) => diagnostic), limitations: LIMITATIONS,
  };
  // Include the final digest field in the size reservation, before hashing or returning.
  budget.measure({ ...body, evaluationDigest: "0".repeat(64) }, true);
  const review = { ...body, evaluationDigest: budget.identity(workspaceReviewDigest, body) };
  return { candidate, review: budget.clone(review) };
}

/** Replay, not hash-as-proof: forged self-consistent hashes and forged limits do
 * not bypass any check. Malformed/oversized receipts and exhausted replays fail closed. */
export function verifyWorkspaceReviewReceipt(receipt: WorkspaceReviewV1, state: WorkspaceStateV1, base: WorkspaceBaseV1): boolean {
  try {
    const budget = new Budget({ maxWorkUnits: MAX_WORK });
    budget.measure(receipt, true);
    const supplied = budget.clone(receipt);
    const limits = limitsFor(supplied.limits);
    const recomputed = reviewWorkspace(state, base, limits).review;
    return budget.equal(supplied, recomputed);
  } catch { return false; }
}
