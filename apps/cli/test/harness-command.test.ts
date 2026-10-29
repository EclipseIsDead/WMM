import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileAuthoringProject } from "@wmm/core";
import { loadReleaseWorldBundle, validateWorldBundle, verifyAuthoringBundlePresentation } from "@wmm/exchange";
import type { AuthoringProject } from "@wmm/wire-contracts";
import { expect, it } from "vitest";
import { captureDmHarnessInput, HarnessInputError } from "../src/harness-input.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/authoring/faction-project.json", import.meta.url));
const scriptedBootstrap = "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, '/scripted installation/hermes'); sys._hermes_pin_default_home = True; import hermes_bootstrap; os.environ.get('HERMES_HOME') or os.environ.__setitem__('HERMES_HOME', str(__import__('hermes_constants').get_default_hermes_root())); runpy.run_module('types', run_name='__main__', alter_sys=True)";
const fixedScriptSuffix = "; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')";
function selected(root: string) {
  mkdirSync(join(root, "selected"));
  writeFileSync(join(root, "project.json"), readFileSync(fixture));
  writeFileSync(join(root, "selected", "new.md"), "A blue lantern marks the guild's meeting place.\n");
  const request = {
    format: "wmm.dm-harness-request/1", mode: "dm-import", projectPath: "project.json", sourceRoot: "selected",
    task: "Add a source-cited narrative detail. Keep relationships and campaign tracks unchanged.",
    sources: [{ id: "source:new_notes", title: "Selected new note", path: "new.md" }],
  };
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  return { request, requestPath, output: join(root, "run") };
}
function run(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [main, ...args], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, ...env },
  });
}
function temporary(test: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-cli-"));
  try { test(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Authored offline protocol responder. This is NOT Hermes/SDK/model evidence.
 * It runs as an actual child executable, and all five WMM tools run in the real
 * host/application. Only provider/network behavior is replaced by this script.
 */
function scriptedResponder(root: string) {
  const bin = join(root, "scripted-bin");
  const trace = join(root, "scripted-offline-trace.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "hermes"), `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const names = ["wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit"];
const log = (entry) => fs.appendFileSync(process.env.WMM_SCRIPTED_TRACE, JSON.stringify(entry) + "\\n");
const argv = process.argv.slice(2);
const bootstrap = ${JSON.stringify(scriptedBootstrap)};
const fixedScript = ${JSON.stringify(fixedScriptSuffix)};
if (argv[0] === "--print-runtime-command") {
  if (JSON.stringify(argv.slice(0, 4)) !== JSON.stringify(["--print-runtime-command", "--module", "types", "--"])) throw new Error("Invalid scripted printer request");
  log({ kind: "launcher-query", argv, cwdEntries: fs.readdirSync(process.cwd()), safeMode: process.env.HERMES_SAFE_MODE });
  process.stdout.write(JSON.stringify([process.argv[1], "-I", "-c", bootstrap, ...argv.slice(4)]) + "\\n");
  process.exit(0);
}
if (argv[0] !== "-I" || argv[1] !== "-c" || argv[2] !== bootstrap + fixedScript) throw new Error("Invalid scripted isolated launch");
log({ kind: "launch", argv, cwdEntries: fs.readdirSync(process.cwd()), safeMode: process.env.HERMES_SAFE_MODE });
const send = (frame) => { log({ direction: "sent", frame }); process.stdout.write(JSON.stringify(frame) + "\\n"); };
const messages = [];
let stage = 0, base, source, proposal;
const call = (name, args) => send({ type: "tool_call", id: ++stage, name, arguments: args });
const complete = () => {
  const text = "OFFLINE SCRIPTED RESPONDER: no model/provider was invoked. Explicit WMM tool submission only.";
  messages.push({ role: "assistant", content: text });
  send({ type: "complete", sessionId: "scripted-offline-session", finalResponse: text, messages });
  process.stdin.pause();
  process.exit(0);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  log({ direction: "received", frame });
  if (frame.type === "initialize") {
    if (JSON.stringify(frame.tools.map((tool) => tool.name)) !== JSON.stringify(names) || frame.maxIterations !== 12 || frame.maxTokens !== 8192 || frame.maxSeconds !== 240) throw new Error("Invalid host initialization");
    send({ type: "ready", tools: names,
      isolation: { contextFiles: process.env.WMM_SCRIPTED_MODE === "bad-ready", memory: false, skills: false, soul: false, externalTools: false, contextEngine: "builtin" },
      runtime: { adapter: "hermes-sdk", model: "scripted-offline-not-a-model", provider: "scripted-test-not-a-provider" } });
  } else if (frame.type === "start") {
    messages.push({ role: "user", content: frame.userMessage });
    if (process.env.WMM_SCRIPTED_MODE === "no-submit") { complete(); return; }
    call(names[0], {});
  } else if (frame.type === "tool_result") {
    if (frame.id !== stage || frame.result.ok !== true) throw new Error("Real WMM tool rejected: " + JSON.stringify(frame));
    messages.push({ role: "tool", name: names[stage - 1], content: JSON.stringify(frame.result) });
    if (stage === 1) { base = frame.result; call(names[1], { sourceId: base.sources[0].id }); }
    else if (stage === 2) { source = frame.result.source; call(names[2], {}); }
    else if (stage === 3) {
      if (frame.result.schema.$defs.Project.additionalProperties !== false) throw new Error("Expected actual closed authoring schema");
      const project = structuredClone(base.project);
      project.sources.push({ id: source.id, title: source.title, path: source.path });
      const index = project.entities[0].sections.length;
      project.entities[0].sections.push({ id: "selected_lantern", heading: "Selected lantern detail", category: "dm-note", context: { kind: "setting" }, text: source.text, references: [], citations: [{ sourceId: source.id, locator: "line 1" }] });
      proposal = { format: "wmm.dm-harness-proposal/1", runInputDigest: base.runInputDigest, project,
        summary: "Offline scripted source-bound narrative addition; not model output.", uncertainties: ["Declared source use is interpretation, not proof."],
        sourceUses: [{ projectPointer: "/entities/0/sections/" + index, sourceId: source.id, sourceSha256: source.sha256, startLine: 1, endLine: 1 }] };
      call(names[3], { proposal });
    } else if (stage === 4) call(names[4], { proposal });
    else if (stage === 5) {
      // Test-only real-filesystem fault: occupy the host's exclusive project
      // destination after admitted submission, before host finalization.
      if (process.env.WMM_SCRIPTED_MODE === "block-finalization") fs.writeFileSync("../project.json", "SYNTHETIC_FINALIZATION_COLLISION", { flag: "wx" });
      complete();
    }
  } else throw new Error("Unexpected host frame");
});
`, { mode: 0o700 });
  return { trace, env: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, WMM_SCRIPTED_TRACE: trace } };
}

function snapshotFiles(directory: string, prefix = ""): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) for (const [child, bytes] of snapshotFiles(directory, path)) result.set(child, bytes);
    else result.set(path, readFileSync(join(directory, path)));
  }
  return result;
}

it("rejects malformed harness usage with a specific JSON error before output creation", () => temporary((root) => {
  const output = join(root, "run");
  const result = run(["harness", "run", "absent.json", "--out", output, "--force"]);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    apiVersion: "wmm/dev/1", outcome: "error", execution: "completed", error: { code: "HARNESS_USAGE_ERROR" },
  });
  expect(existsSync(output)).toBe(false);
}));

it("rejects duplicate request keys without reflecting selected data or starting a provider", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const secret = "SYNTHETIC_PRIVATE_CANARY_DO_NOT_ECHO";
  writeFileSync(requestPath, `{\"task\":\"${secret}\",\"task\":\"again\"}`);
  const result = run(["harness", "run", requestPath, "--out", output]);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_INPUT_ERROR");
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(existsSync(output)).toBe(false);
}));

it("captures only the explicitly selected file as plain logical data, retaining every leading BOM", () => temporary((root) => {
  const { requestPath, output, request } = selected(root);
  const text = "\uFEFF\uFEFFSelected exact source.\r\nSecond line.\n";
  writeFileSync(join(root, "selected", "new.md"), text);
  writeFileSync(join(root, "selected", "private-not-selected.md"), "SYNTHETIC_PRIVATE_CANARY_DO_NOT_READ");
  const captured = captureDmHarnessInput(requestPath, output);
  expect(captured).toEqual({
    format: "wmm.dm-harness-input/1", mode: "dm-import", task: request.task,
    project: JSON.parse(readFileSync(fixture, "utf8")),
    sources: [{ ...request.sources[0], text }],
  });
  expect(JSON.stringify(captured)).not.toContain(root);
  expect(JSON.stringify(captured)).not.toContain("SYNTHETIC_PRIVATE_CANARY_DO_NOT_READ");
  expect(existsSync(output)).toBe(false);
  expect(readFileSync(join(root, "selected", "new.md"))).toEqual(Buffer.from(text));
}));

it.each([
  ["unknown host field", { discover: true }],
  ["ambient model profile", { profile: "private-profile" }],
  ["unknown format", { format: "wmm.dm-harness-input/1" }],
  ["actor mode", { mode: "actor" }],
  ["implicit source root", { sourceRoot: "" }],
  ["blank task", { task: "   " }],
  ["task budget", { task: "x".repeat(8193) }],
  ["non-array selection", { sources: {} }],
])("rejects a closed host request violation: %s", (_label, patch) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  writeFileSync(requestPath, JSON.stringify({ ...request, ...patch }));
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it.each([
  ["extra source capability", { discover: true }],
  ["non-source ID", { id: "person:not_a_source" }],
  ["reserved source ID", { id: "source:wmm_authoring" }],
  ["empty title", { title: "" }],
  ["oversized title", { title: "x".repeat(241) }],
  ["traversal", { path: "../project.json" }],
  ["normalized traversal", { path: "child/../new.md" }],
  ["dot component", { path: "./new.md" }],
  ["empty component", { path: "child//new.md" }],
])("admits only explicit portable source declarations: %s", (_label, patch) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  writeFileSync(requestPath, JSON.stringify({ ...request, sources: [{ ...request.sources[0], ...patch }] }));
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it.each(["*.md", "[new].md", "C:drive.md", "back\\slash.md"])("refuses special source path syntax even if an exact file exists: %s", (path) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  writeFileSync(join(root, "selected", path), "SYNTHETIC_PRIVATE_PATH_CANARY");
  writeFileSync(requestPath, JSON.stringify({ ...request, sources: [{ ...request.sources[0], path }] }));
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it("rejects an absolute selected source even when it is inside the selected root", () => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  writeFileSync(requestPath, JSON.stringify({ ...request, sources: [{ ...request.sources[0], path: join(root, "selected", "new.md") }] }));
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
}));

it.each(["request ancestor", "project ancestor", "source root", "source ancestor", "source target", "symlink before dotdot"])("refuses selected input symlinks: %s", (kind) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  let selectedRequestPath = requestPath;
  if (kind === "request ancestor") {
    symlinkSync(root, join(root, "alias"));
    selectedRequestPath = join(root, "alias", "request.json");
  } else if (kind === "project ancestor") {
    symlinkSync(root, join(root, "alias"));
    request.projectPath = "alias/project.json";
  } else if (kind === "source root") {
    symlinkSync(join(root, "selected"), join(root, "alias"));
    request.sourceRoot = "alias";
  } else if (kind === "source ancestor") {
    symlinkSync(join(root, "selected"), join(root, "selected", "alias"));
    request.sources[0]!.path = "alias/new.md";
  } else if (kind === "source target") {
    symlinkSync(join(root, "selected", "new.md"), join(root, "selected", "alias.md"));
    request.sources[0]!.path = "alias.md";
  } else {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    request.projectPath = "alias/../project.json";
  }
  writeFileSync(requestPath, JSON.stringify(request));
  expect(() => captureDmHarnessInput(selectedRequestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it.each(["source descendant", "normalized source alias", "request collision", "project collision", "existing directory", "symlink ancestor", "dangling symlink", "bundle descendant"])("rejects protected or nonfresh output before any write: %s", (kind) => temporary((root) => {
  const { requestPath, output } = selected(root);
  let destination = output;
  if (kind === "source descendant") destination = join(root, "selected", "draft");
  else if (kind === "normalized source alias") destination = `${root}/selected/../selected/draft`;
  else if (kind === "request collision") destination = requestPath;
  else if (kind === "project collision") destination = join(root, "project.json");
  else if (kind === "existing directory") mkdirSync(destination);
  else if (kind === "symlink ancestor") {
    symlinkSync(join(root, "selected"), join(root, "alias"));
    destination = join(root, "alias", "draft");
  } else if (kind === "dangling symlink") symlinkSync(join(root, "absent"), destination);
  else {
    mkdirSync(join(root, "bundle"));
    writeFileSync(join(root, "bundle", "snapshot.json"), "{}");
    destination = join(root, "bundle", "draft");
  }
  const original = readFileSync(requestPath);
  expect(() => captureDmHarnessInput(requestPath, destination)).toThrowError(HarnessInputError);
  expect(readFileSync(requestPath)).toEqual(original);
  expect(existsSync(join(root, "selected", "draft"))).toBe(false);
  expect(existsSync(join(root, "bundle", "draft"))).toBe(false);
}));

it.each(["source count", "duplicate IDs", "duplicate paths", "aggregate bytes"])("rejects inadmissible whole selections before output creation: %s", (kind) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  const count = kind === "source count" ? 17 : kind === "aggregate bytes" ? 5 : 2;
  request.sources = Array.from({ length: count }, (_, index) => {
    const path = kind === "duplicate paths" ? "same.md" : `selected_${index}.md`;
    writeFileSync(join(root, "selected", path), kind === "aggregate bytes" ? "é".repeat(32768) : "small");
    return { id: kind === "duplicate IDs" ? "source:duplicate" : `source:selected_${index}`, title: "Explicit selected source", path };
  });
  writeFileSync(requestPath, JSON.stringify(request));
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it("accepts the exact source-count and total UTF-8 byte bounds without shortening any file", () => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  const text = "é".repeat(8192);
  request.sources = Array.from({ length: 16 }, (_, index) => {
    const path = `selected_${index}.md`;
    writeFileSync(join(root, "selected", path), text);
    return { id: `source:selected_${index}`, title: "Explicit source", path };
  });
  writeFileSync(requestPath, JSON.stringify(request));
  const captured = captureDmHarnessInput(requestPath, output);
  expect(captured.sources).toHaveLength(16);
  expect(captured.sources.every((source) => source.text === text)).toBe(true);
  expect(captured.sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.text), 0)).toBe(262144);
}));

it.each([
  ["duplicate project keys", "project.json", '{"format":"x","format":"y"}'],
  ["project comments", "project.json", '{/* not JSON */"format":"x"}'],
  ["project trailing comma", "project.json", '{"format":"x",}'],
  ["project Unicode scalar", "project.json", '{"title":"\\ud800"}'],
  ["project depth", "project.json", "[".repeat(129) + "0" + "]".repeat(129)],
  ["project node budget", "project.json", "[" + "0,".repeat(100000) + "0]"],
  ["project UTF-8", "project.json", Buffer.from([0xff])],
  ["project bytes", "project.json", " ".repeat(262145)],
  ["request UTF-8", "request.json", Buffer.from([0xff])],
  ["request bytes", "request.json", " ".repeat(1048577)],
  ["source UTF-8", "selected/new.md", Buffer.from([0xef, 0xbb, 0xbf, 0xff])],
  ["source bytes", "selected/new.md", "é".repeat(32769)],
])("rejects strict bounded input: %s", (_label, path, bytes) => temporary((root) => {
  const { requestPath, output } = selected(root);
  writeFileSync(join(root, path), bytes);
  expect(() => captureDmHarnessInput(requestPath, output)).toThrowError(HarnessInputError);
  expect(existsSync(output)).toBe(false);
}));

it.each(["request.json", "project.json", "selected/new.md"])("refuses FIFO inputs without blocking or creating output: %s", (path) => temporary((root) => {
  const { requestPath, output } = selected(root);
  const target = join(root, path);
  rmSync(target);
  const fifo = spawnSync("mkfifo", [target], { encoding: "utf8", timeout: 2000 });
  expect(fifo.status, fifo.stdout + fifo.stderr).toBe(0);
  const result = spawnSync(process.execPath, [main, "harness", "run", requestPath, "--out", output], { encoding: "utf8", timeout: 2000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_INPUT_ERROR");
  expect(existsSync(output)).toBe(false);
}));

it("uses canonical existing parents for containment but permits a fresh sibling with the same prefix", () => temporary((root) => {
  const { request, requestPath } = selected(root);
  // Real filesystem alias on case-insensitive volumes; exact spelling elsewhere.
  if (existsSync(join(root, "SELECTED"))) request.sourceRoot = "SELECTED";
  writeFileSync(requestPath, JSON.stringify(request));
  expect(() => captureDmHarnessInput(requestPath, join(root, "selected", "draft"))).toThrowError(HarnessInputError);
  expect(captureDmHarnessInput(requestPath, join(root, "selected-sibling", "fresh"))).toMatchObject({ format: "wmm.dm-harness-input/1" });
}));

it("rejects a selected inode that grows during bounded fd capture", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  // Deterministic test-child fault injection around real fs reads, not a
  // production hook or fabricated input. The actual file changes mid-capture.
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const [moduleUrl, request, output, source] = process.argv.slice(1);
    const inode = fs.statSync(source).ino;
    const originalRead = fs.readSync;
    let changed = false;
    fs.readSync = function(fd, ...args) {
      const result = originalRead.call(fs, fd, ...args);
      if (!changed && fs.fstatSync(fd).ino === inode) {
        changed = true;
        fs.appendFileSync(source, "\\nUnexpected concurrent append");
      }
      return result;
    };
    syncBuiltinESMExports();
    const { captureDmHarnessInput } = await import(moduleUrl);
    try { captureDmHarnessInput(request, output); console.log(JSON.stringify({ changed, accepted: true })); }
    catch (error) { console.log(JSON.stringify({ changed, accepted: false, code: error.code })); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, "--",
    pathToFileURL(fileURLToPath(new URL("../dist/harness-input.js", import.meta.url))).href,
    requestPath, output, join(root, "selected", "new.md")], { encoding: "utf8", timeout: 2000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ changed: true, accepted: false, code: "HARNESS_INPUT_ERROR" });
  expect(existsSync(output)).toBe(false);
}));

it("runs the actual CLI, process IPC and five real WMM tools into a reloadable DRAFT (offline scripted responder, not a model)", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const projectBytes = readFileSync(join(root, "project.json"));
  const sourceText = "\uFEFF\uFEFFA blue lantern marks the guild's meeting place.\n";
  writeFileSync(join(root, "selected", "new.md"), sourceText);
  const sourceBytes = readFileSync(join(root, "selected", "new.md"));
  writeFileSync(join(root, "selected", "unselected.md"), "SYNTHETIC_PRIVATE_UNSELECTED_CANARY");
  const baseline = JSON.parse(projectBytes.toString("utf8")) as AuthoringProject;
  const compiledBase = compileAuthoringProject(baseline);
  expect(baseline.facts).toHaveLength(1);
  expect(baseline.entities[0]!.sections).toHaveLength(2);
  expect(baseline.campaigns[0]!.tracks).toHaveLength(1);
  expect(baseline.campaigns[0]!.tracks[0]!.entries).toHaveLength(2);

  const response = run(["harness", "run", requestPath, "--out", output], responder.env);
  expect(response.status, response.stdout + response.stderr).toBe(0);
  const envelope = JSON.parse(response.stdout);
  expect(envelope).toMatchObject({ apiVersion: "wmm/dev/1", outcome: "success", execution: "completed", data: { format: "wmm.dm-harness-result/1", status: "draft", runDirectory: output } });
  const result = envelope.data;
  const project = JSON.parse(readFileSync(result.projectPath, "utf8")) as AuthoringProject;
  expect(project.facts).toEqual(baseline.facts);
  expect(project.campaigns).toEqual(baseline.campaigns);
  expect(project.entities[0]!.sections.slice(0, 2)).toEqual(baseline.entities[0]!.sections);
  expect(project.entities[0]!.sections[2]!.text).toBe(sourceText);
  expect(project.sources.slice(0, baseline.sources.length)).toEqual(baseline.sources);

  const bundle = loadReleaseWorldBundle(result.bundlePath);
  expect(validateWorldBundle(bundle).status).toBe("valid");
  expect(() => verifyAuthoringBundlePresentation(bundle)).not.toThrow();
  expect(bundle.snapshot.snapshotDigest).toBe(result.snapshotDigest);
  expect(result.baseSnapshotDigest).toBe(compiledBase.snapshot.snapshotDigest);
  for (const original of compiledBase.payload.filter((file) => file.path.startsWith("prose/"))) {
    const retained = bundle.documents.find((document) => document.path === original.path);
    expect(retained, original.path).toBeDefined();
    expect(Buffer.from(retained!.bytes)).toEqual(Buffer.from(original.bytes));
  }
  const review = readFileSync(result.reviewPath, "utf8");
  expect(review).toContain("DRAFT");
  expect(review).toContain("NOT CANON");
  expect(review).toContain("not proof");
  const manifest = JSON.parse(readFileSync(join(result.notesPath, "wmm-notes.json"), "utf8")) as { files: { path: string; sha256: string; byteLength: string }[] };
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(result.notesPath, entry.path));
    expect(bytes.toString("utf8")).toContain("DRAFT");
    expect(bytes.toString("utf8")).toContain("NOT CANON");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    expect(String(bytes.length)).toBe(entry.byteLength);
  }
  const trace = readFileSync(responder.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(trace[0]).toMatchObject({ kind: "launcher-query", cwdEntries: [], safeMode: "1" });
  expect(trace[0].argv.slice(0, 4)).toEqual(["--print-runtime-command", "--module", "types", "--"]);
  expect(trace[1]).toMatchObject({ kind: "launch", cwdEntries: [], safeMode: "1" });
  expect(trace[1].argv.slice(0, 3)).toEqual(["-I", "-c", scriptedBootstrap + fixedScriptSuffix]);
  expect(trace[1].argv.slice(3)).toEqual(trace[0].argv.slice(4));
  expect(trace[1].argv[3]).toBe(fileURLToPath(new URL("../../../tools/harness/hermes_adapter.py", import.meta.url)));
  const frames = trace.filter((entry) => entry.frame !== undefined);
  expect(frames.filter((entry) => entry.direction === "sent" && entry.frame.type === "tool_call").map((entry) => entry.frame.name)).toEqual([
    "wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit",
  ]);
  expect(JSON.stringify(frames)).not.toContain(root);
  expect(JSON.stringify(frames)).not.toContain("SYNTHETIC_PRIVATE_UNSELECTED_CANARY");
  expect(readdirSync(join(result.attemptDirectory, "calls"))).toHaveLength(5);
  expect(readFileSync(join(result.attemptDirectory, "runtime", "conversation.json"), "utf8")).toContain("OFFLINE SCRIPTED RESPONDER");
  expect(readFileSync(join(root, "project.json"))).toEqual(projectBytes);
  expect(readFileSync(join(root, "selected", "new.md"))).toEqual(sourceBytes);
}));

