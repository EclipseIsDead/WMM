import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";
import { canonicalJson } from "@wmm/canonical";
import type { JsonValue } from "@wmm/wire-contracts";

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
function invoke(args: string[] = [], cwd = root): { code: number | null; stdout: string; stderr: string; report: Report } {
  const result = spawnSync(process.execPath, [script, "--json", ...args], {
    cwd, shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout, "verifier must emit a JSON report").not.toBe("");
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, report: JSON.parse(result.stdout) as Report };
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("provides the executable all-fixtures verifier", () => {
  expect(existsSync(script), "tools/verify-fixtures.mjs must exist").toBe(true);
});

it("lists every recursively discovered JSON and its coverage without running checks", () => {
  const { code, report, stderr } = invoke(["--list"], directory());
  const files = jsonFiles(join(root, "fixtures"));
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(report.fixtureFiles).toEqual(files);
  expect(report.coveredFiles).toEqual(files);
  expect(report.checks.map((check) => check.id)).toContain("contract-kit");
  expect(report.checks.map((check) => check.id)).toContain("seed");
  expect(report.checks.every((check) => check.status === "listed")).toBe(true);
  expect(report.totals).toEqual({ fixtureFiles: files.length, coveredFiles: files.length,
    checks: report.checks.length, passed: 0, failed: 0, listed: report.checks.length });
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

it.each(["unknown format", "null JSON", "invalid JSON", "empty claims", "empty absence", "empty interval", "empty API", "empty V0"])("rejects %s without silently skipping coverage", (kind) => {
  const path = directory();
  if (kind === "invalid JSON") writeFileSync(join(path, "bad.json"), "{");
  else if (kind === "null JSON") fixture(path, "bad.json", null);
  else if (kind === "unknown format") fixture(path, "bad.json", { format: "wmm.unknown/1" });
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
  expect(report.totals).toEqual({ fixtureFiles: inventory.fixtureFiles.length, coveredFiles: inventory.fixtureFiles.length,
    checks: report.checks.length, passed: report.checks.length, failed: 0, listed: 0 });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "v2/interval-query-cases.json#requests/3", exitCode: 4, status: "passed" }));
  expect(sources.map((file) => readFileSync(file))).toEqual(original);
}, 120_000);
