import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertionId,
  canonicalJsonBytes,
  semanticDefinitionDigest,
  sha256Hex,
  snapshotDigest,
  supportId,
} from "../packages/canonical/dist/index.js";
import { bundledV1Semantics } from "../packages/core/dist/index.js";

const root = fileURLToPath(new URL("../fixtures/v1/complete-world/", import.meta.url));
const payloadRoot = resolve(root, "payload");
const worldId = "world:valen_v1";
const semantics = bundledV1Semantics();
const digest = (key) => {
  const value = semantics.definitionDigestsByKey[key];
  if (value === undefined) throw new Error(`Missing bundled definition: ${key}`);
  return value;
};
const sorted = (values) => [...values].sort();

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeJson(relativePath, value) {
  writeBytes(resolve(payloadRoot, relativePath), canonicalJsonBytes(value));
}

function descriptorPath(id) {
  const separator = id.indexOf(":");
  return `records/descriptors/${id.slice(0, separator)}/${id.slice(separator + 1)}.json`;
}

function listFiles(directory = payloadRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(relative(payloadRoot, absolute).split(sep).join("/"));
  }
  return files.sort();
}

rmSync(root, { recursive: true, force: true });
mkdirSync(payloadRoot, { recursive: true });

for (const definition of semantics.definitions) {
  writeJson(`types/${semanticDefinitionDigest(definition)}.json`, definition);
}
writeJson(`types/${semantics.profileDigest}.json`, semantics.profile);

const descriptorSpecs = [
  ["account:canonical", "account"],
  ["frame:royal-court", "recognition_frame"],
  ["office:valen-crown", "office"],
  ["person:alys", "person"],
  ["person:bran", "person"],
  ["polity:valen", "polity"],
  ["population:succession-candidates", "population"],
];
const descriptors = descriptorSpecs.map(([id, typeKey]) => ({
  format: "wmm.descriptor/1",
  worldId,
  id,
  birthTypeDefinitionDigest: digest(typeKey),
}));
for (const descriptor of descriptors) writeJson(descriptorPath(descriptor.id), descriptor);

const source = {
  format: "wmm.source/1",
  worldId,
  id: "source:authorial-stipulation",
  sourceType: "authorStipulation",
  content: { availability: "none" },
};
writeJson("records/sources/authorial-stipulation.json", source);

const scope = {
  account: { kind: "ref", id: "account:canonical" },
  jurisdiction: { kind: "ref", id: "polity:valen" },
  recognitionFrame: { kind: "ref", id: "frame:royal-court" },
};
const claimBodies = [
  {
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "atom",
      subjectId: "person:alys",
      predicateDefinitionDigest: digest("allied_with"),
      value: { kind: "ref", id: "person:bran" },
    },
    polarity: "positive",
    scope,
    applicability: { kind: "invariant" },
  },
  {
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "exists",
      population: {
        descriptorId: "population:succession-candidates",
        definitionDigest: digest("candidates"),
      },
      criterion: {
        definitionDigest: digest("eligible"),
        arguments: {
          office: { kind: "ref", id: "office:valen-crown" },
        },
      },
    },
    polarity: "negative",
    scope,
    applicability: {
      kind: "interval",
      axisDefinitionDigest: digest("days"),
      start: { kind: "exact", position: "1000" },
      endExclusive: { kind: "exact", position: "1030" },
    },
  },
  {
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "atom",
      subjectId: "population:succession-candidates",
      predicateDefinitionDigest: digest("population_coverage"),
      value: { kind: "ref", id: "population:succession-candidates" },
    },
    polarity: "positive",
    scope,
    applicability: {
      kind: "interval",
      axisDefinitionDigest: digest("days"),
      start: { kind: "exact", position: "1000" },
      endExclusive: { kind: "exact", position: "1040" },
    },
  },
  ...["person:alys", "person:bran"].map((candidateId) => ({
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "atom",
      subjectId: candidateId,
      predicateDefinitionDigest: digest("candidate_membership"),
      value: { kind: "ref", id: "population:succession-candidates" },
    },
    polarity: "positive",
    scope,
    applicability: {
      kind: "interval",
      axisDefinitionDigest: digest("days"),
      start: { kind: "exact", position: "1000" },
      endExclusive: { kind: "exact", position: "1040" },
    },
  })),
  ...["person:alys", "person:bran"].map((candidateId) => ({
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "atom",
      subjectId: candidateId,
      predicateDefinitionDigest: digest("eligibility_satisfaction"),
      value: { kind: "ref", id: "office:valen-crown" },
    },
    polarity: "negative",
    scope,
    applicability: {
      kind: "interval",
      axisDefinitionDigest: digest("days"),
      start: { kind: "exact", position: "1000" },
      endExclusive: { kind: "exact", position: "1030" },
    },
  })),
  {
    format: "wmm.claim/1",
    worldId,
    semanticProfileDigest: semantics.profileDigest,
    proposition: {
      kind: "atom",
      subjectId: "person:bran",
      predicateDefinitionDigest: digest("eligibility_satisfaction"),
      value: { kind: "ref", id: "office:valen-crown" },
    },
    polarity: "positive",
    scope,
    applicability: {
      kind: "interval",
      axisDefinitionDigest: digest("days"),
      start: { kind: "exact", position: "1030" },
      endExclusive: { kind: "exact", position: "1040" },
    },
  },
];
const assertions = claimBodies.map((body) => ({
  format: "wmm.assertion-record/1",
  id: assertionId(body),
  body,
}));
for (const assertion of assertions) {
  writeJson(`records/assertions/${assertion.id.slice("asrt:".length)}.json`, assertion);
}

