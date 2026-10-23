import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import {
  assertionId, canonicalJson, canonicalJsonBytes, framedJsonDigest, semanticDefinitionDigest,
  semanticProfileDigest, sha256Hex, snapshotDigest, supportId, workspaceCandidateDigest, workspaceReviewDigest,
} from "@wmm/canonical";
import { validateWorkspaceReviewReceipt, validateWorldRecord } from "@wmm/wire-contracts";
import * as wireContracts from "@wmm/wire-contracts";
import type {
  ApplicabilityV1, AssertionRecordV1, ClaimBodyV1, JsonValue, ProposalGroupV1, ScopeV1,
  SemanticDefinitionV1, SnapshotFileEntryV1, SnapshotRecordV1, WorkspaceBaseV1, WorkspaceOperationV1,
  WorkspaceReviewV1, WorkspaceStateV1, WorldCatalogV1,
} from "@wmm/wire-contracts";

import {
  reviewWorkspace, verifyWorkspaceReviewReceipt, workspaceReviewBinding, WorkspaceReviewBudgetError,
} from "../src/workspace-review.js";
import * as worldValidation from "../src/world-validation.js";

const root = new URL("../../../fixtures/v3/succession-world/", import.meta.url);
function parse<T>(path: string): T { return JSON.parse(readFileSync(new URL(path, root), "utf8")) as T; }
const snapshot = parse<SnapshotRecordV1>("snapshot.json");
const catalog = parse<WorldCatalogV1>("payload/world.json");
const json = (value: unknown): string => canonicalJson(value as JsonValue);
const byPath = (a: { path: string }, b: { path: string }): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const record = (body: ClaimBodyV1): AssertionRecordV1 => ({ format: "wmm.assertion-record/1", id: assertionId(body), body });
const bytes = (base: WorkspaceBaseV1, path: string): Buffer => Buffer.from(base.documents.find((d) => d.path === path)!.base64, "base64");
const definitions = snapshot.manifest.files.filter((entry) => entry.path.startsWith("types/") && !entry.path.includes(catalog.semanticProfileDigest))
  .map((entry) => ({ digest: entry.path.slice(6, -5), body: parse<SemanticDefinitionV1>(`payload/${entry.path}`) }));
const documents = snapshot.manifest.files.filter((entry) => entry.path.startsWith("prose/")).map((entry) => ({
  path: entry.path, mediaType: entry.mediaType, sha256: entry.sha256,
  base64: readFileSync(new URL(`payload/${entry.path}`, root)).toString("base64"),
}));
const original: WorkspaceBaseV1 = {
  snapshot, documents,
  world: {
    format: "wmm.world-export/1", snapshotDigest: snapshot.snapshotDigest, world: catalog,
    semanticProfile: parse(`payload/types/${catalog.semanticProfileDigest}.json`), definitions,
    rosters: snapshot.manifest.files.filter((entry) => entry.path.startsWith("rosters/")).map((entry) => ({ digest: entry.path.slice(8, -5), body: parse(`payload/${entry.path}`) })),
    descriptors: catalog.descriptorIds.map((id) => parse(`payload/records/descriptors/${id.replace(":", "/")}.json`)),
    sources: catalog.sourceIds.map((id) => parse(`payload/records/sources/${id.slice(7)}.json`)),
    assertions: catalog.assertionIds.map((id) => parse(`payload/records/assertions/${id.slice(5)}.json`)),
    supports: catalog.supportIds.map((id) => parse(`payload/records/supports/${id.slice(4)}.json`)),
    documents: snapshot.manifest.files.filter((entry) => entry.path.startsWith("prose/")),
  },
};

