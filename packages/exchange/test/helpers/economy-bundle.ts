import { assertionId, canonicalJsonBytes, sha256Hex, snapshotDigest, supportId } from "@wmm/canonical";
import { compileAuthoringProject } from "@wmm/core";
import type { AssertionRecordV1, AuthoringProject, ClaimBodyV1, CompiledAuthoringProject, JsonValue, SupportRecordV1, WorldCatalogV1 } from "@wmm/wire-contracts";
import { writeNewAuthoringDirectory } from "../../src/authoring.js";

/** Rehash every dependent identity, so semantic negatives cannot pass on checksums. */
export function changedBundle(input: AuthoringProject, change: (body: ClaimBodyV1) => ClaimBodyV1 = (body) => body, assetChange?: (path: string, value: unknown) => unknown): CompiledAuthoringProject {
  const compiled = compileAuthoringProject(input);
  const files = new Map(compiled.payload.map((file) => [file.path, file]));
  const parse = <T>(path: string): T => JSON.parse(new TextDecoder().decode(files.get(path)!.bytes)) as T;
  const put = (path: string, value: unknown) => { files.set(path, { path, mediaType: "application/json", bytes: canonicalJsonBytes(value as JsonValue) }); };
  const assertionIds = new Map<string, string>();
  for (const file of compiled.payload.filter((file) => file.path.startsWith("records/assertions/"))) {
    const record = parse<AssertionRecordV1>(file.path);
    const body = change(record.body);
    const id = assertionId(body);
    assertionIds.set(record.id, id);
    files.delete(file.path);
    put(`records/assertions/${id.slice(5)}.json`, { ...record, id, body });
  }
  const supportIds = new Map<string, string>();
  for (const file of compiled.payload.filter((file) => file.path.startsWith("records/supports/"))) {
    const record = parse<SupportRecordV1>(file.path);
    const body = { ...record.body, claimId: assertionIds.get(record.body.claimId)! };
    const id = supportId(body);
    supportIds.set(record.id, id);
    files.delete(file.path);
    put(`records/supports/${id.slice(4)}.json`, { ...record, id, body });
  }
  const world = parse<WorldCatalogV1>("world.json");
  put("world.json", { ...world, assertionIds: world.assertionIds.map((id) => assertionIds.get(id)!).sort(), activeAssertionIds: world.activeAssertionIds.map((id) => assertionIds.get(id)!).sort(), supportIds: world.supportIds.map((id) => supportIds.get(id)!).sort(), activeSupportIds: world.activeSupportIds.map((id) => supportIds.get(id)!).sort() });
  if (assetChange !== undefined) for (const file of [...files.values()]) {
    if (file.mediaType === "application/json") put(file.path, assetChange(file.path, parse(file.path)));
  }
  const payload = [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = { ...compiled.snapshot.manifest, files: payload.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: sha256Hex(file.bytes), byteLength: String(file.bytes.length) })) };
  return { payload, snapshot: { ...compiled.snapshot, manifest, snapshotDigest: snapshotDigest(manifest) } };
}
export function writeChangedBundle(input: CompiledAuthoringProject, destination: string): void {
  writeNewAuthoringDirectory(destination, [...input.payload.map((file) => ({ path: `payload/${file.path}`, bytes: file.bytes })), { path: "snapshot.json", bytes: canonicalJsonBytes(input.snapshot as unknown as JsonValue) }]);
}
