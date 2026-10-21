import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@wmm/canonical";
import { validateApiResponse, type ApiResponseV1, type JsonValue, type WorkspaceActionV1, type WorkspaceRequestV1, type WorkspaceViewV1 } from "@wmm/wire-contracts";

// These are process integration tests: use the existing build, never rebuild it here.
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const rootPath = fileURLToPath(new URL("../../../", import.meta.url));
const demoPath = join(rootPath, "fixtures/v3/succession-world");
const worldPath = join(rootPath, "fixtures/v1/complete-world");
const maxRequestBytes = 1024 * 1024;
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "wmm-workspace-command-"));
  directories.push(path);
  return path;
}

function invoke(
  args: readonly string[],
  options: { readonly input?: string | Uint8Array; readonly keepStdinOpen?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", TERM: "xterm-256color", ...options.env };
    delete env["FORCE_COLOR"];
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd: rootPath, env, stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      child.stdin.destroy();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error(
      `Workspace CLI exceeded 8 seconds: ${JSON.stringify(args)}; stderr: ${stderr.slice(-2000)}`,
    )), 8_000);
    const collect = (stream: "stdout" | "stderr", chunk: string): void => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { stop(new Error("Workspace CLI exceeded the test output limit")); return; }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect("stderr", chunk));
    child.on("error", (error) => { stop(error); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") stop(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      child.stdin.destroy();
      if (failure !== undefined) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
    if (options.keepStdinOpen) {
      if (options.input !== undefined) child.stdin.write(options.input);
    } else child.stdin.end(options.input);
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

function view(result: ProcessResult): WorkspaceViewV1 {
  const response = protocol(result);
  expect(response).toMatchObject({ outcome: "success", execution: "completed", diagnostics: [] });
  if (response.outcome !== "success" || !["workspace.create", "workspace.read", "workspace.mutate"].includes(response.operation)) {
    throw new Error(`Expected workspace success: ${result.stdout}`);
  }
  const data = response.data as WorkspaceViewV1;
  expect(data).toMatchObject({ format: "wmm.workspace-view/1", validation: { status: "not-run" }, approval: "unavailable", canon: "unchanged" });
  expect(response.resolved).toEqual(data.workspace.base);
  return data;
}

function readRequest(atVersion?: number, workspaceId = "main"): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `read-中立-${workspaceId}-${atVersion ?? "latest"}`,
    operation: "workspace.read", payload: { workspaceId, ...(atVersion === undefined ? {} : { atVersion }) },
  };
}

function machine(path: string, request: WorkspaceRequestV1): Promise<ProcessResult> {
  return invoke(["json", "--workspace-dir", path], { input: JSON.stringify(request) });
}

function correlated(result: ProcessResult, request: WorkspaceRequestV1, code = 0): ApiResponseV1 {
  const response = protocol(result, code);
  expect(response).toMatchObject({ requestId: request.requestId, operation: request.operation, apiVersion: request.apiVersion });
  return response;
}

function treeHashes(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) entries[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    }
  };
  visit("");
  return entries;
}

function expectPlain(result: ProcessResult): void {
  expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
  expect(result.stdout).not.toMatch(controls);
  expect(result.stdout).toContain("CANON READ-ONLY");
  for (const heading of ["CHANGES", "WORLD / READ-ONLY", "CONSTRAINTS", "SAVED WORKSPACE DECISIONS", "REVIEW / DRAFT CANDIDATE"]) {
    expect(result.stdout).toContain(heading);
  }
  expect(result.stdout).toContain("Validation: NOT RUN");
  expect(result.stdout).toContain("Approval: unavailable");
  expect(result.stdout).toContain("Canon: unchanged");
  expect(result.stdout).not.toMatch(/Ctrl\+|q: quit|Space: select|\[1 Changes\]|\u001b/u);
  expect(result.stdout.endsWith("\n")).toBe(true);
}