/** Rebind fixture changes to actual payload bytes, never forge a stale wrapper. */
function rebuild(input: WorkspaceBaseV1): WorkspaceBaseV1 {
  const base = structuredClone(input);
  const files: SnapshotFileEntryV1[] = [];
  const setJson = (path: string, value: unknown): void => {
    const payload = canonicalJsonBytes(value as JsonValue);
    files.push({ path, mediaType: "application/json", byteLength: String(payload.length), sha256: sha256Hex(payload) });
  };
  setJson("world.json", base.world.world);
  setJson(`types/${base.world.world.semanticProfileDigest}.json`, base.world.semanticProfile);
  for (const { digest, body } of base.world.definitions) setJson(`types/${digest}.json`, body);
  for (const { digest, body } of base.world.rosters) setJson(`rosters/${digest}.json`, body);
  for (const d of base.world.descriptors) setJson(`records/descriptors/${d.id.replace(":", "/")}.json`, d);
  for (const s of base.world.sources) setJson(`records/sources/${s.id.slice(7)}.json`, s);
  for (const a of base.world.assertions) setJson(`records/assertions/${a.id.slice(5)}.json`, a);
  for (const s of base.world.supports) setJson(`records/supports/${s.id.slice(4)}.json`, s);
  const metadata = base.documents.map((document) => {
    const payload = Buffer.from(document.base64, "base64");
    return { path: document.path, mediaType: document.mediaType as "text/markdown", sha256: sha256Hex(payload), byteLength: String(payload.length) };
  });
  files.push(...metadata);
  const manifest = { ...base.snapshot.manifest, files: files.sort(byPath) };
  const digest = snapshotDigest(manifest);
  return {
    snapshot: { ...base.snapshot, manifest, snapshotDigest: digest },
    documents: base.documents.map((document) => ({ ...document, sha256: metadata.find((d) => d.path === document.path)!.sha256 })),
    world: { ...base.world, snapshotDigest: digest, documents: metadata.sort(byPath) },
  };
}
function withClaims(claims: readonly AssertionRecordV1[], base = original): WorkspaceBaseV1 {
  const ids = claims.map((claim) => claim.id).sort();
  return rebuild({ ...base, world: {
    ...base.world, assertions: [...claims].sort((a, b) => a.id.localeCompare(b.id)), supports: [],
    world: { ...base.world.world, assertionIds: ids, activeAssertionIds: ids, supportIds: [], activeSupportIds: [] },
  } });
}
const empty = withClaims([]);
const axis = definitions.find(({ body }) => body.key === "days")!.digest;
const predicate = definitions.find(({ body }) => body.key === "allied_with")!.digest;
const scope: ScopeV1 = {
  account: { kind: "ref", id: "account:canonical" }, jurisdiction: { kind: "ref", id: "polity:valen" },
  recognitionFrame: { kind: "ref", id: "frame:royal-court" },
};
const point = (position: string): ApplicabilityV1 => ({ kind: "point", axisDefinitionDigest: axis, position: { kind: "exact", position } });
const interval = (start: string, end: string): ApplicabilityV1 => ({ kind: "interval", axisDefinitionDigest: axis, start: { kind: "exact", position: start }, endExclusive: { kind: "exact", position: end } });
const boundedPoint = (lower: string, upper: string): ApplicabilityV1 => ({ kind: "point", axisDefinitionDigest: axis, position: { kind: "boundedUnknown", lowerInclusive: lower, upperExclusive: upper } });
const boundedStart = (lower: string, upper: string, end: string): ApplicabilityV1 => ({ kind: "interval", axisDefinitionDigest: axis, start: { kind: "boundedUnknown", lowerInclusive: lower, upperExclusive: upper }, endExclusive: { kind: "exact", position: end } });
function claim(changes: Partial<ClaimBodyV1> = {}): AssertionRecordV1 {
  return record({
    format: "wmm.claim/1", worldId: catalog.worldId, semanticProfileDigest: catalog.semanticProfileDigest,
    proposition: { kind: "atom", subjectId: "person:alys", predicateDefinitionDigest: predicate, value: { kind: "ref", id: "person:bran" } },
    polarity: "positive", scope, applicability: point("1"), ...changes,
  });
}
function group(id: string, operations: readonly WorkspaceOperationV1[] = [write(`prose/developments/${id}.md`, `# ${id}\n`)], changes: Partial<ProposalGroupV1> = {}): ProposalGroupV1 {
  return { id, version: 1, title: id, author: "author", rationale: "Explicit authored proposal.", dependencies: [], exclusions: [], operations, decision: "selected", rejectionReason: null, ...changes };
}
function write(path: string, text = "Authored text\n", beforeSha256: string | null = null): WorkspaceOperationV1 {
  return { kind: "write-prose", path, text, beforeSha256 };
}
function activate(assertion: AssertionRecordV1): WorkspaceOperationV1 { return { kind: "activate-assertion", assertion }; }
function deactivate(assertionId: string): WorkspaceOperationV1 { return { kind: "deactivate-assertion", assertionId }; }
function state(proposals: readonly ProposalGroupV1[] = [group("draft")], base = original, changes: Partial<WorkspaceStateV1> = {}): WorkspaceStateV1 {
  return {
    format: "wmm.workspace/1", id: "succession", version: 3, title: "Succession", worldTitle: "Valen",
    goal: "Write an explicit alternative.", mode: "succession-demo", base: { worldId: base.world.world.worldId, snapshotDigest: base.snapshot.snapshotDigest },
    proposals, pins: [], direction: "Do not infer eligible heirs.", history: [], ...changes,
  };
}
function status(review: WorkspaceReviewV1, id: string): string { return review.checks.find((check) => check.id === id)!.status; }
function codes(review: WorkspaceReviewV1): string[] { return review.diagnostics.map((item) => item.code); }
function expectBlocked(result: ReturnType<typeof reviewWorkspace>, failed: "selection" | "operations"): void {
  expect(result.candidate).toBeNull();
  expect(result.review.candidateSnapshotDigest).toBeNull();
  expect(result.review.execution).toBe("completed");
  expect(result.review.validity).toBe("invalid");
  expect(result.review.diff).toEqual({ documents: [], assertions: [] });
  expect(status(result.review, failed)).toBe("failed");
  for (const id of ["references", "pins", "explicit-opposition"]) expect(status(result.review, id)).toBe("blocked");
  expect(validateWorkspaceReviewReceipt(result.review).valid).toBe(true);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

describe("bounded pure workspace review compilation", () => {
  it("compiles exactly three selected demo documents, retains the original base and recomputes all metadata", () => {
    const groups = [group("death"), group("council", undefined, { dependencies: ["death"] }), group("regency", undefined, { dependencies: ["death", "council"] }), group("coup", undefined, { decision: "rejected" })];
    const draft = freeze(state(groups));
    const base = freeze(structuredClone(original));
    const before = json({ base, draft });
    const first = reviewWorkspace(draft, base);
    expect(first.review.validity).toBe("valid");
    expect(first.review.checks.map(({ status }) => status)).toEqual(Array(5).fill("passed"));
    expect(first.review.diff.documents.map(({ path }) => path)).toEqual(["prose/developments/council.md", "prose/developments/death.md", "prose/developments/regency.md"]);
    expect(first.review.diff.assertions).toEqual([]);
    expect(first.candidate!.world.assertions).toEqual(base.world.assertions);
    expect(first.candidate!.world.supports).toEqual(base.world.supports);
    expect(first.candidate!.snapshot.snapshotDigest).toBe(snapshotDigest(first.candidate!.snapshot.manifest));
    expect(first.candidate!.world.snapshotDigest).toBe(first.candidate!.snapshot.snapshotDigest);
    expect(validateWorldRecord(first.candidate!.snapshot).valid).toBe(true);
    for (const document of first.candidate!.documents) {
      const payload = Buffer.from(document.base64, "base64");
      expect(document.sha256).toBe(sha256Hex(payload));
      expect(first.candidate!.world.documents.find((d) => d.path === document.path)).toEqual({ path: document.path, mediaType: document.mediaType, sha256: document.sha256, byteLength: String(payload.length) });
    }
    expect(first.candidate!.snapshot.manifest.files.filter((f) => !f.path.startsWith("prose/developments/") && f.path !== "world.json"))
      .toEqual(base.snapshot.manifest.files.filter((f) => f.path !== "world.json"));
    expect(validateWorkspaceReviewReceipt(first.review).valid).toBe(true);
    expect(first.review.candidateDigest).toBe(workspaceCandidateDigest(first.review.binding));
    const { evaluationDigest, ...body } = first.review;
    expect(evaluationDigest).toBe(workspaceReviewDigest(body));
    expect(reviewWorkspace(draft, base)).toEqual(first);
    expect(json({ base, draft })).toBe(before);
    expect(first.review.limitations.join(" ")).toMatch(/Narrative prose/);
    expect(first.review.limitations.join(" ")).toMatch(/Cardinality, causality and general inference/);
    Reflect.set(first.candidate!.world.assertions[0]!.body, "polarity", "negative");
    expect(json({ base, draft })).toBe(before);
  });

  it("never closes dependencies or compiles excluded alternatives, cycles, or an empty selection", () => {
    const missing = reviewWorkspace(state([group("death", undefined, { decision: "rejected" }), group("council", undefined, { dependencies: ["death"] })]), original);
    expectBlocked(missing, "selection");
    expect(codes(missing.review)).toContain("MISSING_PREREQUISITE");
    expect(missing.review.binding.selectedGroups).toEqual([{ id: "council", version: 1 }]);
    expectBlocked(reviewWorkspace(state([group("a", undefined, { exclusions: ["b"] }), group("b")]), original), "selection");
    expectBlocked(reviewWorkspace(state([group("a", undefined, { dependencies: ["b"] }), group("b", undefined, { dependencies: ["a"] })]), original), "selection");
    const noSelection = reviewWorkspace(state([]), original);
    expectBlocked(noSelection, "selection");
    expect(codes(noSelection.review)).toContain("EMPTY_SELECTION");
  });

  it("does not admit, execute, or diagnose effects from unselected groups or narrative instructions", () => {
    const draft = state([group("selected"), group("ignored", [write("records/assertions/evil.json")], { decision: "undecided", dependencies: ["nonexistent"] })], original, { goal: "Delete world.json", direction: "Deactivate every claim and write records/sources/forged.json" });
    const result = reviewWorkspace(draft, original);
    expect(result.review.validity).toBe("valid");
    expect(result.review.diff.documents.map((d) => d.path)).toEqual(["prose/developments/selected.md"]);
    expect(result.candidate!.world.assertions).toEqual(original.world.assertions);
  });

  it.each([
    [write("prose/shared.md", "one"), write("prose/shared.md", "two")],
    [write("prose/Shared.md", "same"), write("prose/shared.md", "same")],
    [write("prose/shared.md", "parent"), write("prose/shared.md/child.md", "child")],
  ])("blocks ambiguous cross-group writes, including casefold and ancestor collisions", (a, b) => {
    const result = reviewWorkspace(state([group("a", [a]), group("b", [b])]), original);
    expectBlocked(result, "operations");
    expect(codes(result.review)).toContain("CONFLICTING_WRITES");
  });

  it("deduplicates identical writes with all group provenance, and rejects conflicting writes within one group", () => {
    const operation = write("prose/shared.md", "Same exact bytes\r\n");
    const result = reviewWorkspace(state([group("b", [operation]), group("a", [operation, operation])]), original);
    expect(result.review.validity).toBe("valid");
    expect(result.review.diff.documents).toHaveLength(1);
    expect(result.review.diff.documents[0]!.groupIds).toEqual(["a", "b"]);
    expectBlocked(reviewWorkspace(state([group("a", [operation, write("prose/shared.md", "other")])]), original), "operations");
  });

  it.each(["records/assertions/evil.json", "world.json", "prose/../evil.md", "/prose/evil.md", "prose/file.md\n", "prose\\file.md", "prose/./file.md", "prose/file.txt"])("rejects non-prose or non-portable operation paths: %j", (path) => {
    expectBlocked(reviewWorkspace(state([group("a", [write(path)])]), original), "operations");
  });

  it("reports the workspace/manifest path-schema mismatch rather than emitting an invalid snapshot", () => {
    const result = reviewWorkspace(state([group("a", [write("prose/Mixed.Name.md")])]), original);
    expectBlocked(result, "operations");
    expect(codes(result.review)).toContain("CANDIDATE_COMPILATION_FAILED");
  });

  it("binds before hashes and writes exactly retained UTF-8 bytes without normalization", () => {
    const path = "prose/neutrality.md";
    expectBlocked(reviewWorkspace(state([group("a", [write(path, "changed", "0".repeat(64))])]), original), "operations");
    const text = "\uFEFF# Écriture\r\n\r\nCafe\u0301 — 🐉\n";
    const operation = write(path, text, original.documents.find((d) => d.path === path)!.sha256);
    const result = reviewWorkspace(state([group("a", [operation])]), original);
    expect(result.review.validity).toBe("valid");
    expect(bytes(result.candidate!, path)).toEqual(Buffer.from(text, "utf8"));
    expect(result.review.diff.documents[0]!.after).toBe(text);
  });

  it("blocks activation/deactivation conflicts even in the same group or in reversed sequence", () => {
    const old = original.world.assertions[0]!;
    for (const operations of [[activate(old), deactivate(old.id)], [deactivate(old.id), activate(old)]]) {
      const same = reviewWorkspace(state([group("a", operations)]), original);
      expectBlocked(same, "operations");
      expect(codes(same.review)).toContain("CONFLICTING_ASSERTION_EFFECTS");
    }
    expectBlocked(reviewWorkspace(state([group("a", [activate(old)]), group("b", [deactivate(old.id)])]), original), "operations");
  });

  it("deduplicates identical activations with complete provenance", () => {
    const assertion = claim();
    const result = reviewWorkspace(state([group("b", [activate(assertion)]), group("a", [activate(assertion), activate(assertion)])], empty), empty);
    expect(result.review.validity).toBe("valid");
    expect(result.review.diff.assertions).toEqual([{ id: assertion.id, kind: "activated", body: assertion.body, groupIds: ["a", "b"] }]);
    expect(result.candidate!.world.assertions).toEqual([assertion]);
    expect(result.candidate!.world.world.activeAssertionIds).toEqual([assertion.id]);
  });

  it("retcons active status without deleting old immutable claim bodies, supports, or proof payload entries", () => {
    const old = original.world.assertions.find((a) => a.body.proposition.kind === "exists")!;
    const replacement = record({ ...old.body, polarity: old.body.polarity === "positive" ? "negative" : "positive", applicability: point("2000") });
    const result = reviewWorkspace(state([group("retcon", [deactivate(old.id), activate(replacement)])]), original);
    expect(result.review.validity).toBe("valid");
    expect(result.candidate!.world.world.activeAssertionIds).not.toContain(old.id);
    expect(result.candidate!.world.world.assertionIds).toContain(old.id);
    expect(result.candidate!.world.assertions.find((a) => a.id === old.id)).toEqual(old);
    expect(result.candidate!.world.supports).toEqual(original.world.supports);
    for (const entry of original.snapshot.manifest.files.filter((f) => f.path.startsWith("records/") || f.path.startsWith("rosters/"))) {
      expect(result.candidate!.snapshot.manifest.files.find((f) => f.path === entry.path)).toEqual(entry);
    }
    const replacementEntry = result.candidate!.snapshot.manifest.files.find((f) => f.path === `records/assertions/${replacement.id.slice(5)}.json`)!;
    expect(replacementEntry.sha256).toBe(sha256Hex(canonicalJsonBytes(replacement as unknown as JsonValue)));
    expect(result.review.diff.assertions.map((d) => d.kind).sort()).toEqual(["activated", "deactivated"]);
  });

  it("rejects forged identities and foreign-world/profile bodies at admission", () => {
    const valid = claim();
    for (const assertion of [
      { ...valid, id: `asrt:${"0".repeat(64)}` },
      record({ ...valid.body, worldId: "world:other" }),
      record({ ...valid.body, semanticProfileDigest: "0".repeat(64) }),
      { ...valid, body: { ...valid.body, scope: {} } } as AssertionRecordV1,
    ]) expectBlocked(reviewWorkspace(state([group("a", [activate(assertion)])], empty), empty), "operations");
  });

  it("uses the existing validator on the combined candidate, retaining unresolved reference failures as invalid reviews", () => {
    const invalid = claim({ proposition: { kind: "atom", subjectId: "person:missing", predicateDefinitionDigest: predicate, value: { kind: "ref", id: "person:bran" } } });
    const spy = vi.spyOn(worldValidation, "validateWorldSemantics");
    const result = reviewWorkspace(state([group("a", [activate(invalid)])], empty), empty);
    expect(result.candidate).not.toBeNull();
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "references")).toBe("failed");
    expect(status(result.review, "explicit-opposition")).toBe("blocked");
    expect(result.review.diagnostics.find((d) => d.code === "INVALID_REFERENCES")!.message).toContain("Descriptor is unavailable");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0].assertions).toContainEqual(invalid);
    spy.mockRestore();
  });

  it.each([
    claim({ scope: { ...scope, account: { kind: "ref", id: "account:missing" } } }),
    claim({ applicability: { kind: "point", axisDefinitionDigest: "0".repeat(64), position: { kind: "exact", position: "1" } } }),
    claim({ proposition: { kind: "atom", subjectId: "person:alys", predicateDefinitionDigest: "0".repeat(64), value: { kind: "ref", id: "person:bran" } } }),
    claim({ proposition: { kind: "atom", subjectId: "person:alys", predicateDefinitionDigest: predicate, value: { kind: "ref", id: "person:missing" } } }),
  ])("rejects missing scope, axis, predicate and value references in the combined candidate", (assertion) => {
    const result = reviewWorkspace(state([group("a", [activate(assertion)])], empty), empty);
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "references")).toBe("failed");
    expect(codes(result.review)).toContain("INVALID_REFERENCES");
    expect(validateWorkspaceReviewReceipt(result.review).valid).toBe(true);
  });

  it("checks bundled source bytes separately, even when the immutable support/source digests still agree", () => {
    const document = original.documents.find((d) => d.path === "prose/neutrality.md")!;
    const source = { ...original.world.sources[0]!, content: { availability: "bundled" as const, path: document.path, sha256: document.sha256 } };
    const supports = original.world.supports.map((old) => { const body = { ...old.body, sourceContentDigest: document.sha256 }; return { ...old, body, id: supportId(body) }; });
    const ids = supports.map((s) => s.id).sort();
    const base = rebuild({ ...original, world: { ...original.world, sources: [source], supports, world: { ...catalog, supportIds: ids, activeSupportIds: ids } } });
    const result = reviewWorkspace(state([group("a", [write(document.path, "Changed source bytes\n", document.sha256)])], base), base);
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "references")).toBe("failed");
    expect(codes(result.review)).toContain("SOURCE_DIGEST_MISMATCH");
    expect(result.candidate!.world.supports).toEqual(supports);
    expect(result.candidate!.world.sources).toEqual([source]);
  });

  it("rejects tampered base bytes, catalog bodies, manifest hashes and binding metadata", () => {
    const variants = [
      { ...original, documents: original.documents.map((d, i) => i === 0 ? { ...d, base64: Buffer.from("tampered").toString("base64") } : d) },
      { ...original, world: { ...original.world, assertions: original.world.assertions.slice(1) } },
      { ...original, snapshot: { ...original.snapshot, snapshotDigest: "0".repeat(64) } },
      { ...original, world: { ...original.world, documents: [] } },
    ];
    for (const base of variants) expectBlocked(reviewWorkspace(state(), base), "operations");
  });
});

