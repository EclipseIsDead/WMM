import { types } from "node:util";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@wmm/canonical";
import {
  AUTHORING_INDEX_PATH, AUTHORING_INPUT_PATH, AuthoringError, authoringSemantics, compileAuthoringProject, economySemantics,
} from "@wmm/core";
import type {
  AuthoringCitation, AuthoringIndex, AuthoringNoteIndex, AuthoringProject, JsonValue,
} from "@wmm/wire-contracts";
import { validateAuthoringIndex } from "@wmm/wire-contracts";
import { writeNewAuthoringDirectory } from "./authoring.js";
import type { LoadedWorldBundle } from "./world-bundle.js";

export interface DmNoteFile { readonly path: string; readonly text: string }
export interface DmNotes {
  readonly format: "wmm.dm-notes/1";
  readonly snapshotDigest: string;
  readonly semanticProfileDigest: string;
  readonly inputDigest: string;
  readonly files: readonly DmNoteFile[];
}

/** Data-only retained fields; no filesystem root or invented bundle path is needed. */
export type AuthoringPresentationBundle = Pick<LoadedWorldBundle,
  "snapshot" | "world" | "semanticProfile" | "definitionsByDigest" | "rosters" |
  "descriptors" | "sources" | "assertions" | "supports" | "documents">;

