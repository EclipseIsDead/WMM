import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";
import { canonicalJson } from "@wmm/canonical";
import type { ActorBrief, ActorContextPacket, ActorDecisionDraft, AuthoringProject, JsonValue } from "@wmm/wire-contracts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "tools/verify-fixtures.mjs");
const temporary: string[] = [];
interface Check { id: string; file: string | null; status: string; error?: string; exitCode?: number }
interface QueryCase { name: string; request: Record<string, unknown>; expected: Record<string, unknown> }
interface QueryCases { format: string; requests: QueryCase[] }
interface Report {
  fixtureFiles: string[];
  coveredFiles: string[];
  checks: Check[];
  totals: { fixtureFiles: number; coveredFiles: number; checks: number; passed: number; failed: number; listed: number };
}
function directory(): string {
  const path = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "wmm-fixtures-test-")));
  temporary.push(path);
  return path;
}
function jsonFiles(path: string, prefix = ""): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? jsonFiles(join(path, entry.name), `${relative}/`) : entry.name.endsWith(".json") ? [relative] : [];
  }).sort();
}
function fixture(path: string, name: string, value: unknown): void {
  writeFileSync(join(path, name), JSON.stringify(value));
}
function queryCases(name: string): QueryCases {
  return JSON.parse(readFileSync(join(root, "fixtures/v2", name), "utf8")) as QueryCases;
}
function invoke(args: string[] = [], cwd = root, nodeArgs: string[] = []): { code: number | null; stdout: string; stderr: string; report: Report } {
  const result = spawnSync(process.execPath, [...nodeArgs, script, "--json", ...args], {
    cwd, shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout, "verifier must emit a JSON report").not.toBe("");
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, report: JSON.parse(result.stdout) as Report };
}
function commandTrace(): { nodeArgs: string[]; read: () => string[][] } {
  const path = directory(), trace = join(path, "commands.ndjson"), hook = join(path, "trace.mjs");
  writeFileSync(hook, `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args[1]) + "\\n");
  return original(...args);
};
syncBuiltinESMExports();
`);
  return { nodeArgs: ["--import", hook], read: () => existsSync(trace) ? readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as string[]) : [] };
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("provides the executable all-fixtures verifier", () => {
  expect(existsSync(script), "tools/verify-fixtures.mjs must exist").toBe(true);
});

it("lists every recursively discovered JSON and its coverage without running checks", () => {
  const { code, report, stderr } = invoke(["--list"], directory());
  const files = jsonFiles(join(root, "fixtures"));
  expect(files).toHaveLength(104);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(report.fixtureFiles).toEqual(files);
  expect(report.coveredFiles).toEqual(files);
  expect(report.checks.map((check) => check.id)).toContain("contract-kit");
  expect(report.checks.map((check) => check.id)).toContain("seed");
  expect(report.checks.map((check) => check.id)).toContain("authoring/lantern-actor-brief.json#actor/prepare");
  expect(report.checks.map((check) => check.id)).toContain("authoring/lantern-decision-draft.json#actor/review");
  expect(report.checks.every((check) => check.status === "listed")).toBe(true);
  expect(report.totals).toEqual({ fixtureFiles: 104, coveredFiles: 104, checks: 50, passed: 0, failed: 0, listed: 50 });
});

it("executes standalone requests and contract/seed verifiers with the built CLI", () => {
  const path = directory();
  const source = readFileSync(join(root, "fixtures/v1/validate-request.json"));
  writeFileSync(join(path, "request.json"), source);
  const { code, report } = invoke(["--fixtures-dir", path], directory());
  expect(code).toBe(0);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "request.json#request", status: "passed", exitCode: 0 }));
  expect(report.totals).toEqual({ fixtureFiles: 1, coveredFiles: 1, checks: 3, passed: 3, failed: 0, listed: 0 });
  expect(readFileSync(join(path, "request.json"))).toEqual(source);
}, 30_000);

it("checks every API collection entry including exit-2 INVALID_REQUEST cases", () => {
  const path = directory();
  writeFileSync(join(path, "api.json"), readFileSync(join(root, "fixtures/v1/api-requests.json")));
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(0);
  expect(report.checks.filter((check) => check.file === "api.json").map((check) => check.exitCode)).toEqual([0, 0, 0, 2, 2, 2]);
  expect(report.totals).toMatchObject({ checks: 8, passed: 8, failed: 0, listed: 0 });
}, 30_000);

