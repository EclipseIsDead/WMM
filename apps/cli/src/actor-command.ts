import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { prepareActorContext, reviewActorDraft } from "@wmm/application";
import { ActorWorkflowError, MAX_ACTOR_INPUT_BYTES } from "@wmm/core";
import { actorWorkflowSchema } from "@wmm/wire-contracts";

import { parseStrictJson, readJsonInput } from "./json-input.js";

const USAGE = "Usage: wmm actor schema | wmm actor prepare <bundle-directory> <brief.json> | wmm actor review <bundle-directory> <brief.json> <decision.json> [--out <new-directory>]";
function readActorJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ACTOR_INPUT_BYTES) throw new Error("Actor input must be a regular JSON file of at most 262144 bytes");
    const bytes = readJsonInput(fd, MAX_ACTOR_INPUT_BYTES);
    if (bytes.length > MAX_ACTOR_INPUT_BYTES) throw new Error("Actor input exceeds 262144 bytes");
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
}
export function runActorCommand(args: readonly string[]): unknown {
  if (args.length === 1 && args[0] === "schema") return actorWorkflowSchema;
  const [command, bundle, briefPath] = args;
  if (command === "prepare" && args.length === 3 && bundle && briefPath && !bundle.startsWith("--") && !briefPath.startsWith("--")) return prepareActorContext(bundle, readActorJson(briefPath));
  const decision = args[3];
  if (command === "review" && bundle && briefPath && decision && ![bundle, briefPath, decision].some((path) => path.startsWith("--")) && (args.length === 4 || (args.length === 6 && args[4] === "--out" && args[5] && !args[5].startsWith("--")))) {
    return reviewActorDraft(bundle, readActorJson(briefPath), readActorJson(decision), args[5]);
  }
  throw new ActorWorkflowError("INVALID_ACTOR_COMMAND", USAGE);
}
