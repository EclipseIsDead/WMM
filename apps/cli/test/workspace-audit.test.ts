import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@wmm/canonical";
import { validateApiResponse, type ApiResponseV1, type JsonValue, type WorkspaceActionV1, type WorkspaceRequestV1, type WorkspaceViewV1 } from "@wmm/wire-contracts";
import { openWorkspaceRuntime } from "../src/workspace-command.js";

// Process regressions require the parent's fresh build; this suite never rebuilds shared artifacts.
const rootPath = fileURLToPath(new URL("../../../", import.meta.url));
const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixturePath = join(rootPath, "fixtures/v3/succession-world");
const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "wmm-workspace-audit-"));
  directories.push(path);
  return path;
}

function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) entries[path] = `symlink:${readlinkSync(join(root, path))}`;
      else if (entry.isDirectory()) { entries[path] = "directory"; visit(path); }
      else if (entry.isFile()) entries[path] = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
      else throw new Error(`Unexpected filesystem entry: ${path}`);
    }
  };
  visit("");
  return entries;
}

function invoke(args: readonly string[], request?: WorkspaceRequestV1) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", TERM: "dumb" };
  delete env["FORCE_COLOR"];
  const result = spawnSync(process.execPath, [mainPath, ...args], {
    cwd: rootPath, env, shell: false, encoding: "utf8", timeout: 8_000, maxBuffer: 4 * 1024 * 1024,
    input: request === undefined ? "" : JSON.stringify(request),
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function protocol(result: ReturnType<typeof invoke>, exitCode = 0): ApiResponseV1 {
  expect(result.status, result.stderr || result.stdout).toBe(exitCode);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n")).toHaveLength(2);
  const response: unknown = JSON.parse(result.stdout);
  expect(validateApiResponse(response)).toEqual({ valid: true, errors: [] });
  expect(result.stdout).toBe(`${canonicalJson(response as JsonValue)}\n`);
  return response as ApiResponseV1;
}

function machine(path: string, request: WorkspaceRequestV1, exitCode = 0): ApiResponseV1 {
  const response = protocol(invoke(["json", "--workspace-dir", path], request), exitCode);
  expect(response).toMatchObject({ requestId: request.requestId, operation: request.operation, apiVersion: request.apiVersion });
  return response;
}

function view(response: ApiResponseV1): WorkspaceViewV1 {
  expect(response).toMatchObject({ outcome: "success", execution: "completed" });
  if (response.outcome !== "success" || (
    response.operation !== "workspace.create" && response.operation !== "workspace.read" && response.operation !== "workspace.mutate"
  )) throw new Error(`Expected a workspace result: ${JSON.stringify(response)}`);
  expect(response.resolved).toEqual(response.data.workspace.base);
  expect(response.data).toMatchObject({ validation: { status: "not-run" }, approval: "unavailable", canon: "unchanged" });
  return response.data;
}

function readRequest(requestId: string, atVersion?: number): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId, operation: "workspace.read",
    payload: { workspaceId: "main", ...(atVersion === undefined ? {} : { atVersion }) },
  };
}

function mutation(current: WorkspaceViewV1, action: WorkspaceActionV1, key: string): WorkspaceRequestV1 {
  return {
    format: "wmm.request/1", apiVersion: "wmm/1", requestId: `audit-${key}`, operation: "workspace.mutate",
    payload: { workspaceId: current.workspace.id, expectedVersion: current.workspace.version, idempotencyKey: key, action },
  };
}

