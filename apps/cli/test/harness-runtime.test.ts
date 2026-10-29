import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeUrl = new URL("../src/harness-runtime.js", import.meta.url).href;
const peer = fileURLToPath(new URL("./helpers/harness-runtime-child.mjs", import.meta.url));
const scriptedLauncher = fileURLToPath(new URL("./helpers/harness-scripted-launcher.mjs", import.meta.url));
function launcher(root: string, scenario = "success"): string {
  const executable = join(root, "hermes-scripted-launcher.mjs");
  copyFileSync(scriptedLauncher, executable);
  chmodSync(executable, 0o700);
  writeFileSync(join(root, "launcher-control.json"), JSON.stringify({ scenario }), { flag: "wx", mode: 0o600 });
  return executable;
}
const toolNames = ["wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit"];
const canary = "SELECTED_SOURCE_CANARY_NOT_FOR_UNSCOPED_RUNTIME";

function session(root: string) {
  let disclosures = 0;
  return {
    runId: "synthetic-run", attemptId: "attempt-1", attemptDirectory: root,
    tools: () => toolNames.map((name) => ({ name, description: "Public offline test tool", parameters: { type: "object", properties: {}, additionalProperties: false } })),
    startMessage: () => { disclosures += 1; return canary; },
    call: () => { throw new Error("No WMM call is permitted before runtime admission"); },
    disclosures: () => disclosures,
  };
}