function text(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function markdown(value: string): string { return value.replace(/[\\`*_{}\[\]<>()!|#~]/g, "\\$&"); }
function wikiLabel(value: string): string {
  return value.replace(/[\[\]|<>]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Verify compiler correspondence, not merely the checksums of presentation metadata. */
export function readAuthoringIndex(bundle: LoadedWorldBundle): AuthoringIndex {
  if (bundle.world.semanticProfileDigest !== authoringSemantics().profileDigest) throw new AuthoringError("DM notes require an authoring-profile bundle");
  // Preserve the legacy wrapper and its callers' existing admission/error boundary.
  const input = bundle.documents.find((document) => document.path === AUTHORING_INPUT_PATH);
  const presentation = bundle.documents.find((document) => document.path === AUTHORING_INDEX_PATH);
  if (input === undefined || presentation === undefined) throw new AuthoringError("Authoring input or presentation index is missing");
  const expected = compileAuthoringProject(JSON.parse(text(input.bytes)) as unknown);
  if (expected.snapshot.snapshotDigest !== bundle.snapshot.snapshotDigest) throw new AuthoringError("Authoring bundle differs from its compiled input; rebuild before rendering notes");
  const index: unknown = JSON.parse(text(presentation.bytes));
  if (!validateAuthoringIndex(index).valid) throw new AuthoringError("Invalid authoring presentation index");
  return index as AuthoringIndex;
}

/** Explicitly profile-aware correspondence; old actor/context wrapper stays narrow. */
export function readVerifiedAuthoringIndex(bundle: AuthoringPresentationBundle): AuthoringIndex {
  return verifyAuthoringBundlePresentation(bundle).index;
}

function ownData(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || types.isProxy(input)) throw new AuthoringError("Authoring presentation requires ordinary data");
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor) || (!descriptor.enumerable && !(Array.isArray(input) && key === "length"))) throw new AuthoringError("Authoring presentation requires own data properties");
  return descriptor.value;
}

/** Detach before invoking any input collection methods. Typed bytes are copied by
 * integer indices after intrinsic type/size checks, never via caller iterators. */
function detachPresentation(input: AuthoringPresentationBundle): AuthoringPresentationBundle {
  const fields = ["snapshot", "world", "semanticProfile", "definitionsByDigest", "rosters", "descriptors", "sources", "assertions", "supports"] as const;
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field] = ownData(input, field);
  const definitions = values["definitionsByDigest"];
  if (definitions === null || typeof definitions !== "object" || types.isProxy(definitions)) throw new AuthoringError("Invalid authoring definitions");
  const plainDefinitions: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(definitions)) {
    if (typeof key !== "string") throw new AuthoringError("Invalid authoring definition key");
    Object.defineProperty(plainDefinitions, key, { value: ownData(definitions, key), enumerable: true });
  }
  values["definitionsByDigest"] = plainDefinitions;
  const detached = JSON.parse(canonicalJson(values as JsonValue)) as Omit<AuthoringPresentationBundle, "documents">;
  const supplied = ownData(input, "documents");
  if (!Array.isArray(supplied) || types.isProxy(supplied)) throw new AuthoringError("Invalid authoring documents");
  const count = ownData(supplied, "length");
  // Array length is the one permitted non-enumerable structural property.
  if (typeof count !== "number" || count > 10000) throw new AuthoringError("Too many authoring documents");
  const documents: AuthoringPresentationBundle["documents"][number][] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const document = ownData(supplied, String(index));
    const bytes = ownData(document, "bytes");
    if (typeof bytes !== "object" || bytes === null || types.isProxy(bytes) || !types.isUint8Array(bytes)) throw new AuthoringError("Invalid authoring document bytes");
    const lengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!.get!;
    const size = Reflect.apply(lengthGetter, bytes, []) as number;
    total += size;
    if (size > 10 * 1024 * 1024 || total > 100 * 1024 * 1024) throw new AuthoringError("Authoring document byte budget exceeded");
    const copy = new Uint8Array(size);
    for (let position = 0; position < size; position += 1) copy[position] = bytes[position]!;
    const metadata = JSON.parse(canonicalJson({ path: ownData(document, "path"), mediaType: ownData(document, "mediaType"), sha256: ownData(document, "sha256") } as JsonValue)) as Omit<AuthoringPresentationBundle["documents"][number], "bytes">;
    documents.push({ ...metadata, bytes: copy });
  }
  return { ...detached, documents };
}

/** Full retained-payload correspondence, usable with filesystem or captured-base data. */
export function verifyAuthoringBundlePresentation(input: AuthoringPresentationBundle): { readonly bundle: AuthoringPresentationBundle; readonly index: AuthoringIndex; readonly project: AuthoringProject } {
  const bundle = detachPresentation(input);
  const index = verifyIndex(bundle);
  const project = JSON.parse(text(bundle.documents.find((document) => document.path === AUTHORING_INPUT_PATH)!.bytes)) as AuthoringProject;
  return { bundle, index, project };
}

function verifyIndex(bundle: AuthoringPresentationBundle): AuthoringIndex {
  if (![authoringSemantics().profileDigest, economySemantics().profileDigest].includes(bundle.world.semanticProfileDigest)) throw new AuthoringError("Unsupported authoring profile");
  const input = bundle.documents.find((document) => document.path === AUTHORING_INPUT_PATH);
  const presentation = bundle.documents.find((document) => document.path === AUTHORING_INDEX_PATH);
  if (input === undefined || presentation === undefined) throw new AuthoringError("Authoring input or presentation index is missing");
  const expected = compileAuthoringProject(JSON.parse(text(input.bytes)) as unknown);
  if (expected.snapshot.snapshotDigest !== bundle.snapshot.snapshotDigest) {
    throw new AuthoringError("Authoring bundle differs from its compiled input; rebuild before rendering notes");
  }
  const expectedFiles = new Map(expected.snapshot.manifest.files.map((entry) => [entry.path, entry]));
  function check(path: string, bytes: Uint8Array, mediaType = "application/json"): void {
    const entry = expectedFiles.get(path);
    if (entry === undefined || entry.mediaType !== mediaType || entry.sha256 !== sha256Hex(bytes) || entry.byteLength !== String(bytes.length)) throw new AuthoringError("Authoring payload correspondence mismatch");
    expectedFiles.delete(path);
  }
  const json = (path: string, value: unknown): void => check(path, canonicalJsonBytes(value as JsonValue));
  if (sha256Hex(canonicalJsonBytes(bundle.snapshot as unknown as JsonValue)) !== sha256Hex(canonicalJsonBytes(expected.snapshot as unknown as JsonValue))) throw new AuthoringError("Authoring snapshot correspondence mismatch");
  json("world.json", bundle.world);
  json(`types/${bundle.world.semanticProfileDigest}.json`, bundle.semanticProfile);
  for (const [digest, definition] of Object.entries(bundle.definitionsByDigest)) json(`types/${digest}.json`, definition);
  for (const record of bundle.descriptors) json(`records/descriptors/${record.id.replace(":", "/")}.json`, record);
  for (const record of bundle.sources) json(`records/sources/${record.id.slice("source:".length)}.json`, record);
  for (const record of bundle.assertions) json(`records/assertions/${record.id.slice("asrt:".length)}.json`, record);
  for (const record of bundle.supports) json(`records/supports/${record.id.slice("sup:".length)}.json`, record);
  for (const record of bundle.rosters) json(`rosters/${record.digest}.json`, record.body);
  for (const document of bundle.documents) {
    const entry = expectedFiles.get(document.path);
    if (entry === undefined || entry.mediaType !== document.mediaType || entry.sha256 !== document.sha256 || entry.sha256 !== sha256Hex(document.bytes) || entry.byteLength !== String(document.bytes.length)) {
      throw new AuthoringError("Authoring document correspondence mismatch");
    }
    check(document.path, document.bytes, document.mediaType);
  }
  if (expectedFiles.size !== 0) throw new AuthoringError("Authoring payload correspondence is incomplete");
  const index: unknown = JSON.parse(text(presentation.bytes));
  if (!validateAuthoringIndex(index).valid) throw new AuthoringError("Invalid authoring presentation index");
  return index as AuthoringIndex;
}

/** Deterministic projection of verified bundle records, never of loose Markdown or world.export metadata. */
export function renderDmNotes(bundle: LoadedWorldBundle): DmNotes {
  if (bundle.world.semanticProfileDigest === economySemantics().profileDigest) throw new AuthoringError("Economic-profile DM notes are unsupported; use the complete Economy view instead");
  const index = readAuthoringIndex(bundle);
  const byId = new Map(index.notes.map((note) => [note.id, note]));
  const assertions = new Map(bundle.assertions.map((record) => [record.id, record]));
  const sources = new Map(index.sources.map((source) => [source.id, source]));
  const documents = new Map(bundle.documents.map((document) => [document.path, document]));
  const link = (id: string): string => `[[${id.replace(":", "/")}|${wikiLabel(byId.get(id)!.name)}]]`;
  const atom = (id: string) => {
    const proposition = assertions.get(id)!.body.proposition;
    if (proposition.kind !== "atom") throw new AuthoringError("Expected an authored atom");
    return proposition;
  };
  const integer = (id: string): number => {
    const value = atom(id).value;
    if (value.kind !== "literal" || typeof value.data !== "number") throw new AuthoringError("Expected an authored integer");
    return value.data;
  };
  const subject = (note: AuthoringNoteIndex): string => {
    const value = atom(note.track!.subjectAssertionId).value;
    if (value.kind !== "ref") throw new AuthoringError("Expected a track subject reference");
    return value.id;
  };
  const current = (note: AuthoringNoteIndex): number => integer(note.track!.entries.at(-1)!.assertionId);
  const citations = (items: readonly AuthoringCitation[]): string[] => items.map((citation) => {
    const source = sources.get(citation.sourceId)!;
    return `- Source citation: ${markdown(source.title)} — ${markdown(source.path)} · ${markdown(citation.locator)}`;
  });
  const campaignTracks = index.notes.filter((note) => note.track !== null);
  const keyByDigest = new Map(Object.entries(bundle.definitionsByDigest).map(([digest, body]) => [digest, body.key]));
  const scopeLabel = (accountId: string): string => {
    if (accountId === "account:setting") return "Setting";
    const id = `campaign:${accountId.slice("account:campaign_".length)}`;
    return `Campaign: ${link(id)}`;
  };
  const files: DmNoteFile[] = index.notes.map((note) => {
    const lines: string[] = [
      "---", `wmm_id: ${JSON.stringify(note.id)}`, `wmm_snapshot: ${JSON.stringify(bundle.snapshot.snapshotDigest)}`, "---",
      `# ${markdown(note.name)}`, "", "> Generated by WMM. Edit the authoring project, not this view.", "",
    ];
    if (note.campaignId !== null && note.id !== note.campaignId) lines.push(`Campaign: ${link(note.campaignId)}`, "");
    if (note.track !== null) {
      lines.push(`Subject: ${link(subject(note))}`, "", `**Current: ${current(note)}** (range ${integer(note.track.minimumAssertionId)}–${integer(note.track.maximumAssertionId)})`, "",
        "## State log", "", "Authored entry order; not dated historical validation. Only the last entry is current.", "");
      note.track.entries.forEach((entry, position) => {
        lines.push(`### Entry ${position + 1}: ${integer(entry.assertionId)}${position === note.track!.entries.length - 1 ? " (current)" : ""}`, "", entry.note, "", ...citations(entry.citations), "");
      });
    }
    if (note.facts.length > 0) {
      lines.push("## Declared relationships", "", "Explicit authoring declarations, not independently verified documentary facts.", "");
      for (const fact of note.facts) {
        const record = assertions.get(fact.assertionId)!;
        const proposition = atom(fact.assertionId);
        const value = proposition.value;
        if (value.kind !== "ref" || record.body.scope.account.kind !== "ref") throw new AuthoringError("Expected a scoped relationship");
        lines.push(`- ${record.body.polarity === "negative" ? "NOT " : ""}${markdown(keyByDigest.get(proposition.predicateDefinitionDigest)!.replaceAll("_", " "))}: ${link(value.id)} — ${scopeLabel(record.body.scope.account.id)}`,
          ...citations(fact.citations), "");
      }
    }
    for (const section of note.sections) {
      const category = {
        lore: "Lore — narrative, not extracted claims", "dm-note": "DM note", possibility: "Possibility — not an established event", session: "Session note — campaign record",
      }[section.category];
      lines.push(`## ${markdown(section.heading)}`, "", `*${category} · ${section.context.kind === "setting" ? "Setting" : `Campaign: ${link(section.context.campaignId)}`}*`, "",
        text(documents.get(section.path)!.bytes), "");
      if (section.references.length > 0) lines.push(`See also: ${section.references.map(link).join(", ")}`, "");
      lines.push(...citations(section.citations), "");
    }
    const tracks = campaignTracks.filter((track) => note.id === track.campaignId || note.id === subject(track));
    if (tracks.length > 0) {
      lines.push("## Campaign tracks", "");
      for (const track of tracks) lines.push(`- ${link(track.id)}: **${current(track)}** — ${link(track.campaignId!)}`);
      lines.push("");
    }
    const backlinks = index.notes.filter((other) => other.id !== note.id && (
      other.sections.some((section) => section.references.includes(note.id)) ||
      other.facts.some((fact) => { const value = atom(fact.assertionId).value; return value.kind === "ref" && value.id === note.id; })
    ));
    if (backlinks.length > 0) lines.push("## Referenced by", "", ...backlinks.map((other) => `- ${link(other.id)}`), "");
    return { path: `${note.id.replace(":", "/")}.md`, text: `${lines.join("\n").trimEnd()}\n` };
  });
  files.push({ path: "index.md", text: [
    `# ${markdown(index.title)}`, "", "> Generated DM notes. Private DM material; no player-facing access control or filtering is provided.", "",
    "## Setting", "", ...index.notes.filter((note) => note.campaignId === null).map((note) => `- ${link(note.id)}`), "",
    "## Campaigns", "", ...index.notes.filter((note) => note.id === note.campaignId).map((note) => `- ${link(note.id)}`), "",
    "## Provenance", "", `Snapshot: \`${bundle.snapshot.snapshotDigest}\``, `Semantic profile: \`${bundle.world.semanticProfileDigest}\``,
    `Authoring input: \`${index.inputDigest}\``, "", "Citations trace the agent's interpretation to input notes. Only explicit declarations compile to claims; narrative and possibilities do not.", "",
  ].join("\n") });
  files.sort((left, right) => left.path < right.path ? -1 : 1);
  return { format: "wmm.dm-notes/1", snapshotDigest: bundle.snapshot.snapshotDigest, semanticProfileDigest: bundle.world.semanticProfileDigest, inputDigest: index.inputDigest, files };
}

export function writeDmNotes(notes: DmNotes, destination: string): void {
  const files = notes.files.map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.text) }));
  const manifest = {
    format: notes.format, snapshotDigest: notes.snapshotDigest, semanticProfileDigest: notes.semanticProfileDigest, inputDigest: notes.inputDigest,
    files: files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), byteLength: String(file.bytes.length) })),
  };
  writeNewAuthoringDirectory(destination, [...files, { path: "wmm-notes.json", bytes: canonicalJsonBytes(manifest as unknown as JsonValue) }]);
}
