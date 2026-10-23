import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, workspaceCandidateDigest, workspaceReviewDigest } from "@wmm/canonical";
import {
  validateApiRequest, validateApiResponse, validateWorkspaceReviewReceipt,
  type ApiRequestV1, type ApiResponseV1, type JsonValue, type WorkspaceActionV1,
  type WorkspaceRequestV1, type WorkspaceReviewLimitsV1, type WorkspaceViewV1,
} from "@wmm/wire-contracts";
import { openWorkspaceRuntime, runWorkspaceCommand } from "../src/workspace-command.js";
import * as workspaceEditor from "../src/workspace/index.js";
import { WorkspaceController } from "../src/workspace/controller.js";
import { renderWorkspacePlain, renderWorkspaceScreen } from "../src/workspace/presentation.js";

// Process tests consume the parent's existing build; never rebuild shared dist here.
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const rootPath = fileURLToPath(new URL("../../../", import.meta.url));
const demoPath = join(rootPath, "fixtures/v3/succession-world");
const worldPath = join(rootPath, "fixtures/v1/complete-world");
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let sourceBefore: readonly Record<string, string>[];

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "wmm-workspace-review-command-"));
  directories.push(path);
  return path;
}
function tree(root: string, relative = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) entries[path] = `symlink:${readlinkSync(join(root, path))}`;
    else if (entry.isDirectory()) { entries[path] = "directory"; Object.assign(entries, tree(root, path)); }
    else if (entry.isFile()) entries[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    else throw new Error(`Unexpected filesystem entry: ${path}`);
  }
  return entries;
}
function invoke(
  args: readonly string[],
  options: { readonly input?: string; readonly keepStdinOpen?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", TERM: "xterm-256color", ...options.env };
    delete env["FORCE_COLOR"];
    const child = spawn(process.execPath, [mainPath, ...args], { cwd: rootPath, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => { failure ??= error; child.stdin.destroy(); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error(`Review CLI exceeded 8 seconds: ${JSON.stringify(args)}; ${stderr.slice(-2000)}`)), 8_000);
    const collect = (stream: "stdout" | "stderr", chunk: string): void => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { stop(new Error("Review CLI exceeded the test output limit")); return; }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect("stderr", chunk));
    child.on("error", stop);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "ECONNRESET") stop(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      child.stdin.destroy();
      if (failure !== undefined) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
    if (options.keepStdinOpen) { if (options.input !== undefined) child.stdin.write(options.input); }
    else child.stdin.end(options.input);
  });
}
function protocol(result: ProcessResult, code = 0): ApiResponseV1 {
  expect(result.signal).toBeNull();
  expect(result.code, result.stderr || result.stdout).toBe(code);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(controls);
  expect(result.stdout.split("\n")).toHaveLength(2);
  const response: unknown = JSON.parse(result.stdout);
  expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  expect(result.stdout).toBe(`${canonicalJson(response as JsonValue)}\n`);
  return response as ApiResponseV1;
}
function correlated(result: ProcessResult, request: Pick<ApiRequestV1, "requestId" | "operation" | "apiVersion">, code = 0): ApiResponseV1 {
  const response = protocol(result, code);
  expect(response).toMatchObject({ requestId: request.requestId, operation: request.operation, apiVersion: request.apiVersion });
  return response;
}
async function machine(path: string, request: ApiRequestV1, code = 0): Promise<ApiResponseV1> {
  expect(validateApiRequest(request)).toEqual({ valid: true, errors: [] });
  return correlated(await invoke(["json", "--workspace-dir", path], { input: JSON.stringify(request) }), request, code);
}
function view(response: ApiResponseV1): WorkspaceViewV1 {
  expect(response).toMatchObject({ outcome: "success", execution: "completed", diagnostics: [] });
  if (response.outcome !== "success" || !(
    response.operation === "workspace.create" || response.operation === "workspace.read" ||
    response.operation === "workspace.mutate" || response.operation === "workspace.review"
  )) throw new Error(`Expected workspace success: ${JSON.stringify(response)}`);
  expect(response.resolved).toEqual(response.data.workspace.base);
  expect(response.data).toMatchObject({ format: "wmm.workspace-view/1", approval: "unavailable", canon: "unchanged" });
  return response.data;
}
function readRequest(workspaceId = "main", atVersion?: number): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `read-review-${workspaceId}-${atVersion ?? "latest"}`, operation: "workspace.read",
    payload: { workspaceId, ...(atVersion === undefined ? {} : { atVersion }) },
  };
}
function mutation(current: WorkspaceViewV1, action: WorkspaceActionV1): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `review-mutate-${current.workspace.version}`, operation: "workspace.mutate",
    payload: { workspaceId: current.workspace.id, expectedVersion: current.workspace.version, idempotencyKey: `mutation-${current.workspace.version}`, action },
  };
}
function reviewRequest(current: WorkspaceViewV1, limits?: Partial<WorkspaceReviewLimitsV1>): Extract<WorkspaceRequestV1, { operation: "workspace.review" }> {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: "review-correlated-中立-👑", operation: "workspace.review",
    payload: { workspaceId: current.workspace.id, expectedVersion: current.workspace.version, ...(limits === undefined ? {} : { limits }) },
  };
}
async function create(path: string, workspaceId = "main"): Promise<WorkspaceViewV1> {
  return view(await machine(path, {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: "review-machine-create", operation: "workspace.create",
    payload: { workspaceId, bundlePath: demoPath, title: "Succession review", goal: "Review explicit alternatives without changing canon.", mode: "succession-demo", idempotencyKey: "create" },
  }));
}
async function ready(path: string, workspaceId = "main"): Promise<WorkspaceViewV1> {
  let current = await create(path, workspaceId);
  const actions: readonly WorkspaceActionV1[] = [
    { kind: "select", groupIds: ["death", "council"] },
    { kind: "add-regency", title: "Negotiate a regency", rationale: "Keep the dynasty through diplomacy." },
    { kind: "select", groupIds: ["death", "council", "regency"] },
  ];
  for (const action of actions) current = view(await machine(path, mutation(current, action)));
  return current;
}
function currentReceipt(current: WorkspaceViewV1): void {
  expect(current.validation.status).toBe("current");
  if (current.review === undefined) throw new Error("Review did not return a receipt");
  expect(validateWorkspaceReviewReceipt(current.review)).toEqual({ valid: true, errors: [] });
  expect(current.review.binding.workspaceVersion).toBe(current.workspace.version);
  expect(current.review.candidateDigest).toBe(workspaceCandidateDigest(current.review.binding));
  const { evaluationDigest, ...body } = current.review;
  expect(evaluationDigest).toBe(workspaceReviewDigest(body));
}

