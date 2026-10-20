import { isDeepStrictEqual } from "node:util";

import { intervalAbsenceEvaluationDigest } from "@wmm/canonical";
import {
  assertValidTemporalQuery, evaluateApplicability, exactApplicabilityChanges, TemporalInputError,
} from "@wmm/temporal";
import type {
  AssertionRecordV1, ExistsV1, IntervalAbsenceCellV1, IntervalAbsenceEvaluationBodyV1,
  IntervalAbsenceLimitsV1, IntervalAbsenceResultV1, IntervalConstancyDeclarationV1,
  IntervalPartitionIssueV1, ScopeV1, SemanticDefinitionV1, SemanticOperationV1,
  TemporalQueryV1,
} from "@wmm/wire-contracts";
import { validateSemanticContract } from "@wmm/wire-contracts";

import {
  activeAssertions, queryAbsence, resolveBindings, verifyAbsenceReceiptIntegrity,
  type ValidatedAbsenceQuerySnapshotV1,
} from "./absence.js";
import { populationCoverageBasis } from "./population.js";
import { ClaimQueryInputError } from "./query.js";
import { compareScope } from "./scope.js";

const DEFAULT_LIMITS: IntervalAbsenceLimitsV1 = { maxCells: 256, maxWorkUnits: 2_000_000 };
const MAX_RECEIPT_NODES = 150_000;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export class IntervalAbsenceBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntervalAbsenceBudgetError";
  }
}

function limitsFor(input: Partial<IntervalAbsenceLimitsV1>): IntervalAbsenceLimitsV1 {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, maximum] of [["maxCells", 1024], ["maxWorkUnits", 50_000_000]] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum) {
      throw new ClaimQueryInputError("INVALID_QUERY", `${name} must be an integer in [1, ${maximum}]`);
    }
  }
  return limits;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function numericSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}
function issueKey(issue: IntervalPartitionIssueV1): string { return `${issue.assertionId ?? ""}:${issue.reason}`; }

/** Only these implementation-owned operations have recorded-applicability constancy. */
const RECORDED_OPERATIONS: ReadonlySet<SemanticOperationV1> = new Set([
  "population-membership-atom-v1", "population-coverage-atom-v1", "criterion-satisfaction-atom-v1",
  "bundled-candidate-membership-v1", "bundled-candidate-selector-v1", "bundled-eligibility-v1",
  "descriptor-type-v1", "population-coverage-basis-v1", "integer-chronon-half-open-v1",
]);

function definitionClosure(
  roots: readonly string[], definitions: Readonly<Record<string, SemanticDefinitionV1>>,
): string[] | undefined {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const digest = pending.pop()!;
    if (seen.has(digest)) continue;
    seen.add(digest);
    const definition = definitions[digest];
    if (definition === undefined || !RECORDED_OPERATIONS.has(definition.operation)) return undefined;
    pending.push(...definition.dependencies);
  }
  return [...seen].sort(compareText);
}

/** Counts serialized occurrences, including repeated contexts, keys and escaped UTF-8 scalars. */
function measureJson(value: unknown, visit: (nodes: number, bytes: number) => void): { nodes: number; bytes: number } {
  let nodes = 0;
  let bytes = 0;
  function add(nodeCount: number, byteCount: number): void {
    visit(nodeCount, byteCount);
    nodes += nodeCount;
    bytes += byteCount;
  }
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") {
      add(1, Buffer.byteLength(JSON.stringify(node), "utf8"));
    } else if (Array.isArray(node)) {
      add(1, 2 + Math.max(0, node.length - 1));
      for (const child of node) walk(child);
    } else {
      const entries = Object.entries(node);
      add(1, 2 + Math.max(0, entries.length - 1));
      for (const [key, child] of entries) {
        add(0, Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        walk(child);
      }
    }
  }
  walk(value);
  return { nodes, bytes };
}

