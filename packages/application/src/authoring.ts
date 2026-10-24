import { resolve } from "node:path";
import { compileAuthoringProject } from "@wmm/core";
import {
  buildAuthoringBundle, loadReleaseWorldBundle, readAuthoringIndex, renderDmNotes, validateWorldBundle, writeDmNotes,
} from "@wmm/exchange";

/** Fresh snapshot construction, not approval, canonical acceptance, or a workspace commit. */
export function checkAuthoringProject(input: unknown) {
  const compiled = compileAuthoringProject(input);
  return {
    format: "wmm.authoring-check/1" as const, status: "valid" as const,
    worldId: compiled.snapshot.manifest.worldId, snapshotDigest: compiled.snapshot.snapshotDigest,
    payloadFiles: compiled.payload.length,
  };
}

export function buildAuthoringProject(input: unknown, destination: string) {
  const bundle = buildAuthoringBundle(input, destination);
  const index = readAuthoringIndex(bundle);
  return {
    format: "wmm.authoring-build/1" as const, bundlePath: resolve(destination), inputDigest: index.inputDigest,
    notes: index.notes.length, ...validateWorldBundle(bundle),
  };
}

export function renderAuthoringNotes(bundlePath: string, destination: string) {
  const notes = renderDmNotes(loadReleaseWorldBundle(bundlePath));
  writeDmNotes(notes, destination);
  return {
    format: notes.format, outputPath: resolve(destination), snapshotDigest: notes.snapshotDigest,
    semanticProfileDigest: notes.semanticProfileDigest, inputDigest: notes.inputDigest,
    files: notes.files.map((file) => file.path),
  };
}