it("passes explicit model/provider selections literally to the thin runtime, without profiles", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const result = run(["harness", "run", requestPath, "--out", output, "--model", "synthetic/model-name", "--provider", "synthetic-provider"], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const trace = readFileSync(responder.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(trace[0].kind).toBe("launcher-query");
  expect(trace[0].argv.slice(5)).toEqual(["--model", "synthetic/model-name", "--provider", "synthetic-provider"]);
  expect(trace[1].kind).toBe("launch");
  expect(trace[1].argv.slice(4)).toEqual(["--model", "synthetic/model-name", "--provider", "synthetic-provider"]);
}));

it.each([
  ["--model"], ["--model", ""], ["--provider", "--model"], ["--model", "bad\nmodel"],
  ["--model", "first", "--model", "second"], ["--provider", "one", "--provider", "two"],
  ["--out", "another-output"], ["--profile", "private-profile"], ["extra-positional"], ["--force"],
])("denies unsupported or malformed CLI options before capture/provider (%j)", (...extra) => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const result = run(["harness", "run", requestPath, "--out", output, ...extra], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_USAGE_ERROR");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(responder.trace)).toBe(false);
}));

it.each(["invalid project", "unsupported economic notes"])("reports safe application admission errors before output/provider: %s", (kind) => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  if (kind === "invalid project") {
    const project = JSON.parse(readFileSync(fixture, "utf8"));
    project.SYNTHETIC_PRIVATE_FIELD_CANARY = true;
    writeFileSync(join(root, "project.json"), JSON.stringify(project));
  } else writeFileSync(join(root, "project.json"), readFileSync(fileURLToPath(new URL("../../../fixtures/authoring/grain-project.json", import.meta.url))));
  const result = run(["harness", "run", requestPath, "--out", output], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe(kind === "invalid project" ? "HARNESS_INPUT_ERROR" : "HARNESS_UNSUPPORTED_PROFILE");
  expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE_FIELD_CANARY");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(responder.trace)).toBe(false);
}));