it.each(["claim", "absence", "interval", "interval-budget"])("rejects each wrong %s golden without skipping the following good case", (kind) => {
  const path = directory(), cases = queryCases(`${kind === "interval-budget" ? "interval" : kind}-query-cases.json`), good = cases.requests[kind === "interval-budget" ? 3 : 0]!;
  const requests = Object.keys(good.expected).map((key) => ({ ...good, expected: { ...good.expected, [key]: null } }));
  fixture(path, "cases.json", { ...cases, requests: [...requests, good] });
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.checks.filter((check) => check.file === "cases.json").map((check) => check.status)).toEqual([...requests.map(() => "failed"), "passed"]);
  expect(report.totals).toMatchObject({ failed: requests.length, passed: 3 });
}, 30_000);

it("fails closed on missing, empty, or unknown expectations and continues to a good file", () => {
  const path = directory(), cases = queryCases("claim-query-cases.json"), good = cases.requests[0]!;
  const { expected: _expected, ...missing } = good;
  fixture(path, "a-bad.json", { ...cases, requests: [{ ...good, expected: {} }, missing, { ...good, expected: { ...good.expected, unknownGolden: true } }] });
  fixture(path, "z-good.json", { ...cases, requests: [good] });
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.checks.filter((check) => check.file === "a-bad.json").map((check) => check.status)).toEqual(["failed", "failed", "failed"]);
  expect(report.checks).toContainEqual(expect.objectContaining({ file: "z-good.json", status: "passed" }));
}, 30_000);

it("recognizes all authoring projects and schedules deterministic builds/renders and every atlas", () => {
  const path = directory();
  fixture(path, "first.json", { format: "wmm.authoring-project/1", atlases: [{ id: "one" }, { id: "two" }] });
  fixture(path, "second.json", { format: "wmm.authoring-project/1" });
  const { code, report } = invoke(["--fixtures-dir", path, "--list"]);
  expect(code).toBe(0);
  expect(report.coveredFiles).toEqual(["first.json", "second.json"]);
  for (const file of report.fixtureFiles) {
    const ids = report.checks.filter((check) => check.file === file).map((check) => check.id);
    for (const stage of ["check", "build/1", "build/2", "validate/1", "validate/2", "render/1", "render/2", "compare-bundles", "compare-notes"]) expect(ids).toContain(`${file}#authoring/${stage}`);
  }
  expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["first.json#atlas/one", "first.json#atlas/two"]));
  expect(report.checks.every((check) => check.status === "listed")).toBe(true);
});

it("prepares and reviews renamed actor examples against the matching snapshot, not the first project's campaign identity", () => {
  const path = directory();
  const project = JSON.parse(readFileSync(join(root, "fixtures/authoring/faction-project.json"), "utf8")) as Record<string, unknown>;
  fixture(path, "a-same-identities-wrong-snapshot.json", { ...project, title: "A different authored snapshot" });
  fixture(path, "z-matching-project.json", project);
  writeFileSync(join(path, "b-decision.json"), readFileSync(join(root, "fixtures/authoring/lantern-decision-draft.json")));
  writeFileSync(join(path, "c-brief.json"), readFileSync(join(root, "fixtures/authoring/lantern-actor-brief.json")));
  const original = jsonFiles(path).map((file) => readFileSync(join(path, file)));
  const trace = commandTrace(), inventory = invoke(["--fixtures-dir", path, "--list"], root, trace.nodeArgs);
  expect(inventory.code).toBe(0);
  expect(inventory.report.checks.every((check) => check.status === "listed")).toBe(true);
  expect(trace.read(), "inventory must not execute any command, including authoring or actor checks").toEqual([]);
  const { code, report, stderr } = invoke(["--fixtures-dir", path], directory(), trace.nodeArgs);
  expect(code, JSON.stringify(report.checks.filter((check) => check.status === "failed"))).toBe(0);
  expect(stderr).toBe("");
  expect(report.fixtureFiles).toEqual(jsonFiles(path));
  expect(report.coveredFiles).toEqual(report.fixtureFiles);
  expect(report.checks.map((check) => check.id)).toEqual(inventory.report.checks.map((check) => check.id));
  expect(report.checks.filter((check) => ["b-decision.json", "c-brief.json"].includes(check.file ?? ""))).toEqual([
    { file: "c-brief.json", id: "c-brief.json#actor/prepare", status: "passed", exitCode: 0 },
    { file: "b-decision.json", id: "b-decision.json#actor/review", status: "passed", exitCode: 0 },
  ]);
  expect(report.totals).toEqual({ fixtureFiles: 4, coveredFiles: 4, checks: 22, passed: 22, failed: 0, listed: 0 });
  const calls = trace.read(), actorCalls = calls.filter((args) => args[2] === "actor"), actorBundle = actorCalls[0]?.[4];
  expect(actorCalls.map((args) => args.slice(2))).toEqual([
    ["actor", "prepare", actorBundle, join(path, "c-brief.json")],
    ["actor", "review", actorBundle, join(path, "c-brief.json"), join(path, "b-decision.json")],
  ]);
  expect(calls.map((args) => args.slice(2))).toContainEqual(["authoring", "build", join(path, "z-matching-project.json"), "--out", actorBundle]);
  expect(jsonFiles(path).map((file) => readFileSync(join(path, file)))).toEqual(original);
}, 30_000);

