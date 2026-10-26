import { getEntityContext } from "@wmm/application";
import { EntityContextError } from "@wmm/core";
import { entityContextPacketSchema } from "@wmm/wire-contracts";

const USAGE = "Usage: wmm context schema | wmm context entity <bundle-directory> <entity-id> [--campaign <campaign-id>] [--max-bytes <integer>] [--max-items <integer>]";
function invalid(message = USAGE): never { throw new EntityContextError("INVALID_CONTEXT_REQUEST", message); }
function integer(value: string, flag: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(`Invalid integer for ${flag}`);
  return Number(value);
}

export function runEntityContextCommand(args: readonly string[]): unknown {
  const [command, bundlePath, entityId, ...options] = args;
  if (command === "schema" && args.length === 1) return entityContextPacketSchema;
  if (command !== "entity" || !bundlePath || !entityId || bundlePath.startsWith("--") || entityId.startsWith("--")) invalid();
  let campaignId: string | undefined;
  const limits: { maxBytes?: number; maxItems?: number } = {};
  const seen = new Set<string>();
  for (let position = 0; position < options.length; position += 2) {
    const flag = options[position]!;
    const value = options[position + 1];
    if (seen.has(flag)) invalid(`Duplicate context option: ${flag}`);
    seen.add(flag);
    if (value === undefined || value.startsWith("--")) invalid(`Missing value for context option: ${flag}`);
    if (flag === "--campaign") campaignId = value;
    else if (flag === "--max-bytes") limits.maxBytes = integer(value, flag);
    else if (flag === "--max-items") limits.maxItems = integer(value, flag);
    else invalid(`Unknown context option: ${flag}`);
  }
  return getEntityContext(bundlePath, { entityId, limits, ...(campaignId === undefined ? {} : { campaignId }) });
}