describe("bounded DM harness runtime host", () => {
  it.each(["success", "maintenance"])("resolves the official isolated command before executing the fixed script bootstrap (scripted peers): %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      const executable = launcher(root, scenario);
      const options = { model: "offline;$(NOT_A_SHELL)", provider: "offline-test" };
      await runDmHarnessAgent(host, options, { executable, timeoutMs: 3000 });
      const adapter = fileURLToPath(new URL("../../../tools/harness/hermes_adapter.py", import.meta.url));
      const scriptArgs = [adapter, "--model", options.model, "--provider", options.provider];
      const query = JSON.parse(readFileSync(join(root, "launcher-query.json"), "utf8"));
      expect(query).toEqual({ args: ["--print-runtime-command", "--module", "types", "--", ...scriptArgs], cwd: join(root, "runtime"), safeMode: "1", environmentHint: "" });
      const execution = JSON.parse(readFileSync(join(root, "launcher-runtime.json"), "utf8"));
      expect(execution.args.slice(0, 2)).toEqual(["-I", "-c"]);
      expect(execution.args.slice(3)).toEqual(scriptArgs);
      expect(execution.args[2]).toContain("import hermes_bootstrap; ");
      expect(execution.args[2].endsWith("; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')")).toBe(true);
      expect(execution.safeMode).toBe("1");
      expect(execution.cwd).toBe(join(root, "runtime"));
      expect(host.disclosures()).toBe(1);
      const frames = readFileSync(join(root, "launcher-input.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(frames.map((frame) => frame.type)).toEqual(["initialize", "start"]);
      expect(frames[1].userMessage).toBe(canary);
      const text = readFileSync(join(root, "runtime", "runtime.json"), "utf8");
      expect(JSON.parse(text)).toMatchObject({ status: "completed", sessionId: "scripted-launcher-session", launcher: { stderrBytes: scenario === "maintenance" ? Buffer.byteLength("PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY\n") : 0 } });
      expect(text).not.toContain("PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("supports a host-only adapter path without adding a model or CLI executable capability (scripted)", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const adapterPath = join(root, "synthetic stdlib;peer.py");
      const controls = { executable: launcher(root), adapterPath, timeoutMs: 3000 };
      await runDmHarnessAgent(session(root), {}, controls);
      expect(JSON.parse(readFileSync(join(root, "launcher-query.json"), "utf8")).args).toEqual(["--print-runtime-command", "--module", "types", "--", adapterPath]);
      expect(JSON.parse(readFileSync(join(root, "launcher-runtime.json"), "utf8")).args.slice(3)).toEqual([adapterPath]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "not-array", "extra-argument", "wrong-type", "non-isolated", "wrong-code-flag", "relative-python", "empty-python", "control-python", "long-python",
    "argument-mismatch", "non-scalar", "wrong-module", "extra-code", "missing-bootstrap", "expression-root", "relative-root", "control-code", "long-code",
  ])("rejects unsupported launcher commands before spawning or task disclosure (scripted): %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      await expect(runDmHarnessAgent(host, {}, { executable: launcher(root, scenario), timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_LAUNCHER", message: "Installed Hermes returned an unsupported runtime command" });
      expect(host.disclosures()).toBe(0);
      expect(existsSync(join(root, "launcher-runtime.json"))).toBe(false);
      expect(existsSync(join(root, "launcher-input.jsonl"))).toBe(false);
      const report = JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"));
      expect(report).toMatchObject({ status: "failed", toolCalls: 0, error: { code: "HARNESS_RUNTIME_LAUNCHER" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["malformed-json", "invalid-utf8", "bom", "trailing-json", "nonzero"])("rejects an invalid printer result with a static retained report (scripted): %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      await expect(runDmHarnessAgent(host, {}, { executable: launcher(root, scenario), timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_LAUNCHER", message: "Installed Hermes returned an unsupported runtime command" });
      expect(host.disclosures()).toBe(0);
      expect(existsSync(join(root, "launcher-runtime.json"))).toBe(false);
      expect(existsSync(join(root, "launcher-input.jsonl"))).toBe(false);
      const text = readFileSync(join(root, "runtime", "runtime.json"), "utf8");
      const report = JSON.parse(text);
      expect(report).toMatchObject({ status: "failed", toolCalls: 0, error: { code: "HARNESS_RUNTIME_LAUNCHER" } });
      expect(report.launcher.stdoutBytes).toBeGreaterThan(0);
      expect(report.launcher.stderrBytes).toBe(scenario === "nonzero" ? Buffer.byteLength("PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY\n") : 0);
      expect(text).not.toContain("PRIVATE_LAUNCHER");
      expect(text).not.toContain(canary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["stdout-budget", "stderr-budget"])("bounds launcher query streams and retains only static failure metadata (scripted): %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      await expect(runDmHarnessAgent(host, {}, { executable: launcher(root, scenario), timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_BUDGET", message: "Hermes launcher output exceeded the host stream budget" });
      expect(host.disclosures()).toBe(0);
      expect(existsSync(join(root, "launcher-runtime.json"))).toBe(false);
      const text = readFileSync(join(root, "runtime", "runtime.json"), "utf8");
      const report = JSON.parse(text);
      expect(report).toMatchObject({ status: "failed", stdoutBytes: 0, stderrBytes: 0, toolCalls: 0, error: { code: "HARNESS_RUNTIME_BUDGET" } });
      expect(report.launcher[scenario === "stdout-budget" ? "stdoutBytes" : "stderrBytes"]).toBeGreaterThan(64 * 1024);
      expect(text).not.toContain("PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY");
      expect(text).not.toContain(canary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds a stalled launcher query independently and escalates termination (scripted)", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    let safety: ReturnType<typeof setTimeout> | undefined;
    function killPrinter(): void {
      if (!existsSync(join(root, "launcher.pid"))) return;
      try { process.kill(Number(readFileSync(join(root, "launcher.pid"), "utf8")), "SIGKILL"); } catch { /* Already reaped. */ }
    }
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      const invocation = runDmHarnessAgent(host, {}, { executable: launcher(root, "query-hang"), timeoutMs: 30_000 });
      const watchdog = new Promise<never>((_resolve, reject) => {
        safety = setTimeout(() => { killPrinter(); reject(new Error("Launcher query did not honor its independent bound")); }, 12_500);
      });
      await expect(Promise.race([invocation, watchdog])).rejects.toMatchObject({ code: "HARNESS_RUNTIME_TIMEOUT", message: "Hermes launcher resolution exceeded the host deadline" });
      expect(host.disclosures()).toBe(0);
      expect(existsSync(join(root, "launcher-runtime.json"))).toBe(false);
      expect(readFileSync(join(root, "launcher-signals.jsonl"), "utf8")).toBe("SIGTERM\n");
      const pid = Number(readFileSync(join(root, "launcher.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"))).toMatchObject({ status: "failed", toolCalls: 0, launcher: { stdoutBytes: 0, stderrBytes: 0 }, error: { code: "HARNESS_RUNTIME_TIMEOUT" } });
    } finally { clearTimeout(safety); killPrinter(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("charges launcher resolution and runtime startup to one overall deadline (scripted)", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      await expect(runDmHarnessAgent(host, {}, { executable: launcher(root, "shared-deadline"), timeoutMs: 2400 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_TIMEOUT", message: "Hermes runtime exceeded the host deadline" });
      expect(existsSync(join(root, "launcher-runtime.json"))).toBe(true);
      const frames = readFileSync(join(root, "launcher-input.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(frames.map((frame) => frame.type)).toEqual(["initialize"]);
      expect(host.disclosures()).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"))).toMatchObject({ status: "failed", toolCalls: 0, error: { code: "HARNESS_RUNTIME_TIMEOUT" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains a static failure when the official printer cannot be started", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-launcher-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      await expect(runDmHarnessAgent(host, {}, { executable: join(root, "missing-hermes"), timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_UNAVAILABLE", message: "Unable to resolve the installed Hermes runtime" });
      expect(host.disclosures()).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"))).toMatchObject({ status: "failed", launcher: { stdoutBytes: 0, stderrBytes: 0 }, error: { code: "HARNESS_RUNTIME_UNAVAILABLE" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a broader runtime toolset before disclosing selected input", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      // Import inside the test: an intentionally absent new runtime symbol is
      // a behavioral RED, not a zero-tests-executed package startup failure.
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      const captured = join(root, "peer-input.jsonl");
      await expect(runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, "ambient-tools", captured], timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_POLICY" });
      expect(host.disclosures()).toBe(0);
      const frames = readFileSync(captured, "utf8");
      expect(JSON.parse(frames.trim()).type).toBe("initialize");
      expect(frames).not.toContain(canary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["success", "reordered-tools"])("admits the same exact tool set and retains the transcript: %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const base = session(root);
      const calls: { name: string; args: unknown }[] = [];
      const host = { ...base, call: (name: string, args: unknown) => { calls.push({ name, args }); return { status: "read", synthetic: true }; } };
      const captured = join(root, "peer-input.jsonl");
      await runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, scenario, captured], timeoutMs: 3000 });
      expect(base.disclosures()).toBe(1);
      expect(calls).toEqual([{ name: "wmm_project_read", args: {} }]);
      const frames = readFileSync(captured, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(frames.map((frame) => frame.type)).toEqual(["initialize", "start", "tool_result"]);
      expect(frames[1].userMessage).toBe(canary);
      expect(frames[2].result).toEqual({ status: "read", synthetic: true });
      const report = JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"));
      expect(report).toMatchObject({ status: "completed", toolCalls: 1, sessionId: "synthetic-offline-session" });
      expect(JSON.parse(readFileSync(join(root, "runtime", "conversation.json"), "utf8"))).toEqual([{ role: "tool", content: '{"status":"read","synthetic":true}' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["contextFiles", "memory", "skills", "soul", "externalTools", "contextEngine"])("rejects ambient %s before source disclosure", async (field) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      const captured = join(root, "peer-input.jsonl");
      await expect(runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, `ambient-${field}`, captured], timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_POLICY" });
      expect(host.disclosures()).toBe(0);
      expect(readFileSync(captured, "utf8")).not.toContain(canary);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ["ready-extra", "HARNESS_RUNTIME_POLICY"],
    ["ready-runtime-extra", "HARNESS_RUNTIME_POLICY"],
    ["ready-runtime-adapter", "HARNESS_RUNTIME_POLICY"],
    ["tool-extra", "HARNESS_RUNTIME_PROTOCOL"],
    ["tool-id", "HARNESS_RUNTIME_PROTOCOL"],
    ["tool-args", "HARNESS_RUNTIME_PROTOCOL"],
    ["complete-extra", "HARNESS_RUNTIME_PROTOCOL"],
    ["complete-history", "HARNESS_RUNTIME_PROTOCOL"],
    ["trailing", "HARNESS_RUNTIME_PROTOCOL"],
  ])("rejects non-contract protocol data: %s", async (scenario, code) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      let calls = 0;
      const base = session(root);
      const host = { ...base, call: () => { calls += 1; return {}; } };
      const captured = join(root, "peer-input.jsonl");
      await expect(runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, scenario!, captured], timeoutMs: 3000 })).rejects.toMatchObject({ code });
      expect(calls).toBe(0);
      if (scenario!.startsWith("ready-")) {
        expect(base.disclosures()).toBe(0);
        expect(readFileSync(captured, "utf8")).not.toContain(canary);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["frame-budget", "argument-budget", "result-budget", "total-result-budget", "call-budget", "stderr-budget", "stdout-budget"])("enforces the independent host %s", async (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      let calls = 0;
      const base = session(root);
      const host = { ...base, call: () => {
        calls += 1;
        if (scenario === "result-budget") return { text: "λ".repeat(256 * 1024 + 1) };
        if (scenario === "total-result-budget") return { text: "x".repeat(400 * 1024) };
        return {};
      } };
      const captured = join(root, "peer-input.jsonl");
      // The large stdout stream tests byte accounting, not three-second
      // throughput under concurrent CLI load; the watchdog has its own test.
      const timeoutMs = scenario === "stdout-budget" ? 8000 : 3000;
      await expect(runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, scenario, captured], timeoutMs })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_BUDGET" });
      const frames = readFileSync(captured, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      if (scenario === "frame-budget" || scenario === "argument-budget") expect(calls).toBe(0);
      if (scenario === "result-budget") expect(frames.some((frame) => frame.type === "tool_result")).toBe(false);
      if (scenario === "call-budget") expect(calls).toBe(32);
      if (scenario === "total-result-budget") expect(frames.filter((frame) => frame.type === "tool_result")).toHaveLength(5);
      if (scenario === "stdout-budget") {
        const report = JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"));
        expect(report.stdoutBytes).toBeGreaterThan(24 * 1024 * 1024);
        expect(calls).toBe(12);
        expect(frames.filter((frame) => frame.type === "tool_result")).toHaveLength(12);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 10_000);
  it("retains a static runtime failure without copying secret-bearing diagnostics", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const host = session(root);
      const captured = join(root, "peer-input.jsonl");
      await expect(runDmHarnessAgent(host, {}, { executable: process.execPath, args: [peer, "runtime-error", captured], timeoutMs: 3000 })).rejects.toMatchObject({ code: "HARNESS_RUNTIME_FAILED" });
      expect(host.disclosures()).toBe(0);
      const text = readFileSync(join(root, "runtime", "runtime.json"), "utf8");
      expect(JSON.parse(text)).toMatchObject({ status: "failed", toolCalls: 0, error: { code: "HARNESS_RUNTIME_FAILED", runtimeCode: "AUTH_REQUIRED" } });
      expect(JSON.parse(text).stderrBytes).toBe(Buffer.byteLength("PRIVATE_DIAGNOSTIC_CANARY\n"));
      expect(text).not.toContain("PRIVATE_DIAGNOSTIC_CANARY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["stdin-closed-complete", "stdin-closed-ignore-termination"])("latches a real child-stdin EPIPE before later tools or completion: %s", (scenario) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    const captured = join(root, "peer-input.jsonl");
    try {
      // Observe native spawn/stream events in a separate driver; no fabricated
      // error, mocked write, SDK, launcher or model is involved.
      const script = `
        import cp from "node:child_process";
        import { once } from "node:events";
        import { syncBuiltinESMExports } from "node:module";
        const [moduleUrl, peer, scenario, root, captured] = process.argv.slice(1);
        const nativeSpawn = cp.spawn;
        const unrelated = nativeSpawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        const sequence = [];
        const stdinErrors = [];
        let owned;
        cp.spawn = (...args) => {
          const child = nativeSpawn(...args);
          owned = child;
          child.stdin.on("error", error => { stdinErrors.push(error.code); sequence.push("stdin-error:" + error.code); });
          let pending = "";
          child.stdout.on("data", chunk => {
            pending += chunk.toString("utf8");
            let newline;
            while ((newline = pending.indexOf("\\n")) >= 0) {
              const frame = JSON.parse(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
              sequence.push(frame.type + (frame.type === "tool_call" ? ":" + frame.id : ""));
            }
          });
          return child;
        };
        syncBuiltinESMExports();
        const { runDmHarnessAgent } = await import(moduleUrl);
        const calls = [];
        let disclosures = 0;
        let outcome;
        const result = { text: "SYNTHETIC_TOOL_RESULT_CANARY" + "x".repeat(400 * 1024) };
        const safety = setTimeout(() => owned?.kill("SIGKILL"), 4500);
        try {
          try {
            await runDmHarnessAgent({
              runId: "synthetic-run", attemptId: "attempt-1", attemptDirectory: root,
              tools: () => ${JSON.stringify(toolNames)}.map(name => ({ name, description: "Public offline test tool", parameters: { type: "object", properties: {}, additionalProperties: false } })),
              startMessage: () => { disclosures++; return ${JSON.stringify(canary)}; },
              call: name => { calls.push(name); return result; },
            }, {}, { executable: process.execPath, args: [peer, scenario, captured], timeoutMs: 3000 });
            outcome = { type: "resolved" };
          } catch (error) { outcome = { type: "rejected", code: error.code, message: error.message }; }
          let unrelatedAlive = false;
          try { process.kill(unrelated.pid, 0); unrelatedAlive = true; } catch {}
          console.log(JSON.stringify({ outcome, stdinErrors, sequence, calls, disclosures, unrelatedAlive, pid: owned.pid, exitCode: owned.exitCode, signalCode: owned.signalCode, resultBytes: Buffer.byteLength(JSON.stringify(result)) }));
        } finally {
          clearTimeout(safety);
          owned?.kill("SIGKILL");
          const closed = once(unrelated, "close");
          unrelated.kill("SIGKILL");
          await closed;
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, "--",
        new URL("../dist/harness-runtime.js", import.meta.url).href, peer, scenario, root, captured], { encoding: "utf8", timeout: 6000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const observed = JSON.parse(result.stdout);
      expect(observed.stdinErrors).toEqual(["EPIPE"]);
      expect(observed.sequence).toEqual(["ready", "tool_call:1", "stdin-error:EPIPE", "tool_call:2", "complete"]);
      expect(observed.outcome).toEqual({ type: "rejected", code: "HARNESS_RUNTIME_PROTOCOL", message: "Unable to write to the Hermes runtime" });
      expect(observed.calls).toEqual(["wmm_project_read"]);
      expect(observed.disclosures).toBe(1);
      expect(observed.unrelatedAlive).toBe(true);
      expect(() => process.kill(observed.pid, 0)).toThrow();
      expect({ code: observed.exitCode, signal: observed.signalCode }).toEqual(scenario === "stdin-closed-complete" ? { code: 0, signal: null } : { code: null, signal: "SIGKILL" });
      expect(readFileSync(`${captured}.signals`, "utf8")).toBe("SIGTERM\n");
      const text = readFileSync(join(root, "runtime", "runtime.json"), "utf8");
      const report = JSON.parse(text);
      expect(report).toMatchObject({ format: "wmm.dm-harness-runtime/1", status: "failed", toolCalls: 1, resultBytes: observed.resultBytes });
      expect(report.error).toEqual({ code: "HARNESS_RUNTIME_PROTOCOL" });
      expect(Object.keys(report).sort()).toEqual(["error", "format", "resultBytes", "status", "stderrBytes", "stdoutBytes", "toolCalls"]);
      expect(existsSync(join(root, "runtime", "conversation.json"))).toBe(false);
      for (const raw of [canary, "SYNTHETIC_TOOL_RESULT_CANARY", "SYNTHETIC_LATE_COMPLETION_CANARY", "EPIPE", "stack"]) expect(text).not.toContain(raw);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 10_000);

  it("terminates an owned runtime that ignores the deadline's first signal", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "wmm-harness-runtime-"));
    const captured = join(root, "peer-input.jsonl");
    let safety: ReturnType<typeof setTimeout> | undefined;
    function killPeer(): void {
      if (!existsSync(`${captured}.pid`)) return;
      const pid = Number(readFileSync(`${captured}.pid`, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    }
    try {
      const { runDmHarnessAgent } = await import(runtimeUrl);
      const invocation = runDmHarnessAgent(session(root), {}, { executable: process.execPath, args: [peer, "ignore-termination", captured], timeoutMs: 500 });
      const failedWatchdog = new Promise<never>((_resolve, reject) => {
        safety = setTimeout(() => { killPeer(); reject(new Error("The host watchdog did not terminate its owned peer")); }, 2500);
      });
      await expect(Promise.race([invocation, failedWatchdog])).rejects.toMatchObject({ code: "HARNESS_RUNTIME_TIMEOUT" });
      expect(JSON.parse(readFileSync(join(root, "runtime", "runtime.json"), "utf8"))).toMatchObject({ status: "failed", error: { code: "HARNESS_RUNTIME_TIMEOUT" } });
    } finally { clearTimeout(safety); killPeer(); rmSync(root, { recursive: true, force: true }); }
  });
});
