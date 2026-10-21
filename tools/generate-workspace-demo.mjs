import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, sha256Hex, snapshotDigest } from "../packages/canonical/dist/index.js";
import { loadBundledV1WorldBundle } from "../packages/exchange/dist/index.js";

const source = new URL("../fixtures/v1/complete-world/", import.meta.url);
const destination = new URL("../fixtures/v3/succession-world/", import.meta.url);
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
const snapshot = JSON.parse(readFileSync(new URL("snapshot.json", source), "utf8"));
const notes = {
  "prose/succession.md": "# Kingdom of Valen: worked succession demo\n\nThis is explicitly a worked authoring example, not the user's world.\nKing Edric holds the crown. The existing council administers the kingdom.\nThe dynasty remains in place; no succession development is predetermined.\nThe proposed death, coup, council and regency are editable prose drafts, not compiled historical assertions.\n",
  "prose/neutrality.md": "# Neighboring kingdom\n\nThe neighboring kingdom remains neutral in Valen's affairs.\n",
};
const files = [...snapshot.manifest.files];
for (const [path, text] of Object.entries(notes)) {
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(new URL(`payload/${path}`, destination), bytes);
  files.push({ path, mediaType: "text/markdown", byteLength: String(bytes.length), sha256: sha256Hex(bytes) });
}
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const manifest = { ...snapshot.manifest, files };
const record = { ...snapshot, manifest, snapshotDigest: snapshotDigest(manifest) };
writeFileSync(new URL("snapshot.json", destination), canonicalJsonBytes(record));
loadBundledV1WorldBundle(fileURLToPath(destination));
writeFileSync(new URL("../fixtures/v3/create-demo-request.json", import.meta.url), canonicalJsonBytes({
  format: "wmm.request/1", apiVersion: "wmm/1", requestId: "create-succession-demo", operation: "workspace.create",
  payload: { workspaceId: "main", bundlePath: "fixtures/v3/succession-world", title: "The succession crisis", goal: "Review a succession without changing canon.", mode: "succession-demo", idempotencyKey: "create-demo-1" },
}));
console.log(JSON.stringify({ status: "generated", snapshotDigest: record.snapshotDigest, files: files.length, path: "fixtures/v3/succession-world" }));