it("binds actor examples to a discovered verified authored bundle without requiring a project input", () => {
  const path = directory(), bundle = join(path, "nested-bundle");
  const built = spawnSync(process.execPath, [join(root, "apps/cli/dist/main.js"), "authoring", "build", join(root, "fixtures/authoring/faction-project.json"), "--out", bundle], {
    encoding: "utf8", timeout: 15_000,
  });
  expect(built.error).toBeUndefined();
  expect(built.status, built.stdout + built.stderr).toBe(0);
  for (const name of ["lantern-actor-brief.json", "lantern-decision-draft.json"]) writeFileSync(join(path, name), readFileSync(join(root, "fixtures/authoring", name)));
  const files = jsonFiles(path), original = files.map((file) => readFileSync(join(path, file)));
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code, JSON.stringify(report.checks.filter((check) => check.status === "failed"))).toBe(0);
  expect(report.fixtureFiles).toEqual(files);
  expect(report.coveredFiles).toEqual(files);
  expect(report.checks.map((check) => check.id)).toEqual([
    "contract-kit", "seed", "nested-bundle/snapshot.json#world.validate", "lantern-actor-brief.json#actor/prepare", "lantern-decision-draft.json#actor/review",
  ]);
  expect(report.totals).toEqual({ fixtureFiles: files.length, coveredFiles: files.length, checks: 5, passed: 5, failed: 0, listed: 0 });
  expect(files.map((file) => readFileSync(join(path, file)))).toEqual(original);
}, 30_000);

