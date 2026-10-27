import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { executeApiRequest, WorkspaceApplication, type ApplicationServices } from "@wmm/application";
import { SqliteWorkspaceStore } from "@wmm/store-authoring-sqlite";
import type { ApiResponseV1, WorkspaceEconomyReadRequest, WorkspaceEconomyView, WorkspaceMapReadRequest, WorkspaceMapView, WorkspaceRequestV1, WorkspaceViewV1 } from "@wmm/wire-contracts";

import { serializeJsonTransportResult } from "./json-transport.js";
import { operationExitCode } from "@wmm/application";
import { renderAtlasPlain, renderWorkspacePlain, runWorkspaceEditor, type WorkspaceClient } from "./workspace/index.js";
import { renderWorkspaceEconomyPlain } from "./economy-format.js";
import { economyViewError } from "./workspace/economy-view.js";

function realLocation(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realLocation(parent), basename(absolute));
}
export function assertSeparateWorkspaceDirectory(directory: string, bundlePath: string): void {
  const target = realLocation(directory);
  const source = realLocation(bundlePath);
  if (source === target || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) {
    throw new Error("Workspace storage and the source world must be separate directories, neither containing the other");
  }
}
export function openWorkspaceRuntime(directory: string, create = true): { services: ApplicationServices; close(): void } {
  const target = resolve(directory);
  let ancestor = realLocation(target);
  for (;;) {
    if (existsSync(join(ancestor, "snapshot.json"))) throw new Error("Workspace storage cannot be inside a world bundle");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!create && !existsSync(join(target, "authoring.sqlite"))) throw new Error("No authoring database exists here; open a world or create the worked demo first");
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Workspace directory must not be a symlink");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const store = new SqliteWorkspaceStore(join(target, "authoring.sqlite"));
  return { services: { workspaces: new WorkspaceApplication(store) }, close: () => store.close() };
}

