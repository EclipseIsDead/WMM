import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@wmm/canonical";
import type { AssertionRecordV1, AuthoringIndex, AuthoringProject, EconomicRecordValue, EconomyView, JsonValue, WorldCatalogV1 } from "@wmm/wire-contracts";
import { MAX_ECONOMY_VIEW_BYTES, validateEconomyView } from "@wmm/wire-contracts";
import { economicEntityIds, economicMappedReferences, EconomyError } from "./economy.js";
import { economySemantics } from "./economy-semantics.js";
import { compileAuthoringProject } from "./authoring.js";

/** Adapters verify ordinary admission and the complete retained payload. The pure
 * projection also binds its assertions and labels to captured-project recompilation;
 * it performs no filesystem or citation-path reads. */
export interface EconomyProjectionInput {
  readonly snapshotDigest: string;
  readonly world: WorldCatalogV1;
  readonly index: AuthoringIndex;
  readonly assertions: readonly AssertionRecordV1[];
  readonly project: AuthoringProject;
}
export function buildEconomyView(input: EconomyProjectionInput): EconomyView {
  const data = JSON.parse(canonicalJson(input as unknown as JsonValue)) as EconomyProjectionInput;
  const semantics = economySemantics();
  if (data.world.semanticProfileDigest !== semantics.profileDigest || data.world.worldId !== data.index.worldId) throw new EconomyError("Economy view requires a verified economic-profile authored world");
  const compiled = compileAuthoringProject(data.project);
  if (compiled.snapshot.snapshotDigest !== data.snapshotDigest) throw new EconomyError("Economy captured-project snapshot correspondence mismatch");
  const expectedFiles = new Map(compiled.snapshot.manifest.files.map((file) => [file.path, file.sha256]));
  function matches(path: string, value: unknown): void {
    if (expectedFiles.get(path) !== sha256Hex(canonicalJsonBytes(value as JsonValue))) throw new EconomyError("Economy captured-project value or metadata correspondence mismatch");
  }
  matches("world.json", data.world);
  matches("authoring/index.json", data.index);
  if (data.assertions.length !== data.world.assertionIds.length || new Set(data.assertions.map((record) => record.id)).size !== data.assertions.length) throw new EconomyError("Economy assertion correspondence is incomplete");
  for (const assertion of data.assertions) matches(`records/assertions/${assertion.id.slice("asrt:".length)}.json`, assertion);
  const active = new Set(data.world.activeAssertionIds);
  const records: EconomyView["records"][number][] = [];
  for (const assertion of data.assertions) {
    const proposition = assertion.body.proposition;
    if (!active.has(assertion.id) || proposition.kind !== "atom" || proposition.predicateDefinitionDigest !== semantics.definitionDigestsByKey["economic_record"]) continue;
    if (proposition.value.kind !== "literal") throw new EconomyError("Expected economic literal");
    records.push({ assertionId: assertion.id, subjectId: proposition.subjectId, scope: assertion.body.scope, value: proposition.value.data as unknown as EconomicRecordValue });
  }
  records.sort((a, b) => a.assertionId < b.assertionId ? -1 : a.assertionId > b.assertionId ? 1 : 0);
  const entityIds = new Set(records.flatMap((record) => [record.subjectId, ...economicEntityIds(record.value)]));
  const sourceIds = new Set(records.flatMap((record) => record.value.citations.map((citation) => citation.sourceId)));
  const axisIds = new Set(records.flatMap((record) => economicMappedReferences(record.value).map((reference) => reference.axisDefinitionDigest)));
  const view: EconomyView = {
    format: "wmm.economy-view/1", worldId: data.world.worldId, snapshotDigest: data.snapshotDigest,
    semanticProfileDigest: data.world.semanticProfileDigest, inputDigest: data.index.inputDigest,
    perspective: "dm", accounting: "not-run", scenarios: "not-run", records,
    entities: data.index.notes.filter((note) => entityIds.has(note.id)).map(({ id, name }) => ({ id, name })).sort((a, b) => a.id < b.id ? -1 : 1),
    sources: data.index.sources.filter((source) => sourceIds.has(source.id)).sort((a, b) => a.id < b.id ? -1 : 1),
    axes: Object.entries(semantics.definitionsByDigest).filter(([digest]) => axisIds.has(digest)).map(([definitionDigest, definition]) => ({ definitionDigest, key: definition.key })).sort((a, b) => a.definitionDigest < b.definitionDigest ? -1 : 1),
    limitations: [
      "Authored DM declarations, not truth certification, documentary verification or actor knowledge.",
      "Unknown is not zero. Commitments are not stock; planned requirements are not consumption.",
      "Reference points and periods are not claim applicability. No calendar mapping or current time is inferred.",
      "Declared boundary and complete-as-declared coverage are authored claims, not completeness certificates.",
      "Accounting and scenarios have not run. No totals, fulfillment or world execution is implied.",
    ],
  };
  if (canonicalJsonBytes(view as unknown as JsonValue).length > MAX_ECONOMY_VIEW_BYTES) throw new EconomyError("Complete economy view exceeds its byte budget");
  if (!validateEconomyView(view).valid) throw new EconomyError("Invalid complete economy view");
  return view;
}
