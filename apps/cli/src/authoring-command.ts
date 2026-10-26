import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { buildAuthoringProject, checkAuthoringProject, renderAuthoringNotes } from "@wmm/application";
import { MAX_AUTHORING_BYTES } from "@wmm/core";
import { authoringProjectSchema } from "@wmm/wire-contracts";
import { parseStrictJson, readJsonInput } from "./json-input.js";

function readProject(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_AUTHORING_BYTES) throw new Error("Authoring input must be a regular JSON file of at most 8 MiB");
    const bytes = readJsonInput(fd, MAX_AUTHORING_BYTES);
    if (bytes.length > MAX_AUTHORING_BYTES) throw new Error("Authoring input exceeds 8 MiB");
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
}

export function runAuthoringCommand(args: readonly string[]): unknown {
  const [group, command, path, flag, output] = args;
  if (group === "authoring" && command === "schema" && args.length === 2) return authoringProjectSchema;
  if (group === "authoring" && command === "check" && args.length === 3 && path) return checkAuthoringProject(readProject(path));
  if (flag === "--out" && output && path && args.length === 5) {
    if (group === "authoring" && command === "build") return buildAuthoringProject(readProject(path), output);
    if (group === "notes" && command === "render") return renderAuthoringNotes(path, output);
  }
  throw new Error("Usage: wmm authoring schema | wmm authoring check <project.json> | wmm authoring build <project.json> --out <new-directory> | wmm notes render <bundle-directory> --out <new-directory>");
}