export function proveAbsenceThroughout(
  snapshot: ValidatedAbsenceQuerySnapshotV1,
  target: ExistsV1,
  scope: ScopeV1,
  temporal: TemporalQueryV1,
  requestedLimits: Partial<IntervalAbsenceLimitsV1> = {},
): IntervalAbsenceResultV1 {
  try {
    assertValidTemporalQuery(temporal);
    if (temporal.mode !== "throughout") {
      throw new ClaimQueryInputError("UNSUPPORTED_RELATION", "Interval absence requires a finite throughout query");
    }
  } catch (error) {
    if (error instanceof TemporalInputError) throw new ClaimQueryInputError(error.code, error.message);
    throw error;
  }
  const interval = { ...temporal, mode: "throughout" as const };
  const limits = limitsFor(requestedLimits);
  let work = 0;
  function charge(units = 1): void {
    work += units;
    if (work > limits.maxWorkUnits) throw new IntervalAbsenceBudgetError("Interval absence work budget exhausted");
  }
  const inputSize = measureJson({ snapshot, target, scope, temporal, limits }, (nodes, bytes) => charge(nodes + bytes));
  const active = activeAssertions(snapshot);
  const bindings = resolveBindings(target, snapshot.definitionsByDigest);
  const partitionIssues: IntervalPartitionIssueV1[] = [];
  const constancyDeclarations: IntervalConstancyDeclarationV1[] = [];
  const positions = new Set([temporal.start, temporal.endExclusive]);
  if (bindings === undefined) partitionIssues.push({ assertionId: null, reason: "unsupported-semantics" });
  const queryAxis = snapshot.definitionsByDigest[temporal.axisDefinitionDigest];
  if (queryAxis?.kind !== "axis" || queryAxis.operation !== "integer-chronon-half-open-v1" ||
    queryAxis.dependencies.length !== 0) {
    partitionIssues.push({ assertionId: null, reason: "unsupported-primitive" });
  }

  function potentiallyApplicable(assertion: AssertionRecordV1): boolean {
    if (compareScope(assertion.body.scope, scope).result === "different") return false;
    const extent = evaluateApplicability(assertion.body.applicability, { ...interval, mode: "intersects" });
    return extent.kind !== "comparable" || extent.truth !== "never";
  }
  const candidates = new Set(snapshot.descriptors.filter((descriptor) =>
    descriptor.birthTypeDefinitionDigest === bindings?.candidateTypeDefinitionDigest).map((descriptor) => descriptor.id));
  const relevantCoverage = new Set<string>();
  const rostersByDigest = new Map(snapshot.rosters.map((roster) => [roster.digest, roster.body]));
  for (const assertion of active) {
    const proposition = assertion.body.proposition;
    if (proposition.kind !== "atom" || !potentiallyApplicable(assertion)) continue;
    if (proposition.predicateDefinitionDigest === bindings?.membershipPredicateDigest &&
      proposition.value.kind === "ref" && proposition.value.id === target.population.descriptorId) {
      candidates.add(proposition.subjectId);
    }
    if (proposition.predicateDefinitionDigest === bindings?.coveragePredicateDigest &&
      proposition.subjectId === target.population.descriptorId) {
      const basis = populationCoverageBasis(proposition.value, snapshot.definitionsByDigest);
      if (basis?.populationDefinitionDigest !== target.population.definitionDigest) continue;
      relevantCoverage.add(assertion.id);
      for (const id of rostersByDigest.get(basis.rosterDigest)?.memberIds ?? []) candidates.add(id);
    }
  }
  function relevant(assertion: AssertionRecordV1): boolean {
    const proposition = assertion.body.proposition;
    if (proposition.kind === "exists") return isDeepStrictEqual(proposition, target);
    if (bindings === undefined) return false;
    if (proposition.predicateDefinitionDigest === bindings.membershipPredicateDigest) {
      return proposition.value.kind === "ref" && proposition.value.id === target.population.descriptorId;
    }
    if (proposition.predicateDefinitionDigest === bindings.coveragePredicateDigest) {
      return relevantCoverage.has(assertion.id);
    }
    return proposition.predicateDefinitionDigest === bindings.eligibilityPredicateDigest &&
      candidates.has(proposition.subjectId) && isDeepStrictEqual(proposition.value, bindings.criterionValue);
  }

  for (const assertion of active) {
    charge();
    if (!relevant(assertion)) continue;
    const scopeResult = compareScope(assertion.body.scope, scope).result;
    if (scopeResult === "different") continue;
    const extent = evaluateApplicability(assertion.body.applicability, { ...temporal, mode: "intersects" });
    if (extent.kind === "comparable" && extent.truth === "never") continue;
    if (scopeResult === "unresolved") {
      partitionIssues.push({ assertionId: assertion.id, reason: "unresolved-scope" });
      continue;
    }
    const changes = exactApplicabilityChanges(assertion.body.applicability, temporal);
    if (changes.status === "unresolved") {
      partitionIssues.push({ assertionId: assertion.id, reason: changes.reason });
      continue;
    }
    const proposition = assertion.body.proposition;
    const roots = [target.population.definitionDigest, target.criterion.definitionDigest];
    if (proposition.kind === "atom") {
      roots.push(proposition.predicateDefinitionDigest);
      if (proposition.value.kind === "literal") roots.push(proposition.value.valueDefinitionDigest);
    }
    if (assertion.body.applicability.kind !== "invariant") roots.push(assertion.body.applicability.axisDefinitionDigest);
    const definitionDigests = definitionClosure(roots, snapshot.definitionsByDigest);
    if (definitionDigests === undefined) {
      partitionIssues.push({ assertionId: assertion.id, reason: "unsupported-primitive" });
      continue;
    }
    constancyDeclarations.push({ assertionId: assertion.id, provider: "recorded-applicability-v1", definitionDigests, changePositions: changes.changePositions });
    for (const position of changes.changePositions) positions.add(position);
    if (positions.size - 1 > limits.maxCells) throw new IntervalAbsenceBudgetError("Interval absence cell budget exhausted");
  }
  const breakpoints = numericSet([...positions]);
  const cells: IntervalAbsenceCellV1[] = [];
  // Reserve conservative work before the point evaluator's candidate/coverage scans and hashing.
  const perCellWork = 4 * ((inputSize.nodes + inputSize.bytes) * (relevantCoverage.size + 1) +
    (active.length + 1) * (active.length + candidates.size + 1));
  let outputNodes = 1; // The final evaluationDigest is added after retaining the body.
  let outputBytes = 1024; // Envelope fields and digest, outside retained cell/base objects.
  function retain(value: unknown): void {
    measureJson(value, (nodes, bytes) => {
      charge(nodes + bytes);
      outputNodes += nodes;
      outputBytes += bytes;
      if (outputNodes > MAX_RECEIPT_NODES || outputBytes > MAX_RECEIPT_BYTES) {
        throw new IntervalAbsenceBudgetError("Interval absence receipt budget exhausted");
      }
    });
  }
  const base = {
    format: "wmm.interval-absence-result/1" as const,
    algorithm: "bundled-absence-throughout-v1" as const,
    worldId: snapshot.worldId, snapshotDigest: snapshot.snapshotDigest, target, scope,
    temporal: interval, limits,
    execution: "completed" as const, breakpoints, constancyDeclarations,
    partitionIssues: partitionIssues.sort((a, b) => compareText(issueKey(a), issueKey(b))),
  };
  retain(base);
  if (partitionIssues.length === 0) {
    // Bound repeated contexts, IDs, coverage inputs and hash work before materializing any cell.
    const contextSize = measureJson({ target, scope, temporal }, (nodes, bytes) => charge(nodes + bytes));
    const idSize = measureJson({
      assertionIds: active.map((assertion) => assertion.id), candidateIds: [...candidates],
    }, (nodes, bytes) => charge(nodes + bytes));
    const perCellBytes = 4096 + 4 * contextSize.bytes +
      16 * idSize.bytes + 2 * inputSize.bytes * relevantCoverage.size;
    if (outputBytes + perCellBytes * (breakpoints.length - 1) > MAX_RECEIPT_BYTES) {
      throw new IntervalAbsenceBudgetError("Interval absence receipt byte budget exhausted");
    }
    charge(perCellWork * (breakpoints.length - 1));
    for (let index = 0; index < breakpoints.length - 1; index += 1) {
      const start = breakpoints[index]!;
      const endExclusive = breakpoints[index + 1]!;
      const cell: IntervalAbsenceCellV1 = {
        start, endExclusive, representativePosition: start,
        evaluation: queryAbsence(snapshot, target, scope, {
          format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: temporal.axisDefinitionDigest, position: start,
        }),
      };
      retain(cell);
      cells.push(cell);
    }
  }
  const outcome = partitionIssues.length > 0
    ? { status: "not-established", reason: "partition-unresolved" } as const
    : cells.some((cell) => cell.evaluation.witnesses.status === "recorded")
      ? { status: "not-established", reason: "recorded-witness" } as const
      : cells.every((cell) => cell.evaluation.derivation.status === "established")
        ? { status: "established", reason: "all-cells-ineligible" } as const
        : { status: "not-established", reason: "cell-not-established" } as const;
  const body: IntervalAbsenceEvaluationBodyV1 = { ...base, ...outcome, cells };
  retain(outcome);
  return { ...body, evaluationDigest: intervalAbsenceEvaluationDigest(body) };
}