beforeEach(() => { sourceBefore = [tree(demoPath), tree(worldPath)]; });
afterEach(() => {
  try {
    expect(tree(demoPath)).toEqual(sourceBefore[0]);
    expect(tree(worldPath)).toEqual(sourceBefore[1]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const child of children) { child.stdin.destroy(); child.kill("SIGKILL"); }
    children.clear();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  }
});

describe("built workspace review command", () => {
  it("reads the current version internally, returns a three-document JSON review and recovers exact old receipts across processes", async () => {
    const path = directory();
    const current = await ready(path, "succession-review");
    expect(current.workspace.version).toBe(4);
    expect(current.validation.status).toBe("not-run");
    const response = protocol(await invoke(["workspace", "review", "--workspace-dir", path, "--id", "succession-review", "--json"], { keepStdinOpen: true }));
    expect(response.operation).toBe("workspace.review");
    expect(response.requestId).toEqual(expect.any(String));
    const reviewed = view(response);
    currentReceipt(reviewed);
    expect(reviewed.review).toMatchObject({ execution: "completed", validity: "valid", limits: { maxWorkUnits: 2_000_000 } });
    expect(reviewed.review!.diff.documents.map(document => document.path)).toEqual([
      "prose/developments/council.md", "prose/developments/death.md", "prose/developments/regency.md",
    ]);
    expect(reviewed.review!.diff.assertions).toEqual([]);
    expect(reviewed.workspace).toEqual(current.workspace);
    expect(reviewed.documents).toEqual(current.documents);
    expect(view(await machine(path, readRequest("succession-review")))).toEqual(reviewed);
    const request = mutation(reviewed, { kind: "set-direction", text: "A later advisory direction." });
    const stale = view(await machine(path, request));
    expect(stale).toMatchObject({ validation: { status: "stale" }, review: reviewed.review });
    const latest = view(protocol(await invoke(["workspace", "review", "--workspace-dir", path, "--id", "succession-review", "--json"])));
    currentReceipt(latest);
    expect(latest.workspace).toEqual(stale.workspace);
    expect(latest.review!.binding.steeringDigest).not.toBe(reviewed.review!.binding.steeringDigest);
    expect(view(await machine(path, readRequest("succession-review", 4)))).toEqual(reviewed);
    expect(view(await machine(path, readRequest("succession-review")))).toEqual(latest);
    expect(view(await machine(path, { ...request, requestId: "replay-old-r1-association" }))).toEqual(stale);
    expect(await machine(path, readRequest("succession-review", 6), 3)).toMatchObject({ outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });
  }, 20_000);

  it.each([
    { label: "explicit --plain", flags: ["--plain"], env: { TERM: "xterm-256color" } },
    { label: "non-TTY fallback", flags: [], env: { TERM: "xterm-256color", NO_COLOR: "1" } },
    { label: "TERM=dumb", flags: [], env: { TERM: "dumb" } },
  ])("prints a bounded, terminal-safe completed review with $label and never waits for stdin", async ({ flags, env }) => {
    const path = directory();
    const current = await ready(path);
    const result = await invoke(["workspace", "review", "--workspace-dir", path, ...flags], { keepStdinOpen: true, env });
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toMatch(controls);
    expect(result.stdout).not.toMatch(/Ctrl\+|q: quit|\[1 Changes\]/u);
    expect(result.stdout.endsWith("\n")).toBe(true);
    for (const text of ["CANON READ-ONLY", "REVIEW / DRAFT CANDIDATE", "Validation: CURRENT v4", "Execution: completed", "Validity: valid", "Valid for bounded checks", "Approval: unavailable", "Canon: unchanged"]) expect(result.stdout).toContain(text);
    for (const path of ["prose/developments/council.md", "prose/developments/death.md", "prose/developments/regency.md"]) expect(result.stdout).toContain(`ADDED: ${path}`);
    const saved = view(await machine(path, readRequest()));
    currentReceipt(saved);
    expect(saved.workspace).toEqual(current.workspace);
  }, 20_000);

  it("prints completed invalid checks without presenting them as execution failure, approval or commit", async () => {
    const path = directory();
    const initial = await create(path);
    const current = view(await machine(path, mutation(initial, { kind: "select", groupIds: ["council"] })));
    const result = await invoke(["workspace", "review", "--workspace-dir", path, "--plain"]);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    for (const text of ["Validation: CURRENT v2", "Execution: completed", "Validity: invalid", "MISSING_PREREQUISITE", "Approval: unavailable", "Canon: unchanged"]) expect(result.stdout).toContain(text);
    expect(result.stdout).not.toMatch(/Validity: valid\b|Approval: approved|Canon: changed/);
    const saved = view(await machine(path, readRequest()));
    currentReceipt(saved);
    expect(saved.review!.validity).toBe("invalid");
    expect(saved.workspace).toEqual(current.workspace);
  }, 15_000);

  it.each(["missing", "empty"] as const)("does not initialize %s authoring storage through review, in either output mode or JSON API", async (layout) => {
    const root = directory();
    const path = join(root, layout === "missing" ? "not-created/authoring" : "empty-authoring");
    if (layout === "empty") mkdirSync(path);
    const before = tree(root);
    const plain = await invoke(["workspace", "review", "--workspace-dir", path, "--plain"], { keepStdinOpen: true });
    expect(plain).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(plain.stderr).toMatch(/No authoring database exists/);
    const json = protocol(await invoke(["workspace", "review", "--workspace-dir", path, "--json"], { keepStdinOpen: true }), 2);
    expect(json).toMatchObject({ requestId: null, operation: null, outcome: "error", error: { code: "INVALID_REQUEST", message: expect.stringMatching(/No authoring database exists/) } });
    const request: WorkspaceRequestV1 = { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "missing-review-中立", operation: "workspace.review", payload: { workspaceId: "main", expectedVersion: 1 } };
    expect(await machine(path, request, 4)).toMatchObject({ outcome: "error", error: { code: "STORAGE_FAILURE", message: expect.stringMatching(/No authoring database exists/) } });
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(path, "authoring.sqlite"))).toBe(false);
  }, 15_000);

  it.each([
    ["bundle root", "", false],
    ["existing descendant", "payload/prose", false],
    ["missing descendant", "payload/prose/not-created/deep", false],
    ["symlink ancestor", "prose/not-created/deep", true],
  ] as const)("rejects source overlap at %s before any database or directory creation", async (_label, relative, aliased) => {
    const root = directory();
    const source = join(root, "source");
    const alias = join(root, "payload-alias");
    cpSync(demoPath, source, { recursive: true });
    symlinkSync(join(source, "payload"), alias, "dir");
    const target = join(aliased ? alias : source, relative);
    const before = tree(root);
    const result = await invoke(["workspace", "review", "--workspace-dir", target, "--plain"]);
    expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
    expect(result.stderr).toMatch(/inside a world bundle/);
    const request: WorkspaceRequestV1 = { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "overlap-review-👑", operation: "workspace.review", payload: { workspaceId: "main", expectedVersion: 1 } };
    expect(await machine(target, request, 4)).toMatchObject({ outcome: "error", error: { code: "STORAGE_FAILURE", message: expect.stringMatching(/inside a world bundle/) } });
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(target, "authoring.sqlite"))).toBe(false);
  }, 15_000);

  it("preserves review error correlation and incomplete budget semantics without saving a receipt or advancing history", async () => {
    const path = directory();
    const current = await ready(path);
    const request = reviewRequest(current);
    const stale = { ...request, requestId: "stale-review-中立", payload: { ...request.payload, expectedVersion: 1 } };
    const budget = reviewRequest(current, { maxWorkUnits: 1 });
    const missing = { ...request, requestId: "missing-workspace-review", payload: { ...request.payload, workspaceId: "absent" } };
    for (const [input, code, exitCode, execution] of [
      [stale, "STALE_WORKSPACE", 3, "completed"],
      [budget, "BUDGET_EXCEEDED", 4, "incomplete"],
      [missing, "WORKSPACE_NOT_FOUND", 3, "completed"],
    ] as const) {
      const response = await machine(path, input, exitCode);
      expect(response).toMatchObject({ outcome: "error", execution, diagnostics: [], error: { code } });
      expect(response).not.toHaveProperty("data");
      expect(response).not.toHaveProperty("resolved");
    }
    const principal = { ...request, payload: { ...request.payload, principal: { role: "admin" } } };
    expect(validateApiRequest(principal).valid).toBe(false);
    expect(correlated(await invoke(["json", "--workspace-dir", path], { input: JSON.stringify(principal) }), principal, 2)).toMatchObject({ outcome: "error", error: { code: "INVALID_REQUEST" } });
    expect(view(await machine(path, readRequest()))).toEqual(current);
    expect(await machine(path, readRequest("main", current.workspace.version + 1), 3)).toMatchObject({ outcome: "error", error: { code: "WORKSPACE_NOT_FOUND" } });
  }, 20_000);

  it("leaves the old read-only JSON operations byte-for-byte unchanged and does not require or initialize authoring storage", async () => {
    const root = directory();
    const path = join(root, "authoring");
    const unused = join(root, "must-not-be-created");
    const requests: readonly ApiRequestV1[] = [
      { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "old-validate", operation: "world.validate", payload: { bundlePath: worldPath } },
      { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "old-inspect", operation: "record.inspect", payload: { bundlePath: worldPath, recordId: "person:alys" } },
      { format: "wmm.request/1", apiVersion: "wmm/1", requestId: "old-export", operation: "world.export", payload: { bundlePath: worldPath } },
    ];
    const before: string[] = [];
    for (const request of requests) {
      const result = await invoke(["json"], { input: JSON.stringify(request) });
      expect(correlated(result, request)).toMatchObject({ outcome: "success", execution: "completed" });
      before.push(result.stdout);
    }
    const current = await ready(path);
    currentReceipt(view(await machine(path, reviewRequest(current))));
    for (const [index, request] of requests.entries()) {
      const result = await invoke(["json", "--workspace-dir", unused], { input: JSON.stringify(request) });
      correlated(result, request);
      expect(result.stdout).toBe(before[index]);
    }
    expect(existsSync(unused)).toBe(false);
  }, 20_000);
});

