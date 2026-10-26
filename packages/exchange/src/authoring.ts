import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalJsonBytes } from "@wmm/canonical";
import { AuthoringError, compileAuthoringProject } from "@wmm/core";
import type { JsonValue } from "@wmm/wire-contracts";
import { loadReleaseWorldBundle, type LoadedWorldBundle } from "./world-bundle.js";

interface OutputFile { readonly path: string; readonly bytes: Uint8Array }

/** Fresh destinations only; callers must use a private, stable parent directory. */
export function writeNewAuthoringDirectory(destination: string, files: readonly OutputFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(json|md)$/.test(file.path) || seen.has(file.path)) {
      throw new AuthoringError(`Unsafe or duplicate output path: ${file.path}`);
    }
    seen.add(file.path);
  }
  const root = resolve(destination);
  // Refuse symlinked existing ancestors, including a dangling destination symlink.
  // Like the bundle loader, this is not atomic confinement against concurrent parent swaps.
  for (let current = root;; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AuthoringError("Output ancestors must be real directories");
      if (current === root) throw new AuthoringError("Output destination already exists; choose a fresh directory");
      // Inspect the filesystem marker, not a source-path string, so every caller
      // is protected even through relative or filesystem case aliases.
      if (lstatSync(resolve(current, "snapshot.json"), { throwIfNoEntry: false }) !== undefined) {
        throw new AuthoringError("Output cannot be inside an existing world bundle");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(current) === current) break;
  }
  mkdirSync(dirname(root), { recursive: true });
  // Non-recursive mkdir claims the destination exclusively; never remove/replace a user's tree.
  mkdirSync(root);
  for (const file of files) {
    const path = resolve(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes, { flag: "wx" });
  }
}

export function buildAuthoringBundle(input: unknown, destination: string): LoadedWorldBundle {
  const compiled = compileAuthoringProject(input);
  writeNewAuthoringDirectory(destination, [
    ...compiled.payload.map((file) => ({ path: `payload/${file.path}`, bytes: file.bytes })),
    // Written last: incomplete writes cannot masquerade as complete WMM bundles.
    { path: "snapshot.json", bytes: canonicalJsonBytes(compiled.snapshot as unknown as JsonValue) },
  ]);
  return loadReleaseWorldBundle(destination);
}