function unopenedStorage(root: string, layout: "missing" | "empty"): string {
  const path = layout === "missing" ? join(root, "not-created", "authoring") : join(root, "empty-authoring");
  if (layout === "empty") mkdirSync(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace audit: storage guards and process presentation", () => {
  it.each([
    ["bundle root", "", false],
    ["existing descendant", "payload/prose", false],
    ["missing descendant", "payload/prose/not-created/deep", false],
    ["existing symlink ancestor", "prose", true],
    ["missing symlink ancestor", "prose/not-created/deep", true],
  ] as const)("rejects %s in runtime, resume and JSON read without filesystem effects", (_label, relative, aliased) => {
    const root = directory();
    const source = join(root, "source");
    const alias = join(root, "payload-alias");
    cpSync(fixturePath, source, { recursive: true });
    symlinkSync(join(source, "payload"), alias, "dir");
    const target = join(aliased ? alias : source, relative);
    const before = tree(root);

    for (const create of [true, false]) {
      expect(() => {
        const runtime = openWorkspaceRuntime(target, create);
        runtime.close();
      }).toThrow(/inside a world bundle/);
      expect(tree(root)).toEqual(before);
    }

    const resumed = invoke(["workspace", "resume", "--workspace-dir", target, "--plain"]);
    expect(resumed.status).toBe(1);
    expect(resumed.stdout).toBe("");
    expect(resumed.stderr).toMatch(/inside a world bundle/);
    expect(tree(root)).toEqual(before);

    expect(machine(target, readRequest("audit-world-guard-中立"), 4)).toMatchObject({
      outcome: "error", error: { code: "STORAGE_FAILURE", message: expect.stringMatching(/inside a world bundle/) },
    });
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(target, "authoring.sqlite"))).toBe(false);
  }, 20_000);

  it.each(["missing", "empty"] as const)("does not initialize %s storage through runtime read-only mode or resume", (layout) => {
    const root = directory();
    const target = unopenedStorage(root, layout);
    const before = tree(root);
    expect(() => {
      const runtime = openWorkspaceRuntime(target, false);
      runtime.close();
    }).toThrow(/No authoring database exists/);
    expect(tree(root)).toEqual(before);

    const resumed = invoke(["workspace", "resume", "--workspace-dir", target, "--plain"]);
    expect(resumed.status).toBe(1);
    expect(resumed.stdout).toBe("");
    expect(resumed.stderr).toMatch(/No authoring database exists/);
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(target, "authoring.sqlite"))).toBe(false);
  }, 15_000);

  it.each([
    ["missing", "workspace.read"], ["empty", "workspace.read"],
    ["missing", "workspace.mutate"], ["empty", "workspace.mutate"],
  ] as const)("keeps correlation and leaves %s storage untouched for JSON %s", (layout, operation) => {
    const root = directory();
    const target = unopenedStorage(root, layout);
    const before = tree(root);
    const requestId = `audit-${operation}-${layout}-中立`;
    const request: WorkspaceRequestV1 = operation === "workspace.read" ? readRequest(requestId) : {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId, operation,
      payload: { workspaceId: "main", expectedVersion: 1, idempotencyKey: "must-not-write", action: { kind: "set-direction", text: "Must not initialize storage" } },
    };
    const response = machine(target, request, 4);
    expect(response).toMatchObject({
      outcome: "error", execution: "completed", diagnostics: [],
      error: { code: "STORAGE_FAILURE", message: expect.stringMatching(/No authoring database exists/) },
    });
    expect(response).not.toHaveProperty("data");
    expect(response).not.toHaveProperty("resolved");
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(target, "authoring.sqlite"))).toBe(false);
  }, 15_000);

  it("preserves JSON create correlation when source/storage separation rejects the host configuration", () => {
    const root = directory();
    const source = join(root, "source");
    cpSync(fixturePath, source, { recursive: true });
    const before = tree(root);
    const request: WorkspaceRequestV1 = {
      format: "wmm.request/1", apiVersion: "wmm/1", requestId: "audit-overlapping-create-👑", operation: "workspace.create",
      payload: { workspaceId: "main", bundlePath: source, title: "No writes", goal: "Reject overlap", mode: "world", idempotencyKey: "overlap" },
    };
    expect(machine(join(source, "payload/prose/not-created"), request, 4)).toMatchObject({
      outcome: "error", error: { code: "STORAGE_FAILURE", message: expect.stringMatching(/separate directories/) },
    });
    expect(tree(root)).toEqual(before);
  }, 15_000);

  it("displays latest decisions on repeated open while preserving the original historical version", () => {
    const root = directory();
    const source = join(root, "source");
    const storage = join(root, "authoring");
    cpSync(fixturePath, source, { recursive: true });
    const before = tree(source);
    const open = ["workspace", "open", source, "--workspace-dir", storage];
    const initial = view(protocol(invoke([...open, "--json"])));
    expect(initial.workspace.version).toBe(1);
    const actions: readonly WorkspaceActionV1[] = [
      { kind: "put-proposal", proposal: {
        id: "reviewed", title: "An explicit alternative", author: "Human", rationale: "Retain this review after reopening",
        dependencies: [], exclusions: [], operations: [{ kind: "write-prose", path: "prose/audit.md", text: "Draft prose, not canon", beforeSha256: null }],
      } },
      { kind: "decide", groupId: "reviewed", decision: "rejected", reason: "Preserve the existing council" },
      { kind: "set-direction", text: "Prefer diplomacy after reopening" },
    ];
    let latest = initial;
    for (const [index, action] of actions.entries()) latest = view(machine(storage, mutation(latest, action, `decision-${index}`)));
    expect(latest.workspace.version).toBe(4);
    expect(latest.workspace.proposals[0]).toMatchObject({ decision: "rejected", rejectionReason: "Preserve the existing council" });

    expect(view(protocol(invoke([...open, "--json"])))).toEqual(latest);
    const plain = invoke([...open, "--plain"]);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toContain("Saved workspace v4");
    expect(plain.stdout).toContain("Preserve the existing council");
    expect(plain.stdout).toContain("Prefer diplomacy after reopening");
    expect(view(machine(storage, readRequest("audit-original-version", 1)))).toEqual(initial);
    expect(view(machine(storage, readRequest("audit-latest-version")))).toEqual(latest);
    expect(tree(source)).toEqual(before);
  }, 30_000);
});