export interface IntervalAbsenceVerificationV1 {
  readonly valid: boolean;
  readonly verification: "integrity-only" | "snapshot-replay";
  readonly errors: readonly string[];
}

/** Structural and unkeyed-hash consistency is not a proof of partition completeness. */
export function verifyIntervalAbsenceReceiptIntegrity(input: unknown): IntervalAbsenceVerificationV1 {
  const invalid = (errors: readonly string[]): IntervalAbsenceVerificationV1 => ({ valid: false, verification: "integrity-only", errors });
  if (!validateSemanticContract(input).valid ||
    (input as { readonly format?: unknown }).format !== "wmm.interval-absence-result/1") {
    return invalid(["INVALID_RECEIPT_SHAPE"]);
  }
  const receipt = input as IntervalAbsenceResultV1;
  const errors: string[] = [];
  try {
    assertValidTemporalQuery(receipt.temporal);
    const points = receipt.breakpoints;
    // Bound imported partitions before sorting or visiting their change declarations.
    if (points.length > receipt.limits.maxCells + 1) return invalid(["INVALID_PARTITION"]);
    let nodes = 0;
    let bytes = 0;
    measureJson(receipt, (nodeCount, byteCount) => {
      nodes += nodeCount;
      bytes += byteCount;
      if (nodes > MAX_RECEIPT_NODES || bytes > MAX_RECEIPT_BYTES) throw new IntervalAbsenceBudgetError("Imported receipt budget exhausted");
    });
    const pointSet = new Set(points);
    if (!isDeepStrictEqual(points, numericSet(points)) || points[0] !== receipt.temporal.start ||
      points.at(-1) !== receipt.temporal.endExclusive || points.length - 1 > receipt.limits.maxCells) errors.push("INVALID_PARTITION");
    const declarations = receipt.constancyDeclarations;
    const ids = declarations.map((declaration) => declaration.assertionId);
    const issueKeys = receipt.partitionIssues.map(issueKey);
    if (!isDeepStrictEqual(ids, [...new Set(ids)].sort(compareText)) ||
      !isDeepStrictEqual(issueKeys, [...new Set(issueKeys)].sort(compareText))) errors.push("NONCANONICAL_SET");
    for (const declaration of declarations) {
      if (!isDeepStrictEqual(declaration.definitionDigests, [...new Set(declaration.definitionDigests)].sort(compareText)) ||
        !isDeepStrictEqual(declaration.changePositions, numericSet(declaration.changePositions))) errors.push("NONCANONICAL_SET");
      if (declaration.changePositions.some((position) => !pointSet.has(position))) errors.push("INVALID_PARTITION");
    }
    if (!isDeepStrictEqual(points, numericSet([
      receipt.temporal.start, receipt.temporal.endExclusive, ...declarations.flatMap((declaration) => declaration.changePositions),
    ]))) errors.push("INVALID_PARTITION");
    if (receipt.reason !== "partition-unresolved" && receipt.cells.length !== points.length - 1) errors.push("INVALID_PARTITION");
    for (const [index, cell] of receipt.cells.entries()) {
      if (cell.start !== points[index] || cell.endExclusive !== points[index + 1] || cell.representativePosition !== cell.start) errors.push("INVALID_PARTITION");
      const expectedTemporal = { format: "wmm.temporal-query/1", mode: "at", axisDefinitionDigest: receipt.temporal.axisDefinitionDigest, position: cell.start };
      const evaluation = cell.evaluation;
      const selection = evaluation.derivation.inputSelection;
      if (!isDeepStrictEqual(evaluation.target, receipt.target) || !isDeepStrictEqual(evaluation.scope, receipt.scope) ||
        !isDeepStrictEqual(evaluation.temporal, expectedTemporal) || !isDeepStrictEqual(selection.target, receipt.target) ||
        !isDeepStrictEqual(selection.scope, receipt.scope) || !isDeepStrictEqual(selection.temporal, expectedTemporal) ||
        selection.worldId !== receipt.worldId || selection.snapshotDigest !== receipt.snapshotDigest) errors.push("CELL_BINDING_MISMATCH");
      if (!verifyAbsenceReceiptIntegrity(evaluation.derivation).valid) errors.push("CELL_RECEIPT_INVALID");
    }
    if (receipt.reason !== "partition-unresolved") {
      const witness = receipt.cells.some((cell) => cell.evaluation.witnesses.status === "recorded");
      const established = !witness && receipt.cells.every((cell) => cell.evaluation.derivation.status === "established");
      if (receipt.reason !== (witness ? "recorded-witness" : established ? "all-cells-ineligible" : "cell-not-established")) errors.push("RESULT_MISMATCH");
    }
    const { evaluationDigest, ...body } = receipt;
    if (evaluationDigest !== intervalAbsenceEvaluationDigest(body)) errors.push("EVALUATION_DIGEST_MISMATCH");
  } catch {
    errors.push("INVALID_RECEIPT_SHAPE");
  }
  return { valid: errors.length === 0, verification: "integrity-only", errors: [...new Set(errors)] };
}