it.each([false, true])("matches a different atlas actor by rebuilt context, with campaign=%s, after capture removes the first build", (campaign) => {
  const path = directory(), projectPath = join(path, "m-project.json"), bundle = join(directory(), "bundle");
  const atlas = JSON.parse(readFileSync(join(root, "fixtures/authoring/atlas-project.json"), "utf8")) as AuthoringProject;
  const selectedCampaign = { id: "campaign:island_watch", name: "Island watch", sections: [], tracks: [] };
  fixture(path, "m-project.json", { ...atlas, campaigns: [selectedCampaign] });
  const built = spawnSync(process.execPath, [join(root, "apps/cli/dist/main.js"), "authoring", "build", projectPath, "--out", bundle], { encoding: "utf8", timeout: 15_000 });
  expect(built.error).toBeUndefined();
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const snapshot = JSON.parse(readFileSync(join(bundle, "snapshot.json"), "utf8")) as { snapshotDigest: string };
  const brief: ActorBrief = { format: "wmm.actor-brief/1", snapshotDigest: snapshot.snapshotDigest, actorId: "faction:auren_crown",
    ...(campaign ? { campaignId: selectedCampaign.id } : {}), question: "What should the island watch propose?",
    items: [{ id: "constraint", kind: "constraint", text: "Make a proposal only; do not execute or deliver it.", basis: [] }],
  };
  fixture(path, "a-different-context.json", { ...brief, question: "A different question for the same actor and snapshot?" });
  fixture(path, "z-matching-context.json", brief);
  const prepared = spawnSync(process.execPath, [join(root, "apps/cli/dist/main.js"), "actor", "prepare", bundle, join(path, "z-matching-context.json")], { encoding: "utf8", timeout: 15_000 });
  expect(prepared.error).toBeUndefined();
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  const context = JSON.parse(prepared.stdout).data as ActorContextPacket;
  const decision: ActorDecisionDraft = { format: "wmm.actor-decision/1", status: "proposed", contextDigest: context.contextDigest,
    action: { text: "Propose maintaining the island watch.", basis: ["constraint"] }, rationale: { text: "Execution requires a separate decision.", basis: ["constraint"] }, uncertainties: [], communication: null,
  };
  fixture(path, "b-decision.json", decision);
  const trace = commandTrace(), { code, report } = invoke(["--fixtures-dir", path], root, trace.nodeArgs);
  expect(code, JSON.stringify(report.checks.filter((check) => check.status === "failed"))).toBe(0);
  expect(report.fixtureFiles).toEqual(jsonFiles(path));
  expect(report.coveredFiles).toEqual(report.fixtureFiles);
  expect(report.totals).toEqual({ fixtureFiles: 4, coveredFiles: 4, checks: 17, passed: 17, failed: 0, listed: 0 });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "m-project.json#authoring/capture", status: "passed" }));
  const actorCalls = trace.read().filter((args) => args[2] === "actor").map((args) => args.slice(2));
  expect(actorCalls).toEqual([
    ["actor", "prepare", expect.any(String), join(path, "a-different-context.json")],
    ["actor", "prepare", expect.any(String), join(path, "z-matching-context.json")],
    ["actor", "review", actorCalls[1]?.[2], join(path, "z-matching-context.json"), join(path, "b-decision.json")],
  ]);
}, 30_000);

it("rejects an executed actor decision through the real review path without skipping a later proposed decision", () => {
  const path = directory();
  const decision = JSON.parse(readFileSync(join(root, "fixtures/authoring/lantern-decision-draft.json"), "utf8")) as Record<string, unknown>;
  for (const name of ["faction-project.json", "lantern-actor-brief.json"]) writeFileSync(join(path, name), readFileSync(join(root, "fixtures/authoring", name)));
  fixture(path, "a-executed.json", { ...decision, status: "executed" });
  fixture(path, "z-proposed.json", decision);
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.coveredFiles).toEqual(report.fixtureFiles);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "a-executed.json#actor/review", status: "failed", error: expect.stringContaining("INVALID_ACTOR_DECISION") }));
  expect(report.checks).toContainEqual({ file: "z-proposed.json", id: "z-proposed.json#actor/review", status: "passed", exitCode: 0 });
  expect(report.totals).toEqual({ fixtureFiles: 4, coveredFiles: 4, checks: 14, passed: 13, failed: 1, listed: 0 });
}, 30_000);