it("discovers both harness commands without changing existing command help or version behavior", () => {
  const help = run(["--help"]);
  expect(help.status, help.stdout + help.stderr).toBe(0);
  expect(help.stdout).toContain("wmm harness run <request.json> --out <fresh-run-directory> [--model <model>] [--provider <provider>]");
  expect(help.stdout).toContain("wmm harness resume <run-directory> [--model <model>] [--provider <provider>]");
  expect(help.stdout).toContain("wmm authoring build");
  expect(help.stdout).toContain("wmm workspace open");
  expect(help.stdout).toContain("wmm json [--workspace-dir <directory>]");
  expect(run(["--version"]).stdout.trim()).toBe("0.1.0-alpha.1");
});

it("never treats final prose as a submitted proposal and retains the resumable attempt", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const result = run(["harness", "run", requestPath, "--out", output], { ...responder.env, WMM_SCRIPTED_MODE: "no-submit" });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_NO_PROPOSAL");
  expect(existsSync(join(output, "run.json"))).toBe(true);
  const attempts = readdirSync(join(output, "attempts"));
  expect(attempts).toHaveLength(1);
  const attempt = join(output, "attempts", attempts[0]!);
  expect(existsSync(join(attempt, "runtime", "conversation.json"))).toBe(true);
  expect(existsSync(join(attempt, "proposal.json"))).toBe(false);
  expect(existsSync(join(attempt, "result.json"))).toBe(false);
  expect(existsSync(join(attempt, "bundle"))).toBe(false);
}));