/** Rebuilds change declarations, partitions and every cell from adapter-verified content. */
export function verifyIntervalAbsenceReceipt(
  input: unknown, snapshot: ValidatedAbsenceQuerySnapshotV1,
): IntervalAbsenceVerificationV1 {
  const integrity = verifyIntervalAbsenceReceiptIntegrity(input);
  if (!integrity.valid) return { ...integrity, verification: "snapshot-replay" };
  const receipt = input as IntervalAbsenceResultV1;
  if (receipt.worldId !== snapshot.worldId || receipt.snapshotDigest !== snapshot.snapshotDigest) {
    return { valid: false, verification: "snapshot-replay", errors: ["SNAPSHOT_MISMATCH"] };
  }
  try {
    const expected = proveAbsenceThroughout(snapshot, receipt.target, receipt.scope, receipt.temporal, receipt.limits);
    const valid = isDeepStrictEqual(receipt, expected);
    return { valid, verification: "snapshot-replay", errors: valid ? [] : ["EVALUATION_MISMATCH"] };
  } catch (error) {
    if (!(error instanceof IntervalAbsenceBudgetError || error instanceof ClaimQueryInputError)) throw error;
    return { valid: false, verification: "snapshot-replay", errors: ["EVALUATION_MISMATCH"] };
  }
}
