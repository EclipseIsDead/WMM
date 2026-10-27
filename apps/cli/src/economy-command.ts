import { readSnapshotEconomy } from "@wmm/application";
import type { EconomyView } from "@wmm/wire-contracts";

export function runEconomyCommand(args: readonly string[]): { readonly data: EconomyView; readonly json: boolean } {
  const [command, bundlePath, flag, ...extra] = args;
  if (command !== "inspect" || !bundlePath || bundlePath.startsWith("--") || (flag !== undefined && flag !== "--json") || extra.length) {
    throw new Error("Usage: wmm economy inspect <bundle-directory> [--json]");
  }
  return { data: readSnapshotEconomy(bundlePath), json: flag === "--json" };
}