describe("base-bound protections and bounded explicit opposition", () => {
  it("detects the pin-breaking intervention and allows exact no-op document writes", () => {
    const doc = original.documents.find((d) => d.path === "prose/neutrality.md")!;
    const pins: WorkspaceStateV1["pins"] = [{ id: "neutral", kind: "document", path: doc.path, sha256: doc.sha256, active: true }];
    const draft = state([group("intervention", [write(doc.path, "Foreign military intervention\n", doc.sha256)])], original, { pins });
    const result = reviewWorkspace(draft, original);
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "pins")).toBe("failed");
    expect(codes(result.review)).toContain("PIN_CHANGED");
    const noop = reviewWorkspace(state([group("a", [write(doc.path, bytes(original, doc.path).toString("utf8"), doc.sha256)])], original, { pins }), original);
    expect(noop.review.validity).toBe("valid");
    expect(noop.review.diff.documents).toEqual([]);
  });

  it("protects exact active assertion bodies, and only considers contrary additions at intersecting scope/time", () => {
    const old = claim();
    const base = withClaims([old]);
    const pins: WorkspaceStateV1["pins"] = [{ id: "claim", kind: "assertion", assertionId: old.id, active: true }];
    const deactivated = reviewWorkspace(state([group("a", [deactivate(old.id)])], base, { pins }), base);
    expect(status(deactivated.review, "pins")).toBe("failed");
    const opposite = claim({ polarity: "negative" });
    const opposed = reviewWorkspace(state([group("a", [activate(opposite)])], base, { pins }), base);
    expect(codes(opposed.review)).toContain("PIN_OPPOSITION");
    expect(status(opposed.review, "explicit-opposition")).toBe("failed");
    const later = claim({ polarity: "negative", applicability: point("2") });
    expect(reviewWorkspace(state([group("a", [activate(later)])], base, { pins }), base).review.validity).toBe("valid");
    const uncertain = claim({ polarity: "negative", applicability: { kind: "point", axisDefinitionDigest: axis, position: { kind: "unknown" } } });
    const result = reviewWorkspace(state([group("a", [activate(uncertain)])], base, { pins }), base);
    expect(result.review.validity).toBe("undetermined");
    expect(status(result.review, "pins")).toBe("unresolved");
    expect(codes(result.review)).toContain("PIN_OPPOSITION_UNRESOLVED");
  });

  it.each([
    [point("1"), point("1"), "invalid"],
    [point("1"), point("2"), "valid"],
    [point("2"), interval("1", "2"), "valid"],
    [point("1"), interval("1", "2"), "invalid"],
    [interval("-10", "0"), interval("0", "10"), "valid"],
    [interval("-10", "1"), interval("0", "10"), "invalid"],
    [{ kind: "invariant" }, point("1000000000000000000000000000000"), "invalid"],
    [{ kind: "interval", axisDefinitionDigest: axis, start: { kind: "unboundedPast" }, endExclusive: { kind: "exact", position: "0" } }, point("0"), "valid"],
    [{ kind: "interval", axisDefinitionDigest: axis, start: { kind: "exact", position: "0" }, endExclusive: { kind: "unboundedFuture" } }, point("0"), "invalid"],
    [{ kind: "point", axisDefinitionDigest: axis, position: { kind: "boundedUnknown", lowerInclusive: "0", upperExclusive: "3" } }, point("1"), "undetermined"],
    [{ kind: "point", axisDefinitionDigest: axis, position: { kind: "unknown" } }, point("1"), "undetermined"],
    [{ kind: "interval", axisDefinitionDigest: axis, start: { kind: "unknown" }, endExclusive: { kind: "unboundedFuture" } }, point("1"), "undetermined"],
    [{ kind: "point", axisDefinitionDigest: axis, position: { kind: "boundedUnknown", lowerInclusive: "3", upperExclusive: "5" } }, point("1"), "valid"],
    [boundedPoint("5", "6"), point("5"), "invalid"],
    [point("5"), boundedPoint("5", "6"), "invalid"],
    [boundedPoint("5", "6"), point("6"), "valid"],
    [boundedStart("0", "3", "10"), point("5"), "invalid"],
    [point("5"), boundedStart("0", "3", "10"), "invalid"],
    [boundedStart("0", "3", "10"), point("1"), "undetermined"],
    [boundedPoint("2", "8"), interval("0", "10"), "invalid"],
    [interval("0", "10"), boundedPoint("2", "8"), "invalid"],
    [boundedStart("0", "3", "10"), interval("3", "5"), "invalid"],
    [interval("3", "5"), boundedStart("0", "3", "10"), "invalid"],
    [boundedStart("0", "3", "10"), interval("-3", "-1"), "valid"],
    [boundedPoint("-1", "1"), interval("0", "2"), "undetermined"],
    [interval("0", "2"), boundedPoint("-1", "1"), "undetermined"],
    [{ kind: "invariant" }, { kind: "point", axisDefinitionDigest: axis, position: { kind: "unknown" } }, "invalid"],
    [{ kind: "point", axisDefinitionDigest: axis, position: { kind: "unknown" } }, { kind: "invariant" }, "invalid"],
    [{ kind: "invariant" }, { kind: "interval", axisDefinitionDigest: axis, start: { kind: "unknown" }, endExclusive: { kind: "unknown" } }, "invalid"],
  ] as const)("uses discrete half-open chronons for %j against %j", (left, right, validity) => {
    const a = claim({ applicability: left });
    const b = claim({ polarity: "negative", applicability: right });
    const result = reviewWorkspace(state([group("a", [activate(a), activate(b)])], empty), empty);
    expect(result.review.validity).toBe(validity);
    expect(status(result.review, "explicit-opposition")).toBe(validity === "invalid" ? "failed" : validity === "undetermined" ? "unresolved" : "passed");
    expect(validateWorkspaceReviewReceipt(result.review).valid).toBe(true);
    if (validity === "invalid") {
      expect(codes(result.review)).toContain("EXPLICIT_OPPOSITION");
      expect(codes(result.review)).not.toContain("OPPOSITION_UNRESOLVED");
    }
    if (validity === "undetermined") {
      expect(result.review.diagnostics.every((d) => d.severity === "warning")).toBe(true);
      expect(result.review.diagnostics[0]!.message).toContain("uncertain-applicability");
    }
  });

  it("protects pins against guaranteed overlap even when either side is syntactically uncertain", () => {
    const pairs: readonly (readonly [ApplicabilityV1, ApplicabilityV1])[] = [
      [boundedPoint("5", "6"), point("5")],
      [boundedStart("0", "3", "10"), point("5")],
      [boundedPoint("2", "8"), interval("0", "10")],
      [{ kind: "point", axisDefinitionDigest: axis, position: { kind: "unknown" } }, { kind: "invariant" }],
    ];
    for (const [left, right] of pairs) for (const [pinned, added] of [[left, right], [right, left]]) {
      const old = claim({ applicability: pinned! });
      const addition = claim({ polarity: "negative", applicability: added! });
      const base = withClaims([old]);
      const pins: WorkspaceStateV1["pins"] = [{ id: "protected", kind: "assertion", assertionId: old.id, active: true }];
      const result = reviewWorkspace(state([group("a", [activate(addition)])], base, { pins }), base);
      expect(result.review.validity).toBe("invalid");
      expect(status(result.review, "pins")).toBe("failed");
      expect(status(result.review, "explicit-opposition")).toBe("failed");
      expect(codes(result.review)).toEqual(expect.arrayContaining(["PIN_OPPOSITION", "EXPLICIT_OPPOSITION"]));
      expect(codes(result.review)).not.toContain("PIN_OPPOSITION_UNRESOLVED");
    }
  });

  it("labels unsupported two-uncertain comparisons without claiming that overlap itself is uncertain", () => {
    const a = claim({ applicability: boundedPoint("0", "3") });
    const b = claim({ polarity: "negative", applicability: boundedPoint("1", "4") });
    const result = reviewWorkspace(state([group("a", [activate(a), activate(b)])], empty), empty);
    expect(result.review.validity).toBe("undetermined");
    expect(status(result.review, "explicit-opposition")).toBe("unresolved");
    expect(result.review.diagnostics).toHaveLength(1);
    expect(result.review.diagnostics[0]!.severity).toBe("warning");
    expect(result.review.diagnostics[0]!.message).toContain("unsupported-applicability-comparison");
    expect(result.review.diagnostics[0]!.message).not.toContain("uncertain-applicability");
    expect(validateWorkspaceReviewReceipt(result.review).valid).toBe(true);
  });

  it("also checks exact explicit existential propositions without deriving any new existence claims", () => {
    const proposition = original.world.assertions.find((a) => a.body.proposition.kind === "exists")!.body.proposition;
    const positive = claim({ proposition });
    const negative = claim({ proposition, polarity: "negative" });
    const result = reviewWorkspace(state([group("a", [activate(positive), activate(negative)])], empty), empty);
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "explicit-opposition")).toBe("failed");
    expect(result.candidate!.world.assertions).toHaveLength(2);
  });

  it("detects existing contradictory records, without considering different object values opposed", () => {
    const a = claim();
    const b = claim({ polarity: "negative" });
    const base = withClaims([a, b]);
    const result = reviewWorkspace(state([group("prose")], base), base);
    expect(result.review.validity).toBe("invalid");
    expect(result.review.diagnostics.find((d) => d.code === "EXPLICIT_OPPOSITION")!.groupIds).toEqual([]);
    const c = claim({ polarity: "negative", proposition: { ...a.body.proposition as Extract<ClaimBodyV1["proposition"], { kind: "atom" }>, value: { kind: "ref", id: "person:alys" } } });
    expect(reviewWorkspace(state([group("a", [activate(a), activate(c)])], empty), empty).review.validity).toBe("valid");
  });

  it("keeps invalidity when a definite opposition coexists with unresolved comparisons", () => {
    const positive = claim();
    const negative = claim({ polarity: "negative" });
    const uncertain = claim({ polarity: "negative", scope: { ...scope, recognitionFrame: { kind: "unresolved" } } });
    const result = reviewWorkspace(state([group("a", [activate(positive), activate(negative), activate(uncertain)])], empty), empty);
    expect(result.review.validity).toBe("invalid");
    expect(status(result.review, "explicit-opposition")).toBe("failed");
    expect(codes(result.review)).toEqual(expect.arrayContaining(["EXPLICIT_OPPOSITION", "OPPOSITION_UNRESOLVED"]));
    expect(validateWorkspaceReviewReceipt(result.review).valid).toBe(true);
  });

  it("skips different accounts, and never converts unresolved scope into validity by omission", () => {
    const a = claim();
    const different = claim({ polarity: "negative", scope: { ...scope, account: { kind: "notApplicable" } } });
    expect(reviewWorkspace(state([group("a", [activate(a), activate(different)])], empty), empty).review.validity).toBe("valid");
    const unknown = claim({ polarity: "negative", scope: { ...scope, jurisdiction: { kind: "unresolved" } } });
    const result = reviewWorkspace(state([group("a", [activate(a), activate(unknown)])], empty), empty);
    expect(result.review.validity).toBe("undetermined");
    expect(result.review.diagnostics[0]!.message).toContain("unresolved-scope");
  });

  it("reports unmapped axes instead of comparing their numeric coordinates", () => {
    const otherAxis: SemanticDefinitionV1 = { format: "wmm.semantic-definition/1", key: "other_days", kind: "axis", operation: "integer-chronon-half-open-v1", version: "1", dependencies: [] };
    const otherDigest = semanticDefinitionDigest(otherAxis);
    const semanticProfile = { ...empty.world.semanticProfile, definitions: [...empty.world.semanticProfile.definitions, otherDigest].sort() };
    const profileDigest = semanticProfileDigest(semanticProfile);
    const base = rebuild({ ...empty, world: { ...empty.world, semanticProfile, definitions: [...empty.world.definitions, { digest: otherDigest, body: otherAxis }], world: { ...empty.world.world, semanticProfileDigest: profileDigest } } });
    const a = claim({ semanticProfileDigest: profileDigest });
    const b = claim({ polarity: "negative", semanticProfileDigest: profileDigest, applicability: { kind: "point", axisDefinitionDigest: otherDigest, position: { kind: "exact", position: "1" } } });
    const result = reviewWorkspace(state([group("a", [activate(a), activate(b)])], base), base);
    expect(result.review.validity).toBe("undetermined");
    expect(result.review.diagnostics[0]!.message).toContain("unmapped-axis");
  });
});

