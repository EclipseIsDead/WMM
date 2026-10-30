import type { AuthoringProject, JsonValue } from "@wmm/wire-contracts";
import type { DmHarnessRunInfo, DmHarnessSourceUse } from "./index.js";

interface Review {
  readonly runId: string;
  readonly runInputDigest: string;
  readonly baseSnapshotDigest: string;
  readonly proposalDigest: string;
  readonly snapshotDigest: string;
  readonly summary: string;
  readonly uncertainties: readonly string[];
  readonly sourceUses: readonly DmHarnessSourceUse[];
  readonly changes: readonly JsonValue[];
  readonly collections: readonly JsonValue[];
}
interface Change {
  readonly operation: "add" | "remove" | "replace";
  readonly projectPointer: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly attribution: string;
  readonly sourceUses: readonly DmHarnessSourceUse[];
}

function markdown(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()!|#~]/g, "\\$&");
}
function quote(text: string): string[] { return text.split("\n").map((line) => `> ${markdown(line)}`); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function field(key: string): string {
  const labels: Record<string, string> = { id: "ID", text: "Text", name: "Name", heading: "Heading", sections: "Sections", facts: "Relationships", sources: "Sources", campaigns: "Campaigns", entities: "Entities", tracks: "Tracks", entries: "Entries", citations: "Citations", references: "References", context: "Context", category: "Category", title: "Title" };
  return Object.hasOwn(labels, key) ? labels[key]! : key.replace(/([a-z])([A-Z])/g, "$1 $2");
}
function location(project: AuthoringProject, pointer: string): string {
  if (pointer === "") return "Project";
  const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value: unknown = project;
  const labels: string[] = [];
  for (const [position, key] of parts.entries()) {
    if (Array.isArray(value)) {
      value = value[Number(key)];
      const item = record(value);
      const name = item?.["heading"] ?? item?.["name"] ?? item?.["title"] ?? item?.["id"];
      labels.push(typeof name === "string" ? name : `Item ${Number(key) + 1}`);
    } else {
      const owner = record(value);
      value = owner !== undefined && Object.hasOwn(owner, key) ? owner[key] : undefined;
      if (!Array.isArray(value) || position === parts.length - 1 || key === "facts") labels.push(field(key));
    }
  }
  return labels.join(" / ");
}
/** Every value stays visible; strings are quoted prose rather than serialized JSON. */
function valueLines(value: JsonValue, path: readonly string[] = []): string[] {
  if (value !== null && typeof value === "object") {
    const items = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
    if (items.length === 0) return [...(path.length ? [`**${markdown(path.join(" / "))}**`, ""] : []), `> (empty ${Array.isArray(value) ? "list" : "object"})`, ""];
    return items.flatMap(([key, item]) => valueLines(item, [...path, Array.isArray(value) ? `Item ${key}` : field(key)]));
  }
  return [...(path.length ? [`**${markdown(path.join(" / "))}**`, ""] : []), ...quote(typeof value === "string" ? value : String(value)), ""];
}
function sourceKey(use: DmHarnessSourceUse): string {
  return JSON.stringify([use.projectPointer, use.sourceId, use.sourceSha256, use.startLine, use.endLine]);
}
function prefix(text: string, maximum: number): { text: string; count: number; shortened: boolean } {
  let result = "";
  let count = 0;
  for (const scalar of text) {
    if (count === maximum) return { text: result, count, shortened: true };
    result += scalar;
    count++;
  }
  return { text: result, count, shortened: false };
}

/** Internal presentation of the host-constructed review over admitted detached data. */
export function renderDmHarnessReview(info: DmHarnessRunInfo, proposed: AuthoringProject, review: Review): string {
  const changes = review.changes as unknown as readonly Change[];
  const uses = review.sourceUses.map((use, index) => ({ use, label: `S${index + 1}` }));
  const labels = new Map(uses.map(({ use, label }) => [sourceKey(use), label]));
  const sources = new Map(info.sources.map((source) => [source.id, { ...source, lines: source.text.split("\n") }]));
  const lines = ["# DRAFT — DM proposal review", "", "**NOT APPROVED / NOT CANON.**", "", "## Summary", "", ...quote(review.summary), "",
    `${changes.filter((change) => change.operation === "add").length} added · ${changes.filter((change) => change.operation === "replace").length} changed · ${changes.filter((change) => change.operation === "remove").length} removed`, "", "## Changes", ""];
  if (changes.length === 0) lines.push("No project changes.", "");
  for (const [index, change] of changes.entries()) {
    const owner = change.operation === "remove" ? info.project : proposed;
    const action = { add: "Added", remove: "Removed", replace: "Changed" }[change.operation];
    lines.push(`### ${index + 1}. ${action}: ${markdown(location(owner, change.projectPointer))}`, "", `Path: ${markdown(change.projectPointer || "(project root)")}`, "");
    if (change.before !== undefined) lines.push("**Before**", "", ...valueLines(change.before));
    if (change.after !== undefined) lines.push("**After**", "", ...valueLines(change.after));
    const fieldUses = change.operation === "add" ? uses.filter(({ use }) => use.projectPointer.startsWith(`${change.projectPointer}/`)) : [];
    lines.push(change.sourceUses.length ? `Declared source basis: ${change.sourceUses.map((use) => labels.get(sourceKey(use))!).join(", ")}` : `**${fieldUses.length ? "Whole item: " : ""}UNSOURCED / agent interpretation**`, "");
    for (const { use, label } of fieldUses) {
      lines.push(`Declared source basis for ${markdown(location(owner, use.projectPointer))} (${markdown(use.projectPointer)}): ${label}`, "");
    }
  }
  lines.push("## Collection sizes", "");
  if (review.collections.length === 0) lines.push("No collection size changes.", "");
  for (const item of review.collections) {
    const change = item as { projectPointer: string; beforeCount: number; afterCount: number };
    lines.push(`- ${markdown(change.projectPointer || "(project root)")}: ${change.beforeCount} → ${change.afterCount}`);
  }
  lines.push("", "## Source basis", "");
  if (uses.length === 0) lines.push("No source basis declared.", "");
  // Excerpts are previews; all identities/ranges remain complete in review.json.
  // Bound both each preview and their aggregate without splitting Unicode scalars.
  let remaining = 12_000;
  for (const { use, label } of uses) {
    const source = sources.get(use.sourceId)!;
    const range = use.startLine === use.endLine ? `L${use.startLine}` : `L${use.startLine}–L${use.endLine}`;
    lines.push(`### ${label}. ${markdown(source.title)} · ${range}`, "", `${markdown(source.path)} · ${markdown(use.sourceId)}`, "", `For: ${markdown(use.projectPointer || "(project root)")}`, "");
    if (/^\/sources(?:$|\/\d+(?:\/|$))/.test(use.projectPointer)) {
      lines.push("Catalogue metadata binding; not narrative evidence.", "");
    } else {
      let allowance = Math.min(600, remaining);
      let shortened = false;
      for (let number = use.startLine; number <= use.endLine; number++) {
        if (allowance === 0) { shortened = true; break; }
        const part = prefix(`${number}: ${source.lines[number - 1]!}`, allowance);
        lines.push(...quote(part.text));
        allowance -= part.count;
        remaining -= part.count;
        if (part.shortened) { shortened = true; break; }
      }
      if (shortened) lines.push("> … (excerpt shortened; full captured range retained)");
      lines.push("");
    }
    lines.push(`SHA-256: ${use.sourceSha256}`, "");
  }
  lines.push("## Questions for the DM", "");
  if (review.uncertainties.length === 0) lines.push("No open questions declared.", "");
  for (const [index, question] of review.uncertainties.entries()) lines.push(`### ${index + 1}`, "", ...quote(question), "");
  lines.push("## Provenance", "", `Run: ${review.runId}`, `Run input: ${review.runInputDigest}`, `Base snapshot: ${review.baseSnapshotDigest}`,
    `Proposed snapshot: ${review.snapshotDigest}`, `Proposal: ${review.proposalDigest}`, "", "Machine-readable review: ../review.json", "",
    "Source bindings are declared basis, not proof. This is a full-project recompilation for DM review; no approval or canon change.", "");
  return lines.join("\n");
}
