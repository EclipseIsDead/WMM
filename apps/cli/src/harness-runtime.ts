import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@wmm/canonical";
import type { JsonValue } from "@wmm/wire-contracts";
import { parseStrictJson } from "./json-input.js";

export const DM_HARNESS_TOOL_NAMES = Object.freeze([
  "wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit",
]);
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_CALLS = 32;
const MAX_STDOUT_BYTES = 24 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LAUNCHER_BYTES = 64 * 1024;
const RUNTIME_ERROR_CODES = new Set(["AUTH_REQUIRED", "UNSUPPORTED_CONTEXT_ENGINE", "UNSUPPORTED_TRANSPORT", "UNSUPPORTED_HERMES_VERSION", "RUNTIME_ERROR", "PROTOCOL_ERROR", "BUDGET_EXCEEDED", "SDK_UNAVAILABLE", "ISOLATION_REJECTED"]);

export interface DmHarnessRuntimeSession {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptDirectory: string;
  tools(): readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  startMessage(): string;
  call(name: string, args: unknown): JsonValue;
}

export interface DmHarnessRuntimeOptions { readonly model?: string; readonly provider?: string }
/** Host-only injection for offline process tests; never exposed as CLI/model arguments. */
export interface DmHarnessRuntimeHost { readonly executable?: string; readonly args?: readonly string[]; readonly timeoutMs?: number; readonly adapterPath?: string }

export class HarnessRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "HarnessRuntimeError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
}

function scopedToolNames(value: unknown): boolean {
  return Array.isArray(value) && value.length === DM_HARNESS_TOOL_NAMES.length && new Set(value).size === value.length &&
    value.every((name: unknown) => typeof name === "string" && DM_HARNESS_TOOL_NAMES.includes(name));
}

function launcherString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function runtimeCommand(value: unknown, scriptArgs: readonly string[]): value is string[] {
  if (!Array.isArray(value) || value.length !== 4 + scriptArgs.length || !value.every((arg: unknown) => launcherString(arg, 16 * 1024)) ||
      !launcherString(value[0], 4096) || !isAbsolute(value[0]) || value[1] !== "-I" || value[2] !== "-c" ||
      !scriptArgs.every((arg, index) => launcherString(arg, 4096) && value[index + 4] === arg) || !isAbsolute(scriptArgs[0]!)) return false;
  // Accept the published default-home bootstrap, not arbitrary printer code.
  // Only the literal installation root varies; never evaluate it in the host.
  const prefix = "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, ";
  const suffix = "); sys._hermes_pin_default_home = True; import hermes_bootstrap; os.environ.get('HERMES_HOME') or os.environ.__setitem__('HERMES_HOME', str(__import__('hermes_constants').get_default_hermes_root())); runpy.run_module('types', run_name='__main__', alter_sys=True)";
  const program = value[3] as string;
  if (!program.startsWith(prefix) || !program.endsWith(suffix)) return false;
  const literal = program.slice(prefix.length, -suffix.length);
  if (!/^(?:'(?:[^'\\]|\\['\\])*'|"(?:[^"\\]|\\["\\])*")$/u.test(literal)) return false;
  const root = literal.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  return launcherString(root, 4096) && isAbsolute(root);
}