it("preserves a specific safe runtime-policy error and withholds selected input until ready", () => temporary((root) => {
  const { requestPath, output, request } = selected(root);
  const responder = scriptedResponder(root);
  const result = run(["harness", "run", requestPath, "--out", output], { ...responder.env, WMM_SCRIPTED_MODE: "bad-ready" });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_RUNTIME_POLICY");
  const trace = readFileSync(responder.trace, "utf8");
  expect(trace).not.toContain('"type":"start"');
  expect(trace).not.toContain(request.task);
  expect(trace).not.toContain("A blue lantern");
  expect(result.stdout + result.stderr).not.toContain(root);
  expect(existsSync(join(output, "run.json"))).toBe(true);
}));

it("resumes a retained explicit proposal into fresh DRAFT artifacts without launching a provider or reopening original inputs", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const first = run(["harness", "run", requestPath, "--out", output], responder.env);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  const original = JSON.parse(first.stdout).data;
  const retained = snapshotFiles(output);
  const trace = readFileSync(responder.trace);
  rmSync(requestPath);
  rmSync(join(root, "project.json"));
  rmSync(join(root, "selected"), { recursive: true });
  const resumed = run(["harness", "resume", output, "--model", "unused-model", "--provider", "unused-provider"], { ...responder.env, WMM_SCRIPTED_MODE: "bad-ready" });
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  const result = JSON.parse(resumed.stdout).data;
  expect(result).toMatchObject({ format: "wmm.dm-harness-result/1", status: "draft", runId: original.runId, runInputDigest: original.runInputDigest, proposalDigest: original.proposalDigest, snapshotDigest: original.snapshotDigest });
  expect(result.attemptDirectory).not.toBe(original.attemptDirectory);
  expect(existsSync(join(result.attemptDirectory, "runtime"))).toBe(false);
  expect(readFileSync(responder.trace)).toEqual(trace);
  expect(validateWorldBundle(loadReleaseWorldBundle(result.bundlePath)).status).toBe("valid");
  for (const [path, bytes] of retained) expect(readFileSync(join(output, path)), path).toEqual(bytes);
}));

