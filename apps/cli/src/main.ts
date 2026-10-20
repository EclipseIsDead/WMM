#!/usr/bin/env node

import { canonicalJson } from "@wmm/canonical";
import type { JsonValue } from "@wmm/wire-contracts";
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

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  wmm json < request.json",
      "  wmm contract-kit verify <kit-directory>",
      "  wmm v0 verify <kit-directory> <semantic-cases-file>",
      "  wmm seed validate <kit-directory>",
      "  wmm seed inspect <kit-directory> <identifier>",
      "  wmm seed export <kit-directory>",
      "  wmm world validate <bundle-directory>",
      "  wmm world inspect <bundle-directory> <identifier>",
      "  wmm world export <bundle-directory>",
    ].join("\n"),
  );
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

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "json") {
    const result = args.length === 1
      ? runJsonTransport(readJsonInput())
      : jsonTransportError("INVALID_REQUEST", "Usage: wmm json < request.json");
    writeJsonTransport(result);
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

try {
  main();
} catch (error) {
  if (process.argv[2] === "json") {
    writeJsonTransport(
      jsonTransportError("INTERNAL_ERROR", "Unable to read or process the JSON request"),
    );
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
}