const supportBodies = assertions.map((assertion) => ({
  format: "wmm.support/1",
  worldId,
  claimId: assertion.id,
  sourceId: source.id,
  stance: "supports",
  locator: {
    definitionDigest: digest("author_stipulation_locator"),
    data: { kind: "authorStipulation" },
  },
  interpretationMethodDefinitionDigest: digest("author_stipulation_interpretation"),
}));
const supports = supportBodies.map((body) => ({
  format: "wmm.support-record/1",
  id: supportId(body),
  body,
}));
for (const support of supports) {
  writeJson(`records/supports/${support.id.slice("sup:".length)}.json`, support);
}

writeBytes(
  resolve(payloadRoot, "prose/valen.md"),
  Buffer.from("# Valen\n\nA small complete V1 world fixture.\n", "utf8"),
);

const world = {
  format: "wmm.world/1",
  worldId,
  semanticProfileDigest: semantics.profileDigest,
  descriptorIds: sorted(descriptors.map((record) => record.id)),
  sourceIds: [source.id],
  assertionIds: sorted(assertions.map((record) => record.id)),
  activeAssertionIds: sorted(assertions.map((record) => record.id)),
  supportIds: sorted(supports.map((record) => record.id)),
  activeSupportIds: sorted(supports.map((record) => record.id)),
};
writeJson("world.json", world);

const files = listFiles().map((path) => {
  const bytes = readFileSync(resolve(payloadRoot, path));
  const mediaType = path.endsWith(".json")
    ? "application/json"
    : path.endsWith(".md")
      ? "text/markdown"
      : "application/octet-stream";
  return {
    path,
    mediaType,
    byteLength: String(bytes.length),
    sha256: sha256Hex(bytes),
  };
});
const manifest = {
  format: "wmm.snapshot-manifest/1",
  worldId,
  files,
};
const snapshot = {
  format: "wmm.snapshot-record/1",
  snapshotDigest: snapshotDigest(manifest),
  manifest,
};
writeBytes(resolve(root, "snapshot.json"), canonicalJsonBytes(snapshot));

console.log(
  JSON.stringify({
    status: "generated",
    path: root,
    snapshotDigest: snapshot.snapshotDigest,
    files: files.length,
    descriptors: descriptors.length,
    assertions: assertions.length,
    supports: supports.length,
  }),
);
