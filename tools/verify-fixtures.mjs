#!/usr/bin/env node
// Fixture coverage is explicit: bundle manifest members or recognized executable inputs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateApiResponse } from "../packages/wire-contracts/dist/index.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/canonical/dist/index.js";
import { parseStrictJson } from "../apps/cli/dist/json-input.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const checks = [], plans = [], files = new Map(), covered = new Set(), outputRoots = [];
const verifiedSnapshots = [], actorContexts = [];
let fixtureRoot = join(repo, "fixtures"), list = false, json = false;
const read = (path) => parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
const label = (path) => relative(fixtureRoot, path).split(sep).join("/");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const collection = (value, name) => { assert(Array.isArray(value) && value.length, `${name}: malformed/empty collection`); return value; };
const fail = (file, id, error) => checks.push({ file, id, status: "failed", error: String(error.message ?? error) });
const add = (file, id, kind, value) => {
  try {
    if (kind === "case") assert(object(value?.expected) && Object.keys(value.expected).length, "Malformed/empty expected collection");
    if (kind === "invalid") {
      assert(object(value) && Object.hasOwn(value, "payload"), "Malformed invalidRequests entry");
      for (const key of Object.keys(value)) assert(["name", "payload"].includes(key), `Unknown invalid-case field: ${key}`);
    }
    plans.push({ file, id, kind, value });
  } catch (error) { fail(file, id, error); }
};

function discover(path) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const absolute = join(path, entry.name);
    try {
      if (entry.isDirectory()) discover(absolute);
      else if (/\.json$/i.test(entry.name)) {
        files.set(absolute, undefined);
        assert(entry.isFile(), "Fixture must be a regular non-symlink file"); files.set(absolute, read(absolute));
      } else assert(entry.isFile(), `Unsupported fixture entry: ${absolute}`);
    } catch (error) { fail(label(absolute), `${label(absolute)}#discovery`, error); }
  }
}

function planFixtures() {
  const briefs = [], decisions = [];
  add(null, "contract-kit", "dev", ["contract-kit", "verify", join(repo, "wmm-v0.3-contract-kit")]);
  add(null, "seed", "dev", ["seed", "validate", join(repo, "wmm-v0.3-contract-kit")]);
  for (const [path, value] of files) {
    if (value?.format !== "wmm.snapshot-record/1") continue;
    const file = label(path);
    covered.add(path);
    const verified = {};
    verifiedSnapshots.push(verified);
    add(file, `${file}#world.validate`, "action", () => verifySnapshot(dirname(path), verified));
    try {
      for (const member of collection(value.manifest?.files, "manifest.files")) {
        assert(typeof member?.path === "string" && member.path, "Malformed manifest member");
        const memberPath = resolve(dirname(path), "payload", member.path);
        assert(memberPath.startsWith(`${join(dirname(path), "payload")}${sep}`), "Manifest path escapes payload");
        assert(lstatSync(memberPath).isFile(), `Missing/nonregular manifest member: ${member.path}`);
        if (files.has(memberPath)) covered.add(memberPath);
      }
    } catch (error) { fail(file, `${file}#manifest`, error); }
  }
  for (const [path, value] of files) {
    if (covered.has(path) || value === undefined) continue;
    const file = label(path), format = value?.format;
    try {
      if (format === "wmm.v0-semantic-cases/1") {
        for (const key of ["scopeCases", "evidenceCases", "familyCases", "temporalCases", "temporalInvalidCases", "semanticSchemaPositiveCases", "semanticSchemaNegativeCases"]) collection(value[key], key);
        add(file, `${file}#v0`, "dev", ["v0", "verify", join(repo, "wmm-v0.3-contract-kit"), path]);
      } else if (format === "wmm.request/1") add(file, `${file}#request`, "request", { request: value });
      else if (format === "wmm.authoring-project/1") planAuthoring(path, value);
      else if (format === "wmm.actor-brief/1") briefs.push([path, value]);
      else if (format === "wmm.actor-decision/1") decisions.push([path, value]);
      else if (format === "wmm.api-fixtures/1") {
        for (const [index, request] of collection(value.requests, "requests").entries()) add(file, `${file}#requests/${index}`, "request", { request });
        for (const [index, item] of collection(value.invalidRequests, "invalidRequests").entries()) add(file, `${file}#invalidRequests/${index}`, "invalid", item);
      } else if (["wmm.claim-query-fixtures/1", "wmm.absence-query-fixtures/1", "wmm.interval-query-fixtures/1"].includes(format)) {
        for (const [index, item] of collection(value.requests, "requests").entries()) add(file, `${file}#requests/${index}`, "case", item);
      } else throw new Error(`Unrecognized fixture format: ${String(format)}`);
      covered.add(path);
    } catch (error) { fail(file, `${file}#discovery`, error); }
  }
  // Resolve bindings at execution time, after every authored snapshot and brief.
  for (const [path, brief] of briefs) planActorBrief(path, brief);
  for (const [path, decision] of decisions) planActorDecision(path, decision);
}

