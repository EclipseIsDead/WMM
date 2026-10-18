#!/usr/bin/env node
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

import { verifyContractKit } from "./verify-contract-kit.js";
import { verifyV0Contracts } from "./verify-v0.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
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

function main(): void {
  const data = execute(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({
      apiVersion: "wmm/dev/1",
      outcome: "success",
      execution: "completed",
      data,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      apiVersion: "wmm/dev/1",
      outcome: "error",
      execution: "completed",
      error: {
        code: "DEVELOPMENT_COMMAND_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = 1;
}