it("starts a new scoped process from sealed inputs when resume has no usable submission", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const first = run(["harness", "run", requestPath, "--out", output], { ...responder.env, WMM_SCRIPTED_MODE: "no-submit" });
  expect(JSON.parse(first.stdout).error.code).toBe("HARNESS_NO_PROPOSAL");
  const retained = snapshotFiles(output);
  rmSync(requestPath);
  rmSync(join(root, "project.json"));
  rmSync(join(root, "selected"), { recursive: true });
  const resumed = run(["harness", "resume", output], responder.env);
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  const result = JSON.parse(resumed.stdout).data;
  expect(validateWorldBundle(loadReleaseWorldBundle(result.bundlePath)).status).toBe("valid");
  expect(readdirSync(join(output, "attempts"))).toHaveLength(2);
  expect(readFileSync(join(result.attemptDirectory, "runtime", "conversation.json"), "utf8")).toContain("OFFLINE SCRIPTED RESPONDER");
  for (const [path, bytes] of retained) expect(readFileSync(join(output, path)), path).toEqual(bytes);
  const launches = readFileSync(responder.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "launch");
  expect(launches).toHaveLength(2);
}));

it("rejects tampered sealed inputs with a specific safe integrity error before a fresh attempt or provider", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const first = run(["harness", "run", requestPath, "--out", output], { ...responder.env, WMM_SCRIPTED_MODE: "no-submit" });
  expect(JSON.parse(first.stdout).error.code).toBe("HARNESS_NO_PROPOSAL");
  const input = JSON.parse(readFileSync(join(output, "input.json"), "utf8"));
  input.task = "SYNTHETIC_PRIVATE_TAMPER_CANARY";
  writeFileSync(join(output, "input.json"), JSON.stringify(input));
  const retained = snapshotFiles(output);
  const trace = readFileSync(responder.trace);
  const result = run(["harness", "resume", output], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_INTEGRITY_MISMATCH");
  expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE_TAMPER_CANARY");
  expect(readFileSync(responder.trace)).toEqual(trace);
  for (const [path, bytes] of retained) expect(readFileSync(join(output, path)), path).toEqual(bytes);
  expect(readdirSync(join(output, "attempts"))).toHaveLength(1);
}));