describe("workspace review host gateway wiring", () => {
  it("supplies the real review route to Review-tab c without navigation checks, approval authority, source writes or semantic advancement", async () => {
    const path = directory();
    const current = await ready(path);
    const inputTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("TERM", "xterm-256color");
    let reviewed: WorkspaceViewV1 | undefined;
    const editor = vi.spyOn(workspaceEditor, "runWorkspaceEditor").mockImplementation(async (client, initial) => {
      expect(initial).toEqual(current);
      expect(typeof client.review).toBe("function");
      const review = vi.spyOn(client, "review");
      const read = vi.spyOn(client, "read");
      const mutate = vi.spyOn(client, "mutate");
      const controller = new WorkspaceController(client, initial);
      controller.input("c");
      controller.input("v");
      controller.input("5");
      expect(review).not.toHaveBeenCalled();
      expect(controller.getSnapshot().view.validation.status).toBe("not-run");
      controller.input("c");
      expect(review.mock.calls).toEqual([[current.workspace.version]]);
      expect(read).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      reviewed = controller.getSnapshot().view;
      currentReceipt(reviewed);
      expect(reviewed.workspace).toEqual(current.workspace);
      expect(controller.getSnapshot().status).toContain("Review execution completed");
      expect(renderWorkspaceScreen(controller.getSnapshot(), 100, 30)).toContain("Approval: unavailable");
      expect(renderWorkspacePlain(reviewed)).toContain("Canon: unchanged");
      controller.input("approve"); controller.input("commit"); controller.input("y");
      expect(review).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
    });
    try {
      await runWorkspaceCommand(["resume", "--workspace-dir", path]);
      expect(editor).toHaveBeenCalledTimes(1);
    } finally {
      if (inputTty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", inputTty);
      if (outputTty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", outputTty);
    }
    expect(reviewed).toBeDefined();
    const runtime = openWorkspaceRuntime(path, false);
    try {
      const saved = runtime.services.workspaces!.execute(readRequest());
      expect(saved).toEqual(reviewed);
      expect(saved.workspace).toEqual(current.workspace);
    } finally { runtime.close(); }
    expect(view(await machine(path, readRequest()))).toEqual(reviewed);
  }, 20_000);
});