describe("binding freshness, receipt replay and budgets", () => {
  it("sorts groups and pins in bindings but retains operation sequence and binds versions and steering", () => {
    const operations = [write("prose/a.md", "A"), write("prose/b.md", "B")];
    const pins: WorkspaceStateV1["pins"] = original.documents.slice(0, 2).map((d, i) => ({ id: `pin-${i}`, kind: "document", path: d.path, sha256: d.sha256, active: true }));
    const draft = state([group("z", operations), group("a")], original, { pins });
    const binding = workspaceReviewBinding(draft, original);
    expect(binding).toEqual(reviewWorkspace(draft, original).review.binding);
    expect(binding.selectedGroups.map((g) => g.id)).toEqual(["a", "z"]);
    expect(binding.operationsDigest).toBe(framedJsonDigest("wmm.workspace-operations/v1", [{ groupId: "a", operations: draft.proposals[1]!.operations }, { groupId: "z", operations }] as unknown as JsonValue));
    expect(binding.steeringDigest).toBe(framedJsonDigest("wmm.workspace-steering/v1", { goal: draft.goal, direction: draft.direction, pins } as unknown as JsonValue));
    expect(workspaceReviewBinding({ ...draft, proposals: [...draft.proposals].reverse(), pins: [...pins].reverse() }, original)).toEqual(binding);
    expect(workspaceReviewBinding({ ...draft, proposals: [group("z", [...operations].reverse()), draft.proposals[1]!] }, original).operationsDigest).not.toBe(binding.operationsDigest);
    for (const changed of [{ ...draft, version: draft.version + 1 }, { ...draft, direction: "Different guidance" }, { ...draft, goal: "Different goal" }, { ...draft, pins: pins.map((p) => ({ ...p, active: false })) }, { ...draft, proposals: draft.proposals.map((p) => ({ ...p, version: 2 })) }]) {
      expect(workspaceCandidateDigest(workspaceReviewBinding(changed, original))).not.toBe(workspaceCandidateDigest(binding));
    }
  });

  it("binds a valid custom-budget review without copying large retained data, history or unselected prose", () => {
    const retained = Buffer.from("x".repeat(1_000_000));
    const base = rebuild({ ...original, documents: [...original.documents, {
      path: "prose/retained.md", mediaType: "text/markdown", sha256: sha256Hex(retained), base64: retained.toString("base64"),
    }] });
    const rationale = "x".repeat(16000);
    const unselected = Array.from({ length: 16 }, (_, i) => group(`ignored-${i}`, [write(`prose/ignored-${i}.md`, "x".repeat(65536))], { decision: "undecided", rationale }));
    const history: WorkspaceStateV1["history"] = Array.from({ length: 128 }, (_, i) => ({
      version: i + 2, action: { kind: "set-direction", text: rationale },
    }));
    const draft = state([group("selected"), ...unselected], base, { version: 129, history });
    expect(() => reviewWorkspace(draft, base)).toThrow(WorkspaceReviewBudgetError);
    const receipt = reviewWorkspace(draft, base, { maxWorkUnits: 50_000_000 }).review;
    expect(receipt.validity).toBe("valid");
    expect(workspaceReviewBinding(draft, base)).toEqual(receipt.binding);
    expect(workspaceReviewBinding({ ...draft, history: [], proposals: [draft.proposals[0]!] }, base)).toEqual(receipt.binding);
  });

  it("can bind larger selected operation data admitted under custom review limits", () => {
    const operations = Array.from({ length: 10 }, (_, i) => write(`prose/large-${i}.md`, "x".repeat(65536)));
    const draft = state([group("selected", operations)]);
    const receipt = reviewWorkspace(draft, original, { maxWorkUnits: 50_000_000 }).review;
    expect(receipt.validity).toBe("valid");
    expect(workspaceReviewBinding(draft, original)).toEqual(receipt.binding);
  });

  it("never reads irrelevant retained fields, history, or unselected proposal metadata", () => {
    const draft = state([group("selected"), group("ignored", undefined, { decision: "undecided" })]);
    const base = structuredClone(original);
    const expected = workspaceReviewBinding(draft, base);
    const getter = vi.fn(() => { throw new Error("Unrelated data was read"); });
    const accessor = { enumerable: true, configurable: true, get: getter };
    for (const key of ["history", "title", "worldTitle"]) Object.defineProperty(draft, key, accessor);
    for (const key of ["id", "version", "title", "rationale", "operations"]) Object.defineProperty(draft.proposals[1]!, key, accessor);
    for (const key of ["documents", "snapshot"]) Object.defineProperty(base, key, accessor);
    for (const key of ["assertions", "supports", "documents", "definitions"]) Object.defineProperty(base.world, key, accessor);
    expect(workspaceReviewBinding(draft, base)).toEqual(expected);
    expect(getter).not.toHaveBeenCalled();
    expect(() => reviewWorkspace(draft, base, { maxWorkUnits: 50_000_000 })).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects accessors in every touched binding path without executing them", () => {
    type Install = (draft: WorkspaceStateV1, base: WorkspaceBaseV1, accessor: PropertyDescriptor) => unknown;
    const installs: Install[] = [
      (draft, _base, accessor) => Object.defineProperty(draft, "format", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "id", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "version", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "base", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.base, "snapshotDigest", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.base, "worldId", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "goal", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "direction", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "proposals", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals, "0", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals[0]!, "id", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals[0]!, "version", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals[0]!, "operations", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals[0]!.operations[0]!, "text", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.proposals[1]!, "decision", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft, "pins", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.pins[0]!, "id", accessor),
      (draft, _base, accessor) => Object.defineProperty(draft.pins[0]!, "sha256", accessor),
      (_draft, base, accessor) => Object.defineProperty(base, "world", accessor),
      (_draft, base, accessor) => Object.defineProperty(base.world, "world", accessor),
      (_draft, base, accessor) => Object.defineProperty(base.world.world, "semanticProfileDigest", accessor),
    ];
    for (const install of installs) {
      const base = structuredClone(original);
      const document = base.documents[0]!;
      const draft = state([group("selected"), group("ignored", undefined, { decision: "undecided" })], base, {
        pins: [{ id: "pin", kind: "document", path: document.path, sha256: document.sha256, active: true }],
      });
      const getter = vi.fn(() => { throw new Error("Accessor executed"); });
      install(draft, base, { enumerable: true, configurable: true, get: getter });
      expect(() => workspaceReviewBinding(draft, base)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("rejects relevant proxies and noncanonical data without running proxy traps", () => {
    const trap = vi.fn(() => { throw new Error("Proxy trap executed"); });
    const proxy = <T extends object>(value: T): T => new Proxy(value, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    const draft = state();
    const selected = draft.proposals[0]!;
    const variants = [
      proxy(draft),
      { ...draft, proposals: proxy(draft.proposals) },
      { ...draft, proposals: [proxy(selected)] },
      { ...draft, proposals: [{ ...selected, operations: [proxy(selected.operations[0]!)] }] },
      { ...draft, direction: "\ud800" },
      { ...draft, proposals: new Array<ProposalGroupV1>(1) },
      { ...draft, proposals: Object.assign([selected], { extra: true }) },
      { ...draft, proposals: [{ ...selected, operations: [Object.assign({}, selected.operations[0], { [Symbol("hidden")]: true })] }] },
    ];
    for (const variant of variants) expect(() => workspaceReviewBinding(variant, original)).toThrow(TypeError);
    expect(() => workspaceReviewBinding(draft, proxy(original))).toThrow(TypeError);
    expect(() => workspaceReviewBinding(draft, { ...original, world: proxy(original.world) })).toThrow(TypeError);
    expect(() => workspaceReviewBinding(draft, { ...original, world: { ...original.world, world: proxy(original.world.world) } })).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
    const nonenumerable = { ...draft };
    Object.defineProperty(nonenumerable, "goal", { value: draft.goal, enumerable: false });
    expect(() => workspaceReviewBinding(nonenumerable, original)).toThrow(TypeError);
    const customPrototype = Object.assign(Object.create({ inherited: true }), selected) as ProposalGroupV1;
    expect(() => workspaceReviewBinding({ ...draft, proposals: [customPrototype] }, original)).toThrow(TypeError);
  });

  it("replays receipts, rejects stale state/base and does not trust self-consistent forged hashes or limits", () => {
    const draft = state();
    const receipt = reviewWorkspace(draft, original).review;
    expect(verifyWorkspaceReviewReceipt(receipt, draft, original)).toBe(true);
    expect(verifyWorkspaceReviewReceipt(receipt, { ...draft, version: 4 }, original)).toBe(false);
    expect(verifyWorkspaceReviewReceipt(receipt, { ...draft, direction: "changed" }, original)).toBe(false);
    expect(verifyWorkspaceReviewReceipt(receipt, draft, { ...original, documents: [] })).toBe(false);
    const { evaluationDigest: _, ...body } = receipt;
    const forgery = { ...body, diff: { documents: [], assertions: [] } };
    expect(verifyWorkspaceReviewReceipt({ ...forgery, evaluationDigest: workspaceReviewDigest(forgery) }, draft, original)).toBe(false);
    const forgedLimits = { ...body, limits: { maxWorkUnits: 1 } };
    expect(verifyWorkspaceReviewReceipt({ ...forgedLimits, evaluationDigest: workspaceReviewDigest(forgedLimits) }, draft, original)).toBe(false);
    expect(verifyWorkspaceReviewReceipt({ ...receipt, limits: { maxWorkUnits: 50_000_001 } }, draft, original)).toBe(false);
    expect(verifyWorkspaceReviewReceipt({ ...receipt, checks: receipt.checks.slice(1) }, draft, original)).toBe(false);
  });

  it("replays guaranteed opposition rather than trusting a self-sealed weaker uncertainty receipt", () => {
    const positive = claim({ applicability: boundedPoint("2", "8") });
    const negative = claim({ polarity: "negative", applicability: interval("0", "10") });
    const draft = state([group("a", [activate(positive), activate(negative)])], empty);
    const receipt = reviewWorkspace(draft, empty).review;
    expect(receipt.validity).toBe("invalid");
    expect(verifyWorkspaceReviewReceipt(receipt, draft, empty)).toBe(true);
    const { evaluationDigest: _, ...body } = receipt;
    const forgery: Omit<WorkspaceReviewV1, "evaluationDigest"> = {
      ...body, validity: "undetermined",
      checks: body.checks.map((check) => check.id === "explicit-opposition" ? { ...check, status: "unresolved" as const } : check),
      diagnostics: [{ code: "OPPOSITION_UNRESOLVED", severity: "warning", groupIds: ["a"], assertionIds: [positive.id, negative.id].sort(), message: "Syntactically uncertain applicability." }],
    };
    const forgedReceipt = { ...forgery, evaluationDigest: workspaceReviewDigest(forgery) };
    expect(validateWorkspaceReviewReceipt(forgedReceipt).valid).toBe(true);
    expect(verifyWorkspaceReviewReceipt(forgedReceipt, draft, empty)).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 50_000_001])("rejects invalid work limit %j", (maxWorkUnits) => {
    expect(() => reviewWorkspace(state(), original, { maxWorkUnits })).toThrow(TypeError);
  });

  it("exhausts work deterministically without returning even a partial receipt, accounting for scalar bytes", () => {
    for (let i = 0; i < 2; i += 1) expect(() => reviewWorkspace(state(), original, { maxWorkUnits: 1 })).toThrow(WorkspaceReviewBudgetError);
    const huge = state([group("a", [write("prose/a.md", "a".repeat(2_000_001))])]);
    expect(() => reviewWorkspace(huge, original)).toThrow(WorkspaceReviewBudgetError);
    expect(() => reviewWorkspace(state(), original, { maxWorkUnits: 50_000_000 })).not.toThrow();
  });

  it("reserves manifest uniqueness work before validating thousands of distinct entries", () => {
    const payload = Buffer.alloc(0);
    const documents = Array.from({ length: 2000 }, (_, i) => ({
      path: `prose/retained-${String(i).padStart(4, "0")}.md`, mediaType: "text/markdown",
      sha256: sha256Hex(payload), base64: "",
    }));
    const base = rebuild({ ...empty, documents: [...empty.documents, ...documents] });
    const draft = state([group("a")], base);
    expect(base.snapshot.snapshotDigest).toBe(snapshotDigest(base.snapshot.manifest));
    expect(draft.base.snapshotDigest).toBe(base.snapshot.snapshotDigest);
    const validator = vi.spyOn(wireContracts, "validateWorldRecord").mockImplementation(() => {
      throw new Error("Manifest validation must not run without its work reservation");
    });
    try {
      expect(() => reviewWorkspace(draft, base, { maxWorkUnits: 5_000_000 }))
        .toThrow("Snapshot manifest uniqueness comparison budget exhausted");
      expect(validator).not.toHaveBeenCalled();
    } finally { validator.mockRestore(); }
  });

  it("also reserves uniqueness work before validating an expanded candidate manifest", () => {
    const operations = Array.from({ length: 200 }, (_, i) => write(`prose/candidate-${String(i).padStart(4, "0")}.md`, ""));
    const validator = vi.spyOn(wireContracts, "validateWorldRecord");
    try {
      expect(() => reviewWorkspace(state([group("a", operations)], empty), empty, { maxWorkUnits: 5_000_000 }))
        .toThrow("Snapshot manifest uniqueness comparison budget exhausted");
      const snapshots = validator.mock.calls.filter(([value]) =>
        value !== null && typeof value === "object" && "format" in value && value.format === "wmm.snapshot-record/1");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]![0]).toEqual(empty.snapshot);
    } finally { validator.mockRestore(); }
  });

  it("reserves scalar-bound evaluation work before delegating temporal feasibility checks", () => {
    const uncertain = claim({ applicability: {
      kind: "interval", axisDefinitionDigest: axis,
      start: { kind: "boundedUnknown", lowerInclusive: "0", upperExclusive: `1${"0".repeat(1000)}` },
      endExclusive: { kind: "unknown" },
    } });
    const opposite = claim({ polarity: "negative", applicability: point("5") });
    const draft = state([group("a", [activate(uncertain), activate(opposite)])], empty);
    expect(() => reviewWorkspace(draft, empty)).toThrow("Workspace opposition temporal evaluation budget exhausted");
    const result = reviewWorkspace(draft, empty, { maxWorkUnits: 50_000_000 });
    expect(result.review.validity).toBe("undetermined");
    expect(result.review.diagnostics[0]!.message).toContain("uncertain-applicability");
  });

  it("bounds pair comparisons as work, not just input nodes", () => {
    const claims = Array.from({ length: 80 }, (_, i) => claim({ applicability: point(String(i)) }));
    const base = withClaims(claims);
    expect(() => reviewWorkspace(state([group("a")], base), base)).toThrow(WorkspaceReviewBudgetError);
  });

  it("refuses receipts above 1 MiB even under the maximum work limit", () => {
    const draft = state([group("a", Array.from({ length: 75 }, (_, i) => write(`prose/doc-${i}.md`, "x".repeat(16000))))], empty);
    expect(() => reviewWorkspace(draft, empty, { maxWorkUnits: 50_000_000 })).toThrow(WorkspaceReviewBudgetError);
  });

  it("refuses receipts above 75000 nodes, including well-formed invalid candidates", () => {
    const valueDefinitionDigest = definitions.find(({ body }) => body.key === "population_coverage_basis")!.digest;
    const assertion = claim({ proposition: {
      kind: "atom", subjectId: "person:alys", predicateDefinitionDigest: predicate,
      value: { kind: "literal", valueDefinitionDigest, data: Array.from({ length: 75001 }, () => null) },
    } });
    const draft = state([group("a", [activate(assertion)])], empty);
    expect(() => reviewWorkspace(draft, empty, { maxWorkUnits: 50_000_000 })).toThrow(WorkspaceReviewBudgetError);
  });

  it("does not execute accessors or proxies supplied by typed callers", () => {
    const getter = vi.fn(() => "untrusted");
    const draft = { ...state(), direction: "normal" };
    Object.defineProperty(draft, "direction", { enumerable: true, get: getter });
    expect(() => reviewWorkspace(draft, original)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error("proxy executed"); });
    const proxy = new Proxy(state(), { ownKeys: trap, get: trap });
    expect(() => reviewWorkspace(proxy, original)).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
    const maliciousLimits = Object.defineProperty({}, "maxWorkUnits", { enumerable: true, get: getter });
    expect(() => reviewWorkspace(state(), original, maliciousLimits)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});