it("rejects malformed, stale, unknown-actor and invalid-basis inputs while continuing through good actor fixtures", () => {
  const path = directory();
  const brief = JSON.parse(readFileSync(join(root, "fixtures/authoring/lantern-actor-brief.json"), "utf8")) as ActorBrief;
  const decision = JSON.parse(readFileSync(join(root, "fixtures/authoring/lantern-decision-draft.json"), "utf8")) as ActorDecisionDraft;
  const badBriefs = [
    ["extra-brief-field", { ...brief, execute: true }, "INVALID_ACTOR_BRIEF"],
    ["blank-question", { ...brief, question: " " }, "INVALID_ACTOR_BRIEF"],
    ["unknown-actor", { ...brief, actorId: "faction:missing" }, "UNKNOWN_ACTOR"],
    ["unknown-campaign", { ...brief, campaignId: "campaign:missing" }, "UNKNOWN_ACTOR_CAMPAIGN"],
    ["missing-source-basis", { ...brief, items: [{ ...brief.items[0]!, basis: [{ kind: "section", ownerId: brief.actorId, sectionId: "missing" }] }] }, "INVALID_ACTOR_BASIS"],
    ["stale-snapshot", { ...brief, snapshotDigest: "0".repeat(64) }, "No verified authored snapshot matches"],
  ] as const;
  const badDecisions = [
    ["unknown-decision-basis", { ...decision, action: { ...decision.action, basis: ["not-disclosed"] } }, "UNKNOWN_DECISION_BASIS"],
    ["blank-action", { ...decision, action: { ...decision.action, text: " " } }, "INVALID_ACTOR_DECISION"],
    ["delivered-message", { ...decision, communication: { ...decision.communication!, status: "delivered" } }, "INVALID_ACTOR_DECISION"],
    ["stale-context", { ...decision, contextDigest: "0".repeat(64) }, "No prepared actor context matches"],
  ] as const;
  writeFileSync(join(path, "project.json"), readFileSync(join(root, "fixtures/authoring/faction-project.json")));
  for (const [name, value] of [...badBriefs, ...badDecisions]) fixture(path, `${name}.json`, value);
  fixture(path, "z-good-brief.json", brief);
  fixture(path, "z-good-decision.json", decision);
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.fixtureFiles).toEqual(jsonFiles(path));
  expect(report.coveredFiles).toEqual(report.fixtureFiles);
  for (const [cases, stage] of [[badBriefs, "prepare"], [badDecisions, "review"]] as const) for (const [name, _value, error] of cases) {
    expect(report.checks).toContainEqual(expect.objectContaining({ id: `${name}.json#actor/${stage}`, status: "failed", error: expect.stringContaining(error) }));
  }
  expect(report.checks).toContainEqual({ file: "z-good-brief.json", id: "z-good-brief.json#actor/prepare", status: "passed", exitCode: 0 });
  expect(report.checks).toContainEqual({ file: "z-good-decision.json", id: "z-good-decision.json#actor/review", status: "passed", exitCode: 0 });
  expect(report.totals).toEqual({ fixtureFiles: 13, coveredFiles: 13, checks: 23, passed: 13, failed: 10, listed: 0 });
}, 30_000);

it.each(["missing snapshot", "missing brief"])("rejects actor inputs with a %s instead of silently covering an unbound file", (missing) => {
  const path = directory();
  for (const name of missing === "missing snapshot" ? ["lantern-actor-brief.json", "lantern-decision-draft.json"] : ["faction-project.json", "lantern-decision-draft.json"]) {
    writeFileSync(join(path, name), readFileSync(join(root, "fixtures/authoring", name)));
  }
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.fixtureFiles).toEqual(jsonFiles(path));
  expect(report.coveredFiles).toEqual(report.fixtureFiles);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "lantern-decision-draft.json#actor/review", status: "failed", error: expect.stringContaining("No prepared actor context matches") }));
  if (missing === "missing snapshot") {
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "lantern-actor-brief.json#actor/prepare", status: "failed", error: expect.stringContaining("No verified authored snapshot matches") }));
    expect(report.totals).toEqual({ fixtureFiles: 2, coveredFiles: 2, checks: 4, passed: 2, failed: 2, listed: 0 });
  } else expect(report.totals).toEqual({ fixtureFiles: 2, coveredFiles: 2, checks: 12, passed: 11, failed: 1, listed: 0 });
}, 30_000);

it("rejects missing manifest members even during a nonexecuting inventory", () => {
  const path = directory(), bundle = join(path, "bundle");
  cpSync(join(root, "fixtures/v1/complete-world"), bundle, { recursive: true });
  rmSync(join(bundle, "payload/prose/valen.md"));
  const { code, report } = invoke(["--fixtures-dir", path, "--list"]);
  expect(code).toBe(1);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "bundle/snapshot.json#manifest", status: "failed" }));
});

it("continues past malformed collection entries and detects a falsely invalid request", () => {
  const path = directory();
  const cases = JSON.parse(readFileSync(join(root, "fixtures/v1/api-requests.json"), "utf8")) as { requests: unknown[]; invalidRequests: unknown[] };
  fixture(path, "api.json", { ...cases, invalidRequests: [null, { name: "actually valid", payload: cases.requests[0] }, cases.invalidRequests[0]] });
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "api.json#invalidRequests/1", status: "failed", error: expect.stringContaining("exit code") }));
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "api.json#invalidRequests/2", status: "passed", exitCode: 2 }));
}, 30_000);