afterEach(() => {
  for (const child of children) { child.stdin.destroy(); child.kill("SIGKILL"); }
  children.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("built workspace CLI process boundary", () => {
  it("opens the valid 47-file demo and resumes the default main ID without reseeding", async () => {
    const path = directory();
    const before = treeHashes(demoPath);
    const snapshot = JSON.parse(readFileSync(join(demoPath, "snapshot.json"), "utf8"));
    expect(snapshot.manifest.files).toHaveLength(47);
    expect(Object.keys(treeHashes(join(demoPath, "payload")))).toHaveLength(47);
    const initial = view(await invoke(["workspace", "demo", "--workspace-dir", path, "--json"]));
    expect(initial.workspace).toMatchObject({ id: "main", mode: "succession-demo", version: 1, history: [], base: { snapshotDigest: snapshot.snapshotDigest } });
    expect(initial.workspace.proposals.map(({ id, decision }) => ({ id, decision }))).toEqual(
      ["death", "council", "coup", "intervention"].map((id) => ({ id, decision: "undecided" })),
    );
    expect(view(await invoke(["workspace", "resume", "--workspace-dir", path, "--json"]))).toEqual(initial);
    expect(view(await invoke(["workspace", "demo", "--workspace-dir", path, "--json"]))).toEqual(initial);
    expect(treeHashes(demoPath)).toEqual(before);
  }, 20_000);

  it.each([worldPath, demoPath])("opens %s as an arbitrary world with no seeded proposals or demo pins", async (source) => {
    const path = directory();
    const before = treeHashes(source);
    const opened = view(await invoke(["workspace", "open", source, "--workspace-dir", path, "--json"]));
    expect(opened.workspace).toMatchObject({ id: "main", mode: "world", version: 1, proposals: [], pins: [], history: [], direction: "" });
    expect(opened.selection.requested).toEqual([]);
    expect(opened.changes).toEqual([]);
    expect(opened.documents.length).toBeGreaterThan(0);
    expect(view(await machine(path, readRequest()))).toEqual(opened);
    expect(treeHashes(source)).toEqual(before);
  }, 20_000);

  it("honors explicit IDs and isolates the same default ID in separate storage directories", async () => {
    const first = directory();
    const second = directory();
    const custom = view(await invoke(["workspace", "demo", "--workspace-dir", first, "--id", "draft", "--json"]));
    expect(custom.workspace.id).toBe("draft");
    expect(view(await invoke(["workspace", "resume", "--workspace-dir", first, "--id", "draft", "--json"]))).toEqual(custom);
    expect(protocol(await invoke(["workspace", "resume", "--workspace-dir", first, "--json"]), 3)).toMatchObject({ error: { code: "WORKSPACE_NOT_FOUND" } });
    const a = view(await invoke(["workspace", "open", worldPath, "--workspace-dir", first, "--json"]));
    const b = view(await invoke(["workspace", "demo", "--workspace-dir", second, "--json"]));
    expect(a.workspace.mode).toBe("world");
    expect(b.workspace.mode).toBe("succession-demo");
    expect(view(await machine(first, readRequest()))).toEqual(a);
    expect(view(await machine(second, readRequest()))).toEqual(b);
  }, 20_000);

  it("keeps create/mutate/read correlation, exact historical reads and latest durable state across processes", async () => {
    const path = directory();
    const create: WorkspaceRequestV1 = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "machine-create-👑", operation: "workspace.create",
      payload: { workspaceId: "main", bundlePath: demoPath, title: "Process succession", goal: "Explicit authoring only", mode: "succession-demo", idempotencyKey: "create" },
    };
    const created = await machine(path, create);
    correlated(created, create);
    const versions = [view(created)];
    const reason = "Reject the coup.\nPreserve civilian continuity. 中立";
    const direction = "Prefer diplomacy.\nImported terminal controls: \u001b[31mred\u001b[0m\u0007";
    const actions: readonly WorkspaceActionV1[] = [
      { kind: "select", groupIds: ["council", "death"] },
      { kind: "decide", groupId: "coup", decision: "rejected", reason },
      { kind: "add-regency", title: "Negotiate a regency 👑", rationale: "Preserve the dynasty.\nNo inferred developments." },
      { kind: "select", groupIds: ["council", "death", "regency"] },
      { kind: "set-direction", text: direction },
    ];
    for (const [index, action] of actions.entries()) {
      const request: WorkspaceRequestV1 = {
        format: "wmm.request/1", apiVersion: "wmm/1", requestId: `machine-action-${index}`, operation: "workspace.mutate",
        payload: { workspaceId: "main", expectedVersion: index + 1, idempotencyKey: `action-${index}`, action },
      };
      const result = await machine(path, request);
      correlated(result, request);
      const next = view(result);
      expect(next.workspace.version).toBe(index + 2);
      versions.push(next);
    }
    const latest = versions.at(-1)!;
    expect(latest.workspace.history).toEqual(actions.map((action, index) => ({ version: index + 2, action })));
    expect(latest.workspace.direction).toBe(direction);
    expect(latest.workspace.proposals.find((group) => group.id === "coup")).toMatchObject({ decision: "rejected", rejectionReason: reason });
    expect(latest.selection.requested).toEqual(["council", "death", "regency"]);
    for (const expected of versions) {
      const request = readRequest(expected.workspace.version);
      const result = await machine(path, request);
      correlated(result, request);
      expect(view(result)).toEqual(expected);
    }
    const request = readRequest();
    const result = await machine(path, request);
    correlated(result, request);
    expect(view(result)).toEqual(latest);
    expect(view(await invoke(["workspace", "resume", "--workspace-dir", path, "--json"]))).toEqual(latest);
    expect(view(await invoke(["workspace", "demo", "--workspace-dir", path, "--json"]))).toEqual(latest);
    const plain = await invoke(["workspace", "resume", "--workspace-dir", path, "--plain"], { keepStdinOpen: true });
    expectPlain(plain);
    expect(plain.stdout).toContain("Preserve civilian continuity. 中立");
    expect(plain.stdout).toContain("Imported terminal controls:");
    expect(view(await machine(path, readRequest()))).toEqual(latest);
  }, 20_000);

  it("rejects stale mutations without losing machine correlation or changing the latest version", async () => {
    const path = directory();
    view(await invoke(["workspace", "demo", "--workspace-dir", path, "--json"]));
    const request: WorkspaceRequestV1 = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "decision-1", operation: "workspace.mutate",
      payload: { workspaceId: "main", expectedVersion: 1, idempotencyKey: "decision", action: { kind: "decide", groupId: "death", decision: "selected" } },
    };
    const saved = view(await machine(path, request));
    const replay = { ...request, requestId: "decision-retry" };
    const replayed = await machine(path, replay);
    correlated(replayed, replay);
    expect(view(replayed)).toEqual(saved);
    const stale = { ...request, requestId: "stale-decision", payload: { ...request.payload, idempotencyKey: "new-attempt" } };
    expect(correlated(await machine(path, stale), stale, 3)).toMatchObject({ outcome: "error", error: { code: "STALE_WORKSPACE" } });
    expect(view(await machine(path, readRequest()))).toEqual(saved);
  }, 20_000);

  it("accepts the direction contract bound and rejects the first character over it without saving", async () => {
    const path = directory();
    view(await invoke(["workspace", "open", worldPath, "--workspace-dir", path, "--json"]));
    const request: WorkspaceRequestV1 = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "direction-bound", operation: "workspace.mutate",
      payload: { workspaceId: "main", expectedVersion: 1, idempotencyKey: "bound", action: { kind: "set-direction", text: "x".repeat(16_000) } },
    };
    const saved = view(await machine(path, request));
    expect(saved.workspace.direction).toHaveLength(16_000);
    const excessive: WorkspaceRequestV1 = { ...request, requestId: "direction-over-bound", payload: {
      ...request.payload, expectedVersion: 2, idempotencyKey: "over-bound", action: { kind: "set-direction", text: "x".repeat(16_001) },
    } };
    expect(correlated(await machine(path, excessive), excessive, 2)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(view(await machine(path, readRequest()))).toEqual(saved);
  }, 20_000);

  it("accepts an exactly 1 MiB workspace request and rejects the extra byte while stdin stays open", async () => {
    const path = directory();
    const initial = view(await invoke(["workspace", "demo", "--workspace-dir", path, "--json"]));
    const request = readRequest();
    const exact = Buffer.alloc(maxRequestBytes, 0x20);
    exact.write(JSON.stringify(request), "utf8");
    const accepted = await invoke(["json", "--workspace-dir", path], { input: exact });
    correlated(accepted, request);
    expect(view(accepted)).toEqual(initial);
    const unopened = join(directory(), "must-not-open");
    const rejected = await invoke(["json", "--workspace-dir", unopened], { input: Buffer.alloc(maxRequestBytes + 1, 0x20), keepStdinOpen: true });
    expect(protocol(rejected, 2)).toMatchObject({ requestId: null, operation: null, error: { code: "INVALID_REQUEST", message: expect.stringContaining("transport limit") } });
    expect(existsSync(unopened)).toBe(false);
    expect(view(await machine(path, readRequest()))).toEqual(initial);
  }, 20_000);

  it.each([
    { label: "non-TTY", env: { TERM: "xterm-256color" } },
    { label: "TERM=dumb", env: { TERM: "dumb" } },
    { label: "NO_COLOR", env: { TERM: "xterm-256color", NO_COLOR: "1" } },
  ])("uses readable, escape-free $label output and exits without reading stdin", async ({ env }) => {
    const path = directory();
    const opened = await invoke(["workspace", "demo", "--workspace-dir", path], { env, keepStdinOpen: true });
    expectPlain(opened);
    expect(opened.stdout).toContain("Workspace id: main");
    expect(opened.stdout).toContain("Record King Edric's death");
    const resumed = await invoke(["workspace", "resume", "--workspace-dir", path], { env, keepStdinOpen: true });
    expectPlain(resumed);
    expect(resumed.stdout).toBe(opened.stdout);
    const explicit = await invoke(["workspace", "resume", "--workspace-dir", path, "--plain"], { env, keepStdinOpen: true });
    expect(explicit.stdout).toBe(opened.stdout);
  }, 20_000);

  it("guards identical, nested, ancestor and symlink-alias source/storage locations before writing", async () => {
    const root = directory();
    const source = join(root, "source");
    const alias = join(root, "source-alias");
    cpSync(demoPath, source, { recursive: true });
    symlinkSync(source, alias, "dir");
    const before = treeHashes(source);
    for (const target of [source, join(source, "draft"), root, alias, join(alias, "draft")]) {
      const result = await invoke(["workspace", "open", source, "--workspace-dir", target, "--json"]);
      expect(protocol(result, 2)).toMatchObject({ outcome: "error", error: { code: "INVALID_REQUEST", message: expect.stringContaining("separate directories") } });
      expect(treeHashes(source)).toEqual(before);
      expect(existsSync(join(target, "authoring.sqlite"))).toBe(false);
    }
    const request: WorkspaceRequestV1 = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "overlapping-machine-create", operation: "workspace.create",
      payload: { workspaceId: "main", bundlePath: source, title: "Unsafe overlap", goal: "Must not write", mode: "world", idempotencyKey: "overlap" },
    };
    expect(protocol(await machine(join(source, "machine-draft"), request), 4)).toMatchObject({ error: { code: "STORAGE_FAILURE", message: expect.stringContaining("separate directories") } });
    expect(treeHashes(source)).toEqual(before);
    expect(existsSync(join(source, "machine-draft"))).toBe(false);
  }, 20_000);

  it.each([
    ["workspace", "demo", "--json", "--unknown"],
    ["workspace", "resume", "--unknown", "--json"],
    ["workspace", "demo", "--plain", "--json"],
    ["json", "--unknown"],
  ])("returns one structured JSON argument error for %j without reading stdin", async (...args) => {
    const path = join(directory(), "unopened");
    const result = await invoke([...args, "--workspace-dir", path], { keepStdinOpen: true });
    expect(protocol(result, 2)).toMatchObject({ format: "wmm.response/1", requestId: null, operation: null, outcome: "error", error: { code: "INVALID_REQUEST" } });
    expect(existsSync(path)).toBe(false);
  }, 20_000);
});
