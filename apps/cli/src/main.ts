#!/usr/bin/env node
import { verifyContractKit } from "./verify-contract-kit.js";
import { verifyV0Contracts } from "./verify-v0.js";

function usage(): never {
  throw new Error(
    "Usage: wmm contract-kit verify <kit-directory> | wmm v0 verify <kit-directory> <semantic-cases-file>",
  );
}

function main(): void {
  const [, , group, command, kitPath, semanticCasesPath] = process.argv;
  if (command !== "verify" || kitPath === undefined) usage();

  const report =
    group === "contract-kit"
      ? verifyContractKit(kitPath)
      : group === "v0" && semanticCasesPath !== undefined
        ? verifyV0Contracts(kitPath, semanticCasesPath)
        : usage();
  process.stdout.write(
    `${JSON.stringify({
      apiVersion: "wmm/dev-contract-verifier/1",
      outcome: "success",
      execution: "completed",
      data: report,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      apiVersion: "wmm/dev-contract-verifier/1",
      outcome: "error",
      execution: "completed",
      error: {
        code: "CONTRACT_VERIFICATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = 1;
}