/** Parse executable/arguments without a shell: imported text can never become a command. */
function editorArguments(command: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote: string | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) { token += character; escaped = false; }
    else if (character === "\\" && quote !== "'") escaped = true;
    else if (quote !== undefined) { if (character === quote) quote = undefined; else token += character; }
    else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (token) args.push(token); token = ""; }
    else token += character;
  }
  if (quote !== undefined || escaped) throw new Error("VISUAL/EDITOR has an unmatched quote or escape");
  if (token) args.push(token);
  if (args.length === 0) throw new Error("VISUAL/EDITOR must identify an executable");
  return args;
}
export function editWorkspaceText(text: string): string {
  const [executable, ...args] = editorArguments(process.env["VISUAL"] || process.env["EDITOR"] || "vi");
  const directory = mkdtempSync(join(tmpdir(), "wmm-editor-"));
  const path = join(directory, "draft.md");
  try {
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(executable!, [...args, path], { stdio: "inherit", shell: false });
    if (result.error !== undefined || result.status !== 0) throw new Error("External editor did not complete successfully; original input is retained");
    if (statSync(path).size > 256 * 1024) throw new Error("Edited text exceeds the workspace input limit; original input is retained");
    const edited = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    if (!edited.isWellFormed()) throw new Error("External editor returned invalid Unicode");
    return edited;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

interface Options { directory: string; id: string; plain: boolean; json: boolean; atlasId?: string; geometryVersion?: string }
function parseOptions(args: readonly string[], map = false): Options {
  let directory: string | undefined;
  let id = "main";
  let plain = false;
  let json = false;
  let atlasId: string | undefined;
  let geometryVersion: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate workspace option: ${flag}`);
    seen.add(flag);
    if (flag === "--plain") plain = true;
    else if (flag === "--json") json = true;
    else if (flag === "--workspace-dir" || flag === "--id" || (map && (flag === "--atlas" || flag === "--geometry-version"))) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--workspace-dir") directory = value;
      else if (flag === "--atlas") atlasId = value;
      else if (flag === "--geometry-version") geometryVersion = value;
      else id = value;
    } else throw new Error(`Unknown workspace option: ${flag}`);
  }
  if (directory === undefined || !directory.trim()) throw new Error("Provide --workspace-dir <directory> for durable authoring storage");
  if (plain && json) throw new Error("Choose --plain or --json, not both");
  return { directory, id, plain, json, ...(atlasId === undefined ? {} : { atlasId }), ...(geometryVersion === undefined ? {} : { geometryVersion }) };
}
function unwrap(response: ApiResponseV1): WorkspaceViewV1 {
  if (response.outcome === "error") {
    const error = new Error(response.error.message) as Error & { code: string };
    error.code = response.error.code;
    throw error;
  }
  if (response.operation !== "workspace.create" && response.operation !== "workspace.read" && response.operation !== "workspace.review" && response.operation !== "workspace.mutate") throw new Error("Unexpected workspace operation");
  return response.data;
}

function unwrapMap(response: ApiResponseV1): WorkspaceMapView {
  if (response.outcome === "error") {
    const error = new Error(response.error.message) as Error & { code: string };
    error.code = response.error.code; throw error;
  }
  if (response.operation !== "workspace.map.read") throw new Error("Unexpected atlas operation");
  return response.data;
}

function unwrapEconomy(response: ApiResponseV1, workspace?: WorkspaceViewV1["workspace"]): WorkspaceEconomyView {
  if (response.outcome === "error") {
    const error = new Error(response.error.message) as Error & { code: string };
    error.code = response.error.code; throw error;
  }
  if (response.operation !== "workspace.economy.read") throw new Error("Unexpected Economy operation");
  const error = economyViewError(response.data, workspace);
  if (error) throw new Error(error);
  return response.data;
}

/** The actual CLI host capability boundary, shared by editor launch and integration tests. */
export function createWorkspaceClient(services: ApplicationServices, workspaceId: string): WorkspaceClient {
  const invoke = (request: WorkspaceRequestV1 | WorkspaceMapReadRequest | WorkspaceEconomyReadRequest): ApiResponseV1 => executeApiRequest(request, services);
  const envelope = { format: "wmm.request/1", apiVersion: "wmm/1" } as const;
  return {
    read: (atVersion) => unwrap(invoke({ ...envelope, requestId: randomUUID(), operation: "workspace.read", payload: { workspaceId, ...(atVersion === undefined ? {} : { atVersion }) } })),
    readMap: (selection = {}) => unwrapMap(invoke({ ...envelope, requestId: randomUUID(), operation: "workspace.map.read", payload: { ...selection, workspaceId } })),
    readEconomy: (selection = {}) => {
      const view = unwrapEconomy(invoke({ ...envelope, requestId: randomUUID(), operation: "workspace.economy.read", payload: { ...selection, workspaceId } }));
      if (view.workspaceId !== workspaceId || (selection.atVersion !== undefined && view.workspaceVersion !== selection.atVersion)) throw new Error("Economy requested workspace/version binding mismatch");
      return view;
    },
    mutate: (action, expectedVersion, idempotencyKey) => unwrap(invoke({ ...envelope, requestId: randomUUID(), operation: "workspace.mutate", payload: { workspaceId, expectedVersion, idempotencyKey, action } })),
    review: (expectedVersion) => unwrap(invoke({ ...envelope, requestId: randomUUID(), operation: "workspace.review", payload: { workspaceId, expectedVersion } })),
    editText: editWorkspaceText,
  };
}

export async function runWorkspaceCommand(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "open" && command !== "demo" && command !== "resume" && command !== "review" && command !== "map" && command !== "economy") throw new Error("Usage: wmm workspace open <bundle> | demo | resume | review | map | economy --workspace-dir <directory> [--id main] [--plain | --json]");
  const bundlePath = command === "open" ? rest[0] : command === "demo" ? fileURLToPath(new URL("../../../fixtures/v3/succession-world/", import.meta.url)) : undefined;
  const options = parseOptions(command === "open" ? rest.slice(1) : rest, command === "map");
  if (command === "open" && (bundlePath === undefined || bundlePath.startsWith("--"))) throw new Error("Provide a WMM bundle directory to open");
  if (bundlePath !== undefined) assertSeparateWorkspaceDirectory(options.directory, bundlePath);
  const runtime = openWorkspaceRuntime(options.directory, command === "open" || command === "demo");
  try {
    const invoke = (operation: WorkspaceRequestV1 | WorkspaceMapReadRequest | WorkspaceEconomyReadRequest): ApiResponseV1 => executeApiRequest(operation, runtime.services);
    const readRequest = (): WorkspaceRequestV1 => ({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: randomUUID(), operation: "workspace.read", payload: { workspaceId: options.id } });
    if (command === "economy") {
      const readResponse = invoke(readRequest());
      const workspace = readResponse.outcome === "success" ? unwrap(readResponse).workspace : undefined;
      const response = invoke({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: randomUUID(), operation: "workspace.economy.read", payload: { workspaceId: options.id, ...(workspace === undefined ? {} : { atVersion: workspace.version }) } });
      if (response.outcome === "success") {
        if (!workspace || workspace.id !== options.id) throw new Error("Economy requested workspace binding unavailable");
        unwrapEconomy(response, workspace);
      }
      if (options.json || response.outcome === "error") {
        const serialized = serializeJsonTransportResult({ response, exitCode: operationExitCode("workspace.economy.read", response) });
        process.stdout.write(serialized.output); process.exitCode = serialized.exitCode;
      } else {
        const view = unwrapEconomy(response, workspace);
        process.stdout.write(`${renderWorkspaceEconomyPlain(view)}\n`);
      }
      return;
    }
    if (command === "map") {
      const response = invoke({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: randomUUID(), operation: "workspace.map.read", payload: {
        workspaceId: options.id, ...(options.atlasId === undefined ? {} : { atlasId: options.atlasId }), ...(options.geometryVersion === undefined ? {} : { geometryVersion: options.geometryVersion }),
      } });
      if (options.json || response.outcome === "error") {
        const serialized = serializeJsonTransportResult({ response, exitCode: operationExitCode("workspace.map.read", response) });
        process.stdout.write(serialized.output); process.exitCode = serialized.exitCode;
      } else process.stdout.write(`${renderAtlasPlain(unwrapMap(response))}\n`);
      return;
    }
    let response = invoke(readRequest());
    if (command === "open" || (command === "demo" && response.outcome === "error" && response.error.code === "WORKSPACE_NOT_FOUND")) {
      response = invoke({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: randomUUID(), operation: "workspace.create", payload: {
        workspaceId: options.id, bundlePath: bundlePath!, title: command === "demo" ? "The succession crisis" : "Worldbuilding workspace",
        goal: command === "demo" ? "Review succession alternatives without changing canon." : "Inspect and author explicit changes against this fixed base.",
        mode: command === "demo" ? "succession-demo" : "world", idempotencyKey: `create:${options.id}`,
      } });
    }
    // The create operation correctly replays its original result; editors display the latest saved state.
    if (response.outcome === "success" && response.operation === "workspace.create") response = invoke(readRequest());
    if (response.outcome === "success" && command === "demo" && unwrap(response).workspace.mode !== "succession-demo") throw new Error("This workspace is not the succession demo; use resume or a separate workspace ID");
    if (command === "review" && response.outcome === "success") {
      response = invoke({ format: "wmm.request/1", apiVersion: "wmm/1", requestId: randomUUID(), operation: "workspace.review", payload: { workspaceId: options.id, expectedVersion: unwrap(response).workspace.version } });
    }
    if (options.json) {
      const serialized = serializeJsonTransportResult({ response, exitCode: operationExitCode(response.operation as WorkspaceRequestV1["operation"], response) });
      process.stdout.write(serialized.output); process.exitCode = serialized.exitCode; return;
    }
    const view = unwrap(response);
    if (command === "review" || options.plain || !process.stdin.isTTY || !process.stdout.isTTY || process.env["TERM"] === "dumb") {
      process.stdout.write(`${renderWorkspacePlain(view)}\n`); return;
    }
    const client = createWorkspaceClient(runtime.services, options.id);
    await runWorkspaceEditor(client, view);
  } finally { runtime.close(); }
}
