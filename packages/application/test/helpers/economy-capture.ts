import { sha256Hex } from "@wmm/canonical";
import type { WorkspaceStore } from "@wmm/ports";
import type { CompiledAuthoringProject, SemanticProfileV1, WorkspaceBaseV1, WorldCatalogV1 } from "@wmm/wire-contracts";

/** Exact captured representation from actual compiled bytes, without semantic admission. */
export function capture(compiled: CompiledAuthoringProject): WorkspaceBaseV1 {
  const parse = <T>(path: string): T => JSON.parse(Buffer.from(compiled.payload.find((file) => file.path === path)!.bytes).toString("utf8")) as T;
  const world = parse<WorldCatalogV1>("world.json");
  const profile = parse<SemanticProfileV1>(`types/${world.semanticProfileDigest}.json`);
  const documents = compiled.payload.filter((file) => file.path !== "world.json" && !["types/", "rosters/", "records/"].some((prefix) => file.path.startsWith(prefix)));
  const entries = new Map(compiled.snapshot.manifest.files.map((entry) => [entry.path, entry]));
  return {
    snapshot: compiled.snapshot,
    world: {
      format: "wmm.world-export/1", snapshotDigest: compiled.snapshot.snapshotDigest, world, semanticProfile: profile,
      definitions: profile.definitions.map((digest) => ({ digest, body: parse(`types/${digest}.json`) })),
      rosters: compiled.payload.filter((file) => file.path.startsWith("rosters/")).map((file) => ({ digest: file.path.slice(8, -5), body: parse(file.path) })),
      descriptors: world.descriptorIds.map((id) => parse(`records/descriptors/${id.replace(":", "/")}.json`)),
      sources: world.sourceIds.map((id) => parse(`records/sources/${id.slice(7)}.json`)),
      assertions: world.assertionIds.map((id) => parse(`records/assertions/${id.slice(5)}.json`)),
      supports: world.supportIds.map((id) => parse(`records/supports/${id.slice(4)}.json`)),
      documents: documents.map((file) => entries.get(file.path)!),
    },
    documents: documents.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: sha256Hex(file.bytes), base64: Buffer.from(file.bytes).toString("base64") })),
  };
}

export function persistCapture(store: WorkspaceStore, base: WorkspaceBaseV1, workspaceId = "forged") {
  const initial = store.read("grain", 1);
  return store.create(workspaceId, { idempotencyKey: "capture", intent: "test capture, not application admission" }, () => ({
    state: { ...initial, id: workspaceId, base: { worldId: base.snapshot.manifest.worldId, snapshotDigest: base.snapshot.snapshotDigest } }, base,
  }));
}
