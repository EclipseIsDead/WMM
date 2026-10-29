import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { MAX_REQUEST_BYTES, parseStrictJson, readJsonInput } from "./json-input.js";

export const HARNESS_INPUT_LIMITS = Object.freeze({
  maxRequestBytes: MAX_REQUEST_BYTES, maxProjectBytes: 256 * 1024, maxTaskBytes: 8 * 1024,
  maxSources: 16, maxSourceBytes: 64 * 1024, maxTotalSourceBytes: 256 * 1024,
});

interface SelectedSource { readonly id: string; readonly title: string; readonly path: string }
interface HarnessRequest {
  readonly format: "wmm.dm-harness-request/1";
  readonly mode: "dm-import";
  readonly projectPath: string;
  readonly sourceRoot: string;
  readonly task: string;
  readonly sources: readonly SelectedSource[];
}
export interface CapturedDmHarnessInput {
  readonly format: "wmm.dm-harness-input/1";
  readonly mode: "dm-import";
  readonly task: string;
  readonly project: unknown;
  readonly sources: readonly (SelectedSource & { readonly text: string })[];
}

export class HarnessInputError extends Error {
  readonly code = "HARNESS_INPUT_ERROR";
  constructor(message = "Invalid DM harness request or selected input") {
    super(message);
    this.name = "HarnessInputError";
  }
}

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HarnessInputError();
  }
  return value as Record<string, unknown>;
}

function admitRequest(value: unknown): HarnessRequest {
  const request = closedObject(value, ["format", "mode", "projectPath", "sourceRoot", "task", "sources"]);
  if (request["format"] !== "wmm.dm-harness-request/1" || request["mode"] !== "dm-import" ||
    typeof request["task"] !== "string" || !request["task"].trim() || Buffer.byteLength(request["task"]) > HARNESS_INPUT_LIMITS.maxTaskBytes ||
    typeof request["projectPath"] !== "string" || !request["projectPath"].trim() ||
    typeof request["sourceRoot"] !== "string" || !request["sourceRoot"].trim() || !Array.isArray(request["sources"])) {
    throw new HarnessInputError();
  }
  if (request["sources"].length > HARNESS_INPUT_LIMITS.maxSources) throw new HarnessInputError();
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const value of request["sources"]) {
    const source = closedObject(value, ["id", "title", "path"]);
    if (typeof source["id"] !== "string" || !/^source:[a-z][a-z0-9_-]*$/.test(source["id"]) ||
      source["id"].length > 100 || source["id"] === "source:wmm_authoring" ||
      typeof source["title"] !== "string" || !source["title"].trim() || source["title"].length > 240 ||
      typeof source["path"] !== "string" || source["path"].length > 1024 ||
      /[\\:*?\[\]{}<>|"\u0000-\u001f\u007f]/.test(source["path"]) ||
      source["path"].split("/").some((part) => !part || part === "." || part === "..")) {
      throw new HarnessInputError();
    }
    if (ids.has(source["id"]) || paths.has(source["path"])) throw new HarnessInputError();
    ids.add(source["id"]);
    paths.add(source["path"]);
  }
  return request as unknown as HarnessRequest;
}

function operatorPath(base: string, path: string): string {
  return isAbsolute(path) ? path : `${base}${sep}${path}`;
}

/** Check raw components before normalization, including a symlink before '..'.
 * Stable private parents are required: Node has no atomic openat confinement.
 */
function existingPath(path: string, kind: "file" | "directory"): string {
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new HarnessInputError();
  const absolute = operatorPath(process.cwd(), path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep)) {
    if (!lstatSync(current).isDirectory()) throw new HarnessInputError();
    if (!part || part === ".") continue;
    current = part === ".." ? dirname(current) : join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new HarnessInputError();
  }
  const stat = lstatSync(current);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new HarnessInputError();
  // The JS realpath implementation can preserve a case alias on macOS;
  // native realpath returns the filesystem's canonical component spelling.
  return realpathSync.native(current);
}

function contains(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function assertFreshDestination(destination: string, sourceRoot: string, inputFiles: readonly string[]): void {
  if (!destination || destination.length > 4096 || /[\u0000-\u001f\u007f]/.test(destination)) throw new HarnessInputError();
  const absolute = operatorPath(process.cwd(), destination);
  let current = parse(absolute).root;
  let missing = false;
  for (const part of absolute.slice(current.length).split(sep)) {
    if (!part || part === ".") continue;
    if (part === ".." && missing) throw new HarnessInputError();
    current = part === ".." ? dirname(current) : join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) { missing = true; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      lstatSync(join(current, "snapshot.json"), { throwIfNoEntry: false }) !== undefined) throw new HarnessInputError();
  }
  if (lstatSync(current, { throwIfNoEntry: false }) !== undefined) throw new HarnessInputError();
  let parent = dirname(current);
  while (lstatSync(parent, { throwIfNoEntry: false }) === undefined) parent = dirname(parent);
  // Resolve the actual existing parent first (including filesystem case aliases),
  // then append only the not-yet-existing suffix before containment comparison.
  const canonical = join(existingPath(parent, "directory"), relative(parent, current));
  if (contains(sourceRoot, canonical) || inputFiles.some((path) => contains(path, canonical))) throw new HarnessInputError();
}

function readText(path: string, limit: number, source = false): string {
  const observed = lstatSync(path, { bigint: true });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit)) throw new HarnessInputError();
    unchanged(observed, stat);
    const bytes = readJsonInput(fd, limit);
    if (bytes.length > limit || BigInt(bytes.length) !== stat.size) throw new HarnessInputError();
    unchanged(stat, fstatSync(fd, { bigint: true }));
    unchanged(stat, lstatSync(path, { bigint: true }));
    existingPath(path, "file");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: source }).decode(bytes);
  } finally { closeSync(fd); }
}

function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new HarnessInputError();
  }
}

export function resolveDmHarnessRunDirectory(path: string): string {
  try { return existingPath(path, "directory"); }
  catch { throw new HarnessInputError("Invalid DM harness run directory"); }
}

export function captureDmHarnessInput(requestPath: string, destination: string): CapturedDmHarnessInput {
  try {
    const requestFile = existingPath(requestPath, "file");
    const request = admitRequest(parseStrictJson(readText(requestFile, MAX_REQUEST_BYTES)));
    const base = dirname(requestFile);
    const projectFile = existingPath(operatorPath(base, request.projectPath), "file");
    const sourceRoot = existingPath(operatorPath(base, request.sourceRoot), "directory");
    assertFreshDestination(destination, sourceRoot, [requestFile, projectFile]);
    const project = parseStrictJson(readText(projectFile, HARNESS_INPUT_LIMITS.maxProjectBytes));
    let total = 0;
    return {
      format: "wmm.dm-harness-input/1", mode: "dm-import", task: request.task, project,
      sources: request.sources.map((source) => {
        const path = existingPath(operatorPath(sourceRoot, source.path), "file");
        if (!contains(sourceRoot, path)) throw new HarnessInputError();
        const text = readText(path, HARNESS_INPUT_LIMITS.maxSourceBytes, true);
        total += Buffer.byteLength(text);
        if (total > HARNESS_INPUT_LIMITS.maxTotalSourceBytes) throw new HarnessInputError();
        return { ...source, text };
      }),
    };
  } catch { throw new HarnessInputError(); }
}