it("reports safe finalization failure and recovers the admitted proposal in a fresh attempt without clobbering partial output", () => temporary((root) => {
  const { requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const first = run(["harness", "run", requestPath, "--out", output], { ...responder.env, WMM_SCRIPTED_MODE: "block-finalization" });
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(JSON.parse(first.stdout).error.code).toBe("HARNESS_FINALIZATION_ERROR");
  expect(first.stdout + first.stderr).not.toContain(root);
  const attempt = join(output, "attempts", readdirSync(join(output, "attempts"))[0]!);
  expect(readFileSync(join(attempt, "project.json"), "utf8")).toBe("SYNTHETIC_FINALIZATION_COLLISION");
  expect(existsSync(join(attempt, "proposal.json"))).toBe(true);
  expect(existsSync(join(attempt, "result.json"))).toBe(false);
  const retained = snapshotFiles(output);
  const trace = readFileSync(responder.trace);
  const resumed = run(["harness", "resume", output], { ...responder.env, WMM_SCRIPTED_MODE: "bad-ready" });
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  const result = JSON.parse(resumed.stdout).data;
  expect(result.attemptDirectory).not.toBe(attempt);
  expect(validateWorldBundle(loadReleaseWorldBundle(result.bundlePath)).status).toBe("valid");
  expect(readFileSync(responder.trace)).toEqual(trace);
  for (const [path, bytes] of retained) expect(readFileSync(join(output, path)), path).toEqual(bytes);
}));

it("validates the entire selected set before creating output or starting any provider", () => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  const original = readFileSync(join(root, "selected", "new.md"));
  writeFileSync(join(root, "selected", "second.md"), Buffer.from([0xff]));
  request.sources.push({ id: "source:second", title: "Invalid second selection", path: "second.md" });
  writeFileSync(requestPath, JSON.stringify(request));
  const result = run(["harness", "run", requestPath, "--out", output], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_INPUT_ERROR");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(responder.trace)).toBe(false);
  expect(readFileSync(join(root, "selected", "new.md"))).toEqual(original);
}));