it("does not ignore invalid-case expectation fields and executes explicit null invalid input", () => {
  const path = directory();
  const cases = JSON.parse(readFileSync(join(root, "fixtures/v1/api-requests.json"), "utf8")) as { requests: unknown[]; invalidRequests: unknown[] };
  fixture(path, "api.json", { ...cases, invalidRequests: [{ ...cases.invalidRequests[0] as object, expected: { unknownExpectation: true } }, { name: "null input", payload: null }] });
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "api.json#invalidRequests/0", status: "failed" }));
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "api.json#invalidRequests/1", status: "passed", exitCode: 2 }));
}, 30_000);

it.each(["unknown format", "unknown actor format", "actor context artifact", "null JSON", "invalid JSON", "empty claims", "empty absence", "empty interval", "empty API", "empty V0"])("rejects %s without silently skipping coverage", (kind) => {
  const path = directory();
  if (kind === "invalid JSON") writeFileSync(join(path, "bad.json"), "{");
  else if (kind === "null JSON") fixture(path, "bad.json", null);
  else if (kind === "unknown format") fixture(path, "bad.json", { format: "wmm.unknown/1" });
  else if (kind === "unknown actor format") fixture(path, "bad.json", { format: "wmm.actor-decision/2" });
  else if (kind === "actor context artifact") fixture(path, "bad.json", { format: "wmm.actor-context/1" });
  else if (kind === "empty API") fixture(path, "bad.json", { format: "wmm.api-fixtures/1", requests: [], invalidRequests: [] });
  else if (kind === "empty V0") fixture(path, "bad.json", { format: "wmm.v0-semantic-cases/1", scopeCases: [] });
  else fixture(path, "bad.json", { format: `wmm.${kind === "empty claims" ? "claim" : kind.slice(6)}-query-fixtures/1`, requests: [] });
  const { code, report } = invoke(["--fixtures-dir", path, "--list"]);
  expect(code).toBe(1);
  expect(report.fixtureFiles).toEqual(["bad.json"]);
  expect(report.coveredFiles).toEqual([]);
  expect(report.totals.failed).toBeGreaterThan(0);
});

it.each([false, true])("rejects an empty or missing fixture root (missing=%s)", (missing) => {
  const path = directory();
  const { code, report } = invoke(["--fixtures-dir", missing ? join(path, "missing") : path, "--list"]);
  expect(code).toBe(1);
  expect(report.fixtureFiles).toEqual([]);
  expect(report.totals.failed).toBe(1);
});

it("does not let an unsafe directory entry prevent a later good fixture from running", () => {
  const path = directory();
  symlinkSync(directory(), join(path, "a-link"), "dir");
  writeFileSync(join(path, "z-good.json"), readFileSync(join(root, "fixtures/v1/validate-request.json")));
  const { code, report } = invoke(["--fixtures-dir", path]);
  expect(code).toBe(1);
  expect(report.checks).toContainEqual(expect.objectContaining({ file: "a-link", status: "failed" }));
  expect(report.checks).toContainEqual(expect.objectContaining({ file: "z-good.json", status: "passed" }));
}, 30_000);

it("runs every discovered fixture with exact canonical totals and leaves source fixture bytes unchanged", () => {
  const inventory = invoke(["--list"]).report;
  const sources = readdirSync(join(root, "fixtures"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  const original = sources.map((file) => readFileSync(file));
  const { code, report, stdout } = invoke([], directory());
  expect(code, JSON.stringify(report.checks.filter((check) => check.status === "failed"))).toBe(0);
  expect(stdout).toBe(`${canonicalJson(report as unknown as JsonValue)}\n`);
  expect(report.fixtureFiles).toEqual(inventory.fixtureFiles);
  expect(report.coveredFiles).toEqual(inventory.fixtureFiles);
  expect(report.checks.map((check) => check.id)).toEqual(inventory.checks.map((check) => check.id));
  expect(report.totals).toEqual({ fixtureFiles: 104, coveredFiles: 104, checks: 50, passed: 50, failed: 0, listed: 0 });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "v2/interval-query-cases.json#requests/3", exitCode: 4, status: "passed" }));
  expect(sources.map((file) => readFileSync(file))).toEqual(original);
}, 120_000);
