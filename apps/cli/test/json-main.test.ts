import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "@wmm/canonical";
import { validateApiResponse, type JsonValue } from "@wmm/wire-contracts";
import { MAX_REQUEST_BYTES } from "../src/json-input.js";

const mainUrl = new URL("../src/main.ts", import.meta.url).href;
const bundlePath = fileURLToPath(new URL("../../../fixtures/v1/complete-world/", import.meta.url));
const request = {
  format: "wmm.request/1",
  apiVersion: "wmm/1",
  requestId: "spawn-1",
  operation: "world.validate",
  payload: { bundlePath },
};

interface SpawnResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeJson(
  input: Uint8Array,
  options: {
    readonly keepStdinOpen?: boolean;
    readonly args?: readonly string[];
    readonly failure?: "read" | "serialization";
  } = {},
): Promise<SpawnResult> {
  // Run the current CLI source with Node's native type stripping, remapping
  // only its relative .js imports. No shared build artifacts are overwritten.
  const bootstrap = `
    import fs from "node:fs";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import { fileURLToPath } from "node:url";
    const entry = new URL(${JSON.stringify(mainUrl)});
    const directory = new URL(".", entry).href;
    const failure = ${JSON.stringify(options.failure ?? null)};
    if (failure === "read") {
      const read = fs.readSync;
      fs.readSync = (fd, ...args) => {
        if (fd === 0) throw new Error("Injected stdin read failure");
        return read(fd, ...args);
      };
      syncBuiltinESMExports();
    }
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(directory)) {
          if (specifier.startsWith("./") && specifier.endsWith(".js")) {
            return nextResolve(specifier.slice(0, -3) + ".ts", context);
          }
          if (failure === "serialization" && specifier === "@wmm/application") {
            const real = nextResolve(specifier, context);
            const source = 'import { apiErrorResponse } from ' + JSON.stringify(real.url) + ';'
              + 'export { apiErrorResponse };'
              + 'export function executeApiRequest(request) {'
              + 'return apiErrorResponse("INVALID_WORLD", String.fromCharCode(0xd800), request.requestId, request.operation); }';
            return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
          }
        }
        return nextResolve(specifier, context);
      },
    });
    process.argv = [process.execPath, fileURLToPath(entry), ...process.argv.slice(1)];
    await import(entry.href);
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--no-warnings", "--input-type=module", "--eval", bootstrap, "--",
      ...options.args ?? ["json"],
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.stdin.destroy();
      child.kill("SIGKILL");
      reject(new Error(`JSON CLI did not exit within 5 seconds; stderr: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      child.stdin.destroy();
      child.kill("SIGKILL");
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      child.stdin.destroy();
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Early rejection can close the pipe before a pending write completes.
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
        clearTimeout(timeout);
        child.stdin.destroy();
        child.kill("SIGKILL");
        reject(error);
      }
    });
    if (options.keepStdinOpen === true) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

function expectProtocolResponse(result: SpawnResult, exitCode: number): unknown {
  expect(result.code).toBe(exitCode);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n")).toHaveLength(2);
  const response: unknown = JSON.parse(result.stdout);
  expect(response).toMatchObject({ format: "wmm.response/1", apiVersion: "wmm/1" });
  expect(validateApiResponse(response).valid).toBe(true);
  expect(result.stdout).toBe(`${canonicalJson(response as JsonValue)}\n`);
  return response;
}

describe("CLI product information", () => {
  it("reports the product prerelease without reading stdin", async () => {
    const result = await invokeJson(new Uint8Array(), { args: ["--version"], keepStdinOpen: true });
    expect(result).toEqual({ code: 0, stdout: "0.1.0-alpha.1\n", stderr: "" });
  });

  it.each(["--help", "-h"])("prints %s successfully without reading stdin", async (flag) => {
    const result = await invokeJson(new Uint8Array(), { args: [flag], keepStdinOpen: true });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("wmm workspace demo");
    expect(result.stdout).toContain("wmm workspace review");
    expect(result.stdout).toContain("wmm --version");
  });
});

describe("JSON CLI process boundary", () => {
  it("rejects the first byte over 1 MiB and exits while stdin is still open", async () => {
    const result = await invokeJson(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20), { keepStdinOpen: true });
    expect(expectProtocolResponse(result, 2)).toMatchObject({
      requestId: null,
      operation: null,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("transport limit") },
    });
  }, 7_000);

  it("accepts a request exactly at the byte limit", async () => {
    const input = Buffer.alloc(MAX_REQUEST_BYTES, 0x20);
    input.write(JSON.stringify(request), "utf8");
    const result = await invokeJson(input);
    expect(expectProtocolResponse(result, 0)).toMatchObject({
      requestId: "spawn-1",
      operation: "world.validate",
      outcome: "success",
    });
  }, 7_000);

  it.each(["requestId", "operation", "apiVersion", "bundlePath"])(
    "rejects escaped lone surrogates in %s with a protocol error, not development output",
    async (field) => {
      for (const value of ["\ud800", "\udfff"]) {
        const malformed = field === "bundlePath"
          ? { ...request, apiVersion: "wmm/2", payload: { bundlePath: value } }
          : { ...request, [field]: value };
        const result = await invokeJson(Buffer.from(JSON.stringify(malformed)));
        expect(expectProtocolResponse(result, 2)).toMatchObject({
          requestId: null,
          operation: null,
          error: { code: "INVALID_REQUEST", message: expect.stringContaining("Unicode scalar") },
        });
      }
    },
    12_000,
  );

  it("rejects a non-scalar JSON property name", async () => {
    const result = await invokeJson(Buffer.from('{"\\ud800":"bad key"}'));
    expect(expectProtocolResponse(result, 2)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  }, 7_000);

  it("rejects malformed UTF-8 with a canonical protocol response", async () => {
    const result = await invokeJson(Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]));
    expect(expectProtocolResponse(result, 2)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  }, 7_000);

  it("keeps JSON argument errors in the request-error exit class without reading stdin", async () => {
    const result = await invokeJson(Buffer.alloc(0), { keepStdinOpen: true, args: ["json", "extra"] });
    expect(expectProtocolResponse(result, 2)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  }, 7_000);

  it("maps stdin I/O errors to the internal-failure exit class", async () => {
    const result = await invokeJson(Buffer.alloc(0), { keepStdinOpen: true, failure: "read" });
    expect(expectProtocolResponse(result, 4)).toMatchObject({
      execution: "incomplete",
      error: { code: "INTERNAL_ERROR" },
    });
  }, 7_000);

  it("maps response serialization errors to a single V1 internal-error response", async () => {
    const result = await invokeJson(Buffer.from(JSON.stringify(request)), { failure: "serialization" });
    expect(expectProtocolResponse(result, 4)).toMatchObject({
      requestId: "spawn-1",
      operation: "world.validate",
      execution: "incomplete",
      error: { code: "INTERNAL_ERROR" },
    });
  }, 7_000);
});
