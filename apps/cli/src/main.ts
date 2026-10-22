#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { canonicalJson } from "@wmm/canonical";
import type { JsonValue } from "@wmm/wire-contracts";
import { validateApiRequest } from "@wmm/wire-contracts";
import { parseStrictJson, MAX_REQUEST_BYTES } from "./json-input.js";
import {
  exportSeedFixture,
  exportWorldBundle,
  inspectSeedFixture,
  inspectWorldBundle,
  loadBundledV1WorldBundle,
  loadSeedFixture,
  validateSeedFixture,
  validateWorldBundle,
} from "@wmm/exchange";

import { readJsonInput } from "./json-input.js";
import {
  jsonTransportError,
  runJsonTransport,
  serializeJsonTransportResult,
  type JsonTransportResult,
} from "./json-transport.js";
import { verifyContractKit } from "./verify-contract-kit.js";
import { verifyV0Contracts } from "./verify-v0.js";

function helpText(): string {
  return [
      "Usage:",
      "  wmm --version",
      "  wmm --help",
      "  wmm json [--workspace-dir <directory>] < request.json",
      "  wmm workspace demo --workspace-dir <directory>",
      "  wmm workspace open <bundle-directory> --workspace-dir <directory>",
      "  wmm workspace resume --workspace-dir <directory> [--plain | --json]",
      "  wmm contract-kit verify <kit-directory>",
      "  wmm v0 verify <kit-directory> <semantic-cases-file>",
      "  wmm seed validate <kit-directory>",
      "  wmm seed inspect <kit-directory> <identifier>",
      "  wmm seed export <kit-directory>",
      "  wmm world validate <bundle-directory>",
      "  wmm world inspect <bundle-directory> <identifier>",
      "  wmm world export <bundle-directory>",
    ].join("\n");
}

function usage(): never {
  throw new Error(helpText());
}

function execute(args: readonly string[]): unknown {
  const [group, command, first, second] = args;
  if (group === "contract-kit" && command === "verify" && first !== undefined) {
    return verifyContractKit(first);
  }
  if (
    group === "v0" &&
    command === "verify" &&
    first !== undefined &&
    second !== undefined
  ) {
    return verifyV0Contracts(first, second);
  }
  if (group === "seed" && first !== undefined) {
    const fixture = loadSeedFixture(first);
    if (command === "validate") return validateSeedFixture(fixture);
    if (command === "export") return exportSeedFixture(fixture);
    if (command === "inspect" && second !== undefined) {
      const record = inspectSeedFixture(fixture, second);
      if (record === undefined) throw new Error(`Unknown seed fixture record: ${second}`);
      return record;
    }
  }
  if (group === "world" && first !== undefined) {
    const world = loadBundledV1WorldBundle(first);
    if (command === "validate") return validateWorldBundle(world);
    if (command === "export") return exportWorldBundle(world);
    if (command === "inspect" && second !== undefined) {
      const record = inspectWorldBundle(world, second);
      if (record === undefined) throw new Error(`Unknown world record: ${second}`);
      return record;
    }
  }
  return usage();
}

function writeJson(value: unknown): void {
  process.stdout.write(`${canonicalJson(value as JsonValue)}\n`);
}

function writeJsonTransport(result: JsonTransportResult): void {
  const serialized = serializeJsonTransportResult(result);
  process.stdout.write(serialized.output);
  process.exitCode = serialized.exitCode;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (args[0] === "workspace") {
    const { runWorkspaceCommand } = await import("./workspace-command.js");
    await runWorkspaceCommand(args.slice(1));
    return;
  }
  if (args[0] === "json") {
    if (args.length !== 1 && !(args.length === 3 && args[1] === "--workspace-dir" && args[2])) {
      writeJsonTransport(jsonTransportError("INVALID_REQUEST", "Usage: wmm json [--workspace-dir <directory>] < request.json"));
      return;
    }
    const bytes = readJsonInput();
    let request: unknown;
    if (args[2] !== undefined && bytes.length <= MAX_REQUEST_BYTES) {
      try { request = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { /* The transport returns the original parse diagnostic. */ }
    }
    if (args[2] !== undefined && validateApiRequest(request).valid && request !== null && typeof request === "object" &&
      "operation" in request && typeof request.operation === "string" && request.operation.startsWith("workspace.")) {
      const { openWorkspaceRuntime, assertSeparateWorkspaceDirectory } = await import("./workspace-command.js");
      try {
        if (request.operation === "workspace.create" && "payload" in request) {
          assertSeparateWorkspaceDirectory(args[2], (request.payload as { bundlePath: string }).bundlePath);
        }
        const runtime = openWorkspaceRuntime(args[2], request.operation === "workspace.create");
        try { writeJsonTransport(runJsonTransport(bytes, runtime.services)); } finally { runtime.close(); }
      } catch (error) {
        writeJsonTransport(jsonTransportError("STORAGE_FAILURE", error instanceof Error ? error.message : "Unable to open workspace storage",
          "requestId" in request && typeof request.requestId === "string" ? request.requestId : null, request.operation));
      }
    } else writeJsonTransport(runJsonTransport(bytes));
    return;
  }

  const data = execute(args);
  writeJson({
    apiVersion: "wmm/dev/1",
    outcome: "success",
    execution: "completed",
    data,
  });
}

void main().catch(async (error: unknown) => {
  if (process.argv[2] === "json") {
    writeJsonTransport(
      jsonTransportError("INTERNAL_ERROR", "Unable to read or process the JSON request"),
    );
  } else if (process.argv[2] === "workspace") {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) writeJsonTransport(jsonTransportError("INVALID_REQUEST", message));
    else {
      const { terminalText } = await import("./workspace/text.js");
      process.stderr.write(`WMM: ${terminalText(message)}\n`);
      process.exitCode = 1;
    }
  } else {
    writeJson({
      apiVersion: "wmm/dev/1",
      outcome: "error",
      execution: "completed",
      error: {
        code: "DEVELOPMENT_COMMAND_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  }
});