export async function runDmHarnessAgent(session: DmHarnessRuntimeSession, options: DmHarnessRuntimeOptions = {}, host: DmHarnessRuntimeHost = {}): Promise<void> {
  const deadline = performance.now() + (host.timeoutMs ?? 300_000);
  const directory = join(session.attemptDirectory, "runtime");
  mkdirSync(directory, { mode: 0o700 });
  const adapter = host.adapterPath ?? fileURLToPath(new URL("../../../tools/harness/hermes_adapter.py", import.meta.url));
  const scriptArgs = [adapter];
  if (options.model !== undefined) scriptArgs.push("--model", options.model);
  if (options.provider !== undefined) scriptArgs.push("--provider", options.provider);
  const env = { ...process.env, HERMES_SAFE_MODE: "1", HERMES_ENVIRONMENT_HINT: "" };
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let activeChild: ChildProcess | undefined;
    let pending: Buffer = Buffer.alloc(0);
    let failure: HarnessRuntimeError | undefined;
    let phase: "initializing" | "running" | "complete" = "initializing";
    let ready: Record<string, unknown> | undefined;
    let completion: Record<string, unknown> | undefined;
    let toolCalls = 0;
    let resultBytes = 0;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let runtimeErrorCode: string | undefined;
    const launcher = host.args === undefined ? { stdoutBytes: 0, stderrBytes: 0 } : undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => fail("HARNESS_RUNTIME_TIMEOUT", "Hermes runtime exceeded the host deadline"), Math.max(1, deadline - performance.now()));
    function fail(code: string, message: string): void {
      if (failure !== undefined) return;
      failure = new HarnessRuntimeError(code, message);
      const owned = activeChild;
      owned?.kill("SIGTERM");
      killTimer = setTimeout(() => { owned?.kill("SIGKILL"); }, 500);
      killTimer.unref();
    }
    function send(frame: unknown): void { child.stdin.write(JSON.stringify(frame) + "\n"); }
    function receive(frame: Record<string, unknown>): void {
      if (phase !== "complete" && closed(frame, ["type", "code"]) && frame["type"] === "error") {
        runtimeErrorCode = typeof frame["code"] === "string" && RUNTIME_ERROR_CODES.has(frame["code"]) ? frame["code"] : "RUNTIME_ERROR";
        fail("HARNESS_RUNTIME_FAILED", `Hermes runtime stopped (${runtimeErrorCode})`);
        return;
      }
      if (phase === "initializing") {
        const isolation = frame["isolation"] as Record<string, unknown> | null | undefined;
        const runtime = frame["runtime"];
        if (!closed(frame, ["type", "tools", "isolation", "runtime"]) || frame["type"] !== "ready" || !scopedToolNames(frame["tools"]) ||
            isolation === null || typeof isolation !== "object" || Array.isArray(isolation) || Object.keys(isolation).length !== 6 ||
            !["contextFiles", "memory", "skills", "soul", "externalTools"].every((key) => isolation[key] === false) || isolation["contextEngine"] !== "builtin" ||
            !closed(runtime, ["adapter", "model", "provider"]) || runtime["adapter"] !== "hermes-sdk" || !identifier(runtime["model"]) || !identifier(runtime["provider"])) {
          fail("HARNESS_RUNTIME_POLICY", "Hermes runtime must disable ambient context and expose only scoped WMM tools");
          return;
        }
        ready = frame;
        phase = "running";
        send({ type: "start", userMessage: session.startMessage(), taskId: `${session.runId}-${session.attemptId}` });
      } else if (phase === "running" && frame["type"] === "tool_call") {
        if (!closed(frame, ["type", "id", "name", "arguments"]) || frame["id"] !== toolCalls + 1 || !record(frame["arguments"])) {
          fail("HARNESS_RUNTIME_PROTOCOL", "Invalid Hermes tool-call frame");
          return;
        }
        const name = frame["name"];
        if (typeof name !== "string" || !DM_HARNESS_TOOL_NAMES.includes(name)) {
          fail("HARNESS_RUNTIME_POLICY", "Runtime requested an unavailable WMM tool");
          return;
        }
        if (toolCalls >= MAX_TOOL_CALLS || Buffer.byteLength(JSON.stringify(frame["arguments"]), "utf8") > MAX_TOOL_BYTES) {
          fail("HARNESS_RUNTIME_BUDGET", "Hermes tool-call input exceeded the host budget");
          return;
        }
        toolCalls += 1;
        const result = canonicalJson(session.call(name, frame["arguments"]));
        const bytes = Buffer.byteLength(result, "utf8");
        resultBytes += bytes;
        if (bytes > MAX_TOOL_BYTES || resultBytes > MAX_RESULT_BYTES) {
          fail("HARNESS_RUNTIME_BUDGET", "WMM tool results exceeded the host byte budget");
          return;
        }
        send({ type: "tool_result", id: frame["id"], result: JSON.parse(result) });
      } else if (phase === "running" && frame["type"] === "complete") {
        if (!closed(frame, ["type", "sessionId", "finalResponse", "messages"]) || !identifier(frame["sessionId"]) ||
            typeof frame["finalResponse"] !== "string" || !frame["finalResponse"].isWellFormed() || !Array.isArray(frame["messages"])) {
          fail("HARNESS_RUNTIME_PROTOCOL", "Invalid Hermes completion frame");
          return;
        }
        completion = frame;
        phase = "complete";
      } else fail("HARNESS_RUNTIME_PROTOCOL", "Unexpected Hermes protocol frame");
    }
    function startRuntime(command: readonly string[]): void {
      child = spawn(command[0]!, command.slice(1), { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
      activeChild = child;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (failure !== undefined) return;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          fail("HARNESS_RUNTIME_BUDGET", "Hermes output exceeded the host stream budget");
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        try {
          let newline: number;
          while (failure === undefined && (newline = pending.indexOf(0x0a)) >= 0) {
            if (newline > MAX_FRAME_BYTES) {
              fail("HARNESS_RUNTIME_BUDGET", "Hermes protocol frame exceeded the host byte budget");
              break;
            }
            const frame = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pending.subarray(0, newline)));
            pending = pending.subarray(newline + 1);
            if (!record(frame)) throw new Error("Protocol frames must be objects");
            receive(frame);
          }
          if (failure === undefined && pending.length > MAX_FRAME_BYTES) fail("HARNESS_RUNTIME_BUDGET", "Hermes protocol frame exceeded the host byte budget");
        } catch {
          fail("HARNESS_RUNTIME_PROTOCOL", "Invalid Hermes protocol frame");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length; // Retain counts, never credential-bearing diagnostics.
        if (stderrBytes > MAX_STDERR_BYTES) fail("HARNESS_RUNTIME_BUDGET", "Hermes diagnostics exceeded the host stream budget");
      });
      child.on("error", () => fail("HARNESS_RUNTIME_UNAVAILABLE", "Unable to start the installed Hermes runtime"));
      child.on("close", finish);
      child.stdin.on("error", () => fail("HARNESS_RUNTIME_PROTOCOL", "Unable to write to the Hermes runtime"));
      send({ type: "initialize", tools: session.tools(), maxIterations: 12, maxTokens: 8192, maxSeconds: 240 });
    }
    function finish(code: number | null): void {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure === undefined && code === 0 && phase === "complete" && completion !== undefined && pending.length === 0) {
        try {
          writeFileSync(join(directory, "conversation.json"), JSON.stringify(completion["messages"]) + "\n", { flag: "wx", mode: 0o600 });
          writeFileSync(join(directory, "runtime.json"), JSON.stringify({ format: "wmm.dm-harness-runtime/1", status: "completed", toolCalls, resultBytes, stdoutBytes, stderrBytes, launcher, sessionId: completion["sessionId"], runtime: ready?.["runtime"], isolation: ready?.["isolation"], finalResponse: completion["finalResponse"] }) + "\n", { flag: "wx", mode: 0o600 });
          resolve();
        } catch { reject(new HarnessRuntimeError("HARNESS_RUNTIME_ARTIFACT", "Unable to retain the Hermes runtime artifacts")); }
      } else {
        failure ??= new HarnessRuntimeError("HARNESS_RUNTIME_PROTOCOL", "Hermes runtime stopped before completion");
        try {
          writeFileSync(join(directory, "runtime.json"), JSON.stringify({ format: "wmm.dm-harness-runtime/1", status: "failed", toolCalls, resultBytes, stdoutBytes, stderrBytes, launcher, error: { code: failure.code, ...(runtimeErrorCode === undefined ? {} : { runtimeCode: runtimeErrorCode }) } }) + "\n", { flag: "wx", mode: 0o600 });
          reject(failure);
        } catch { reject(new HarnessRuntimeError("HARNESS_RUNTIME_ARTIFACT", "Unable to retain the Hermes runtime failure")); }
      }
    }
    if (host.args !== undefined) {
      startRuntime([host.executable ?? "hermes", ...host.args, ...scriptArgs.slice(1)]);
    } else {
      const printer = spawn(host.executable ?? "hermes", ["--print-runtime-command", "--module", "types", "--", ...scriptArgs], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
      activeChild = printer;
      const queryTimer = setTimeout(() => fail("HARNESS_RUNTIME_TIMEOUT", "Hermes launcher resolution exceeded the host deadline"), Math.max(1, Math.min(10_000, deadline - performance.now())));
      const chunks: Buffer[] = [];
      printer.stdout.on("data", (chunk: Buffer) => {
        launcher!.stdoutBytes += chunk.length;
        if (failure !== undefined) return;
        if (launcher!.stdoutBytes > MAX_LAUNCHER_BYTES) fail("HARNESS_RUNTIME_BUDGET", "Hermes launcher output exceeded the host stream budget");
        else chunks.push(chunk);
      });
      printer.stderr.on("data", (chunk: Buffer) => {
        launcher!.stderrBytes += chunk.length;
        if (launcher!.stderrBytes > MAX_STDERR_BYTES) fail("HARNESS_RUNTIME_BUDGET", "Hermes launcher output exceeded the host stream budget");
      });
      printer.on("error", () => fail("HARNESS_RUNTIME_UNAVAILABLE", "Unable to resolve the installed Hermes runtime"));
      printer.on("close", (code) => {
        clearTimeout(queryTimer);
        if (failure === undefined) {
          try {
            const command = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
            if (code !== 0 || !runtimeCommand(command, scriptArgs)) throw new Error("Invalid launcher command");
            command[3] += "; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')";
            startRuntime(command);
            return;
          } catch { fail("HARNESS_RUNTIME_LAUNCHER", "Installed Hermes returned an unsupported runtime command"); }
        }
        finish(null);
      });
    }
  });
}