function temporary(action) {
  const path = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "wmm-fixture-")));
  try { return action(path); } finally { rmSync(path, { recursive: true, force: true }); }
}

function run(args, request) {
  const child = spawnSync(process.execPath, ["--no-warnings", join(repo, "apps/cli/dist/main.js"), ...args], {
    cwd: repo, shell: false, encoding: "utf8", input: request === undefined ? undefined : canonicalJson(request),
    timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  assert(!child.error && !child.signal, `CLI subprocess failed: ${child.error?.message ?? child.signal}`);
  assert.equal(child.stderr, "", "Unexpected CLI stderr");
  const response = parseStrictJson(child.stdout);
  assert.equal(child.stdout, `${canonicalJson(response)}\n`, "Noncanonical CLI output");
  return { response, exitCode: child.status };
}

function api(request, expected = {}, workspaceDirectory) {
  const operation = request?.operation;
  assert(object(request) || expected.errorCode === "INVALID_REQUEST", "Malformed request entry");
  assert(expected.errorCode === "INVALID_REQUEST" || ["world.validate", "record.inspect", "world.export", "claims.query", "absence.query", "absence.proveThroughout", "workspace.create", "workspace.read", "workspace.map.read"].includes(operation), "Unsafe or unsupported fixture operation");
  if (operation === "workspace.create" && !workspaceDirectory) return temporary((path) => {
    const storage = join(path, "workspace"), created = api(request, expected, storage);
    if (created.response.outcome === "success") {
      const saved = api({ ...request, operation: "workspace.read", payload: { workspaceId: request.payload.workspaceId } }, {}, storage);
      assert.deepEqual(saved.response.data.workspace, created.response.data.workspace, "Workspace creation did not persist");
    }
    return created;
  });
  const result = run(["json", ...workspaceDirectory ? ["--workspace-dir", workspaceDirectory] : []], request);
  const response = result.response;
  assert(validateApiResponse(response).valid, "Response violates the wmm/1 contract");
  assert.equal(response.requestId, typeof request?.requestId === "string" ? request.requestId : null, "Request correlation mismatch");
  assert.equal(response.operation, typeof operation === "string" ? operation : null, "Operation correlation mismatch");
  assert.equal(result.exitCode, expected.exitCode ?? 0, "Expected exit code");
  assert.equal(response.outcome, expected.outcome ?? "success", "Expected outcome");
  assert.equal(response.execution, expected.execution ?? "completed", "Expected execution");
  if (expected.errorCode !== undefined) assert.equal(response.error?.code, expected.errorCode, "Expected errorCode");
  const projection = { exitCode: result.exitCode, outcome: response.outcome, execution: response.execution, errorCode: response.error?.code };
  if (operation === "claims.query") for (const group of ["definite", "possible", "unresolved", "excluded"]) projection[group] = response.data?.[group].map((item) => item.assertionId);
  if (operation === "absence.query" && response.data) {
    const data = response.data;
    Object.assign(projection, { conclusion: data.conclusion.status, bases: data.conclusion.bases, declaration: data.declaration.status,
      witnesses: data.witnesses.status, derivation: data.derivation.status, derivationReason: data.derivation.reason,
      inputSelectionDigest: data.derivation.inputSelectionDigest, evaluationDigest: data.derivation.evaluationDigest });
  }
  if (operation === "absence.proveThroughout" && response.data) {
    const data = response.data;
    Object.assign(projection, { status: data.status, reason: data.reason, breakpoints: data.breakpoints, cellCount: data.cells.length,
      cells: data.cells.map((cell) => ({ start: cell.start, endExclusive: cell.endExclusive, representativePosition: cell.representativePosition,
        derivation: cell.evaluation.derivation.status, derivationReason: cell.evaluation.derivation.reason, witnesses: cell.evaluation.witnesses.status })) });
    assert.deepEqual(data.partitionIssues, [], "Unexpected interval partition issues");
  }
  for (const [key, value] of Object.entries(expected)) {
    assert(Object.hasOwn(projection, key), `Unknown expectation key: ${key}`);
    assert.deepEqual(projection[key], value, `expected.${key} mismatch`);
  }
  return result;
}

function dev(args, status) {
  const result = run(args);
  assert.equal(result.exitCode, 0, `Development verifier exit code${result.response.error?.code ? `: ${result.response.error.code}` : ""}`);
  assert.equal(result.response.apiVersion, "wmm/dev/1");
  assert.equal(result.response.outcome, "success");
  assert.equal(result.response.execution, "completed");
  if (status) assert.equal(result.response.data?.status, status);
  return result;
}

const request = (operation, payload) => ({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: "fixture-check", operation, payload });
function verifySnapshot(bundlePath, verified) {
  const result = api(request("world.validate", { bundlePath }));
  assert.equal(result.response.data.status, "valid", "Invalid snapshot");
  Object.assign(verified, { bundlePath, snapshotDigest: read(join(bundlePath, "snapshot.json")).snapshotDigest });
  return result;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tree(path, prefix = "") {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap((entry) => {
    const name = prefix + entry.name, absolute = join(path, entry.name);
    if (entry.isDirectory()) return tree(absolute, `${name}/`);
    assert(entry.isFile(), `Unexpected output entry: ${absolute}`);
    return [[name, digest(readFileSync(absolute))]];
  });
}

function planAuthoring(path, project) {
  const file = label(path), atlases = project.atlases ?? [];
  assert(Array.isArray(atlases), "Malformed atlases collection");
  const verified = {};
  verifiedSnapshots.push(verified);
  let directory, captured;
  const atlasDigests = new Map();
  const out = (name) => {
    if (!directory) { directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "wmm-authoring-fixture-"))); outputRoots.push(directory); }
    return join(directory, name);
  };
  const stage = (name, action) => add(file, `${file}#authoring/${name}`, "action", action);
  stage("check", () => dev(["authoring", "check", path], "valid"));
  for (const index of [1, 2]) stage(`build/${index}`, () => dev(["authoring", "build", path, "--out", out(`bundle${index}`)], "valid"));
  for (const index of [1, 2]) stage(`validate/${index}`, () => {
    // Atlas capture removes bundle1; actor checks retain the verified second build.
    return verifySnapshot(out(`bundle${index}`), index === 2 ? verified : {});
  });
  for (const index of [1, 2]) stage(`render/${index}`, () => dev(["notes", "render", out(`bundle${index}`), "--out", out(`notes${index}`)]));
  for (const kind of ["bundles", "notes"]) stage(`compare-${kind}`, () => {
    const base = kind === "bundles" ? "bundle" : "notes", first = tree(out(`${base}1`));
    assert(first.length, `Empty generated ${kind}`);
    assert.deepEqual(first, tree(out(`${base}2`)), `Nondeterministic ${kind}`);
  });
  if (!atlases.length) return;
  stage("capture", () => {
    const bundlePath = out("bundle1");
    for (const atlas of atlases) atlasDigests.set(atlas.id, digest(readFileSync(join(bundlePath, "payload/maps", `${atlas.id}.json`))));
    const created = api(request("workspace.create", { workspaceId: "fixture", bundlePath, title: "Fixture atlas", goal: "Inspect reference maps", mode: "world", idempotencyKey: "fixture-create" }), {}, out("workspace"));
    captured = api(request("workspace.read", { workspaceId: "fixture" }), {}, out("workspace")).response.data.workspace;
    assert.deepEqual(captured, created.response.data.workspace, "Workspace creation did not persist");
    rmSync(bundlePath, { recursive: true }); // Only generated output; subsequent reads must use the captured base.
    return created;
  });
  for (const atlas of atlases) add(file, `${file}#atlas/${atlas.id}`, "action", () => {
    assert(captured, "Workspace capture failed");
    const result = api(request("workspace.map.read", { workspaceId: "fixture", atlasId: atlas.id, geometryVersion: atlas.geometryVersion, atVersion: captured.version }), {}, out("workspace"));
    const data = result.response.data;
    assert.deepEqual(data.atlas, atlas, "Captured atlas mismatch");
    assert.equal(data.atlasDigest, atlasDigests.get(atlas.id), "Captured atlas digest mismatch");
    assert.deepEqual(data.base, captured.base);
    assert.equal(data.workspaceId, captured.id);
    assert.equal(data.workspaceVersion, captured.version);
    assert.equal(data.worldBasis, "base"); assert.equal(data.selectedProposalsIncluded, false);
    assert.equal(data.factProjection, "not-run"); assert.equal(data.candidateView, "unavailable");
    return result;
  });
  stage("readonly", () => assert.deepEqual(api(request("workspace.read", { workspaceId: "fixture" }), {}, out("workspace")).response.data.workspace, captured, "Map reads changed workspace state"));
}