it.each(["request target", "project target", "source directory", "device", "resume symlink"])("denies nonregular or aliased operator inputs without writes/provider: %s", (kind) => temporary((root) => {
  const { request, requestPath, output } = selected(root);
  const responder = scriptedResponder(root);
  let path = requestPath;
  let command = "run";
  if (kind === "request target") {
    path = join(root, "request-alias.json");
    symlinkSync(requestPath, path);
  } else if (kind === "project target") {
    symlinkSync(join(root, "project.json"), join(root, "project-alias.json"));
    request.projectPath = "project-alias.json";
  } else if (kind === "source directory") {
    mkdirSync(join(root, "selected", "folder"));
    request.sources[0]!.path = "folder";
  } else if (kind === "device") request.projectPath = "/dev/null";
  else {
    command = "resume";
    path = join(root, "run-alias");
    symlinkSync(root, path);
  }
  writeFileSync(requestPath, JSON.stringify(request));
  const result = run(["harness", command, path, ...(command === "run" ? ["--out", output] : [])], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_INPUT_ERROR");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(responder.trace)).toBe(false);
  expect(existsSync(join(root, "attempts"))).toBe(false);
}));

it.each([
  [], ["run"], ["run", "request.json"], ["run", "--model", "x"], ["run", "request.json", "--out"],
  ["resume"], ["resume", "absent-run", "--out", "fresh"], ["resume", "absent-run", "--profile", "private"],
  ["run", "request.json", "--out", "fresh", "--model", "x", "extra"], ["other", "request.json"],
])("denies incomplete/unknown command grammar before filesystem work (%j)", (...args) => temporary((root) => {
  const responder = scriptedResponder(root);
  const result = run(["harness", ...args], responder.env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("HARNESS_USAGE_ERROR");
  expect(existsSync(responder.trace)).toBe(false);
  expect(existsSync(join(root, "attempts"))).toBe(false);
}));