function planActorBrief(path, brief) {
  const file = label(path), prepared = { path };
  actorContexts.push(prepared);
  add(file, `${file}#actor/prepare`, "action", () => {
    const snapshot = verifiedSnapshots.find((item) => item.bundlePath && item.snapshotDigest === brief.snapshotDigest);
    assert(snapshot, "No verified authored snapshot matches actor brief snapshotDigest");
    const result = dev(["actor", "prepare", snapshot.bundlePath, path]);
    Object.assign(prepared, { bundlePath: snapshot.bundlePath, packet: result.response.data });
    return result;
  });
}

function planActorDecision(path, decision) {
  const file = label(path);
  add(file, `${file}#actor/review`, "action", () => {
    const prepared = actorContexts.find((item) => item.packet && item.packet.contextDigest === decision.contextDigest);
    assert(prepared, "No prepared actor context matches decision contextDigest (unbound or stale)");
    const result = dev(["actor", "review", prepared.bundlePath, prepared.path, path]);
    assert.deepEqual(result.response.data.review.context, prepared.packet, "Reviewed actor context mismatch");
    assert.deepEqual(result.response.data.review.decision, decision, "Reviewed decision mismatch");
    return result;
  });
}

function execute(plan) {
  let result;
  if (plan.kind === "action") result = plan.value();
  else if (plan.kind === "dev") result = dev(plan.value, plan.id === "seed" ? "valid-seed-fixture" : "passed");
  else if (plan.kind === "invalid") result = api(plan.value.payload, { exitCode: 2, outcome: "error", execution: "completed", errorCode: "INVALID_REQUEST" });
  else result = api(plan.value.request, plan.value.expected);
  return result ? { exitCode: result.exitCode } : {};
}

try {
  const args = process.argv.slice(2), seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assert(!seen.has(arg), `Duplicate option: ${arg}`); seen.add(arg);
    if (arg === "--json") json = true;
    else if (arg === "--list") list = true;
    else if (arg === "--fixtures-dir" && args[i + 1] && !args[i + 1].startsWith("--")) fixtureRoot = resolve(args[++i]);
    else throw new Error(`Usage: node tools/verify-fixtures.mjs [--fixtures-dir <dir>] [--list] [--json]; unknown/incomplete option: ${arg}`);
  }
  discover(fixtureRoot);
  assert(files.size, "Empty fixture root: no JSON fixtures");
  planFixtures();
  for (const plan of plans) {
    if (list) checks.push({ file: plan.file, id: plan.id, status: "listed" });
    else {
      try { checks.push({ file: plan.file, id: plan.id, status: "passed", ...execute(plan) }); }
      catch (error) { fail(plan.file, plan.id, error); }
    }
  }
} catch (error) { fail(null, "discovery", error); }
finally { for (const path of outputRoots) rmSync(path, { recursive: true, force: true }); }
const fixtureFiles = [...files.keys()].map(label).sort(), coveredFiles = [...covered].map(label).sort();
const totals = { fixtureFiles: fixtureFiles.length, coveredFiles: coveredFiles.length, checks: checks.length,
  passed: checks.filter((c) => c.status === "passed").length, failed: checks.filter((c) => c.status === "failed").length, listed: checks.filter((c) => c.status === "listed").length };
const report = { format: "wmm.fixture-verification/1", mode: list ? "list" : "verify", fixtureFiles, coveredFiles, checks, totals };
if (json) process.stdout.write(`${canonicalJson(report)}\n`);
else {
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}${c.error ? `: ${c.error}` : ""}`);
  console.log(`${totals.coveredFiles}/${totals.fixtureFiles} fixture files covered; ${totals.passed} passed, ${totals.failed} failed, ${totals.listed} listed`);
}
process.exitCode = totals.failed ? 1 : 0;
