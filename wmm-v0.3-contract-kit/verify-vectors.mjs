/**
 * Seed-vector verifier, not a production canonicalization/admission library.
 * Supports the WMM draft's safe-integer JSON profile and valid Unicode.
 * Uses only Node's standard library. No files are modified.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = new URL('./', import.meta.url);
function scalarString(s) {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = s.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Lone high surrogate');
    } else if (u >= 0xdc00 && u <= 0xdfff) throw new Error('Lone low surrogate');
  }
  return JSON.stringify(s);
}
function canonical(x, depth = 0) {
  if (depth > 128) throw new Error('Fixture nesting limit exceeded');
  if (x === null) return 'null';
  if (typeof x === 'string') return scalarString(x);
  if (typeof x === 'boolean') return x ? 'true' : 'false';
  if (typeof x === 'number') {
    if (!Number.isSafeInteger(x)) throw new Error('Only safe JSON integers in this profile');
    return JSON.stringify(x);
  }
  if (Array.isArray(x)) return '[' + x.map(v => canonical(v, depth + 1)).join(',') + ']';
  if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    // sort() compares UTF-16 code units. Do not rebuild an object and stringify it:
    // JavaScript's own property enumeration can reorder integer-like keys again.
    return '{' + Object.keys(x).sort().map(k => scalarString(k) + ':' + canonical(x[k], depth + 1)).join(',') + '}';
  }
  throw new Error('Unsupported fixture value');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const document = JSON.parse(readFileSync(new URL('golden-vectors.json', root), 'utf8'));
const byName = new Map();
for (const v of document.vectors) {
  let bytes;
  if (v.algorithm === 'sha256-raw') {
    bytes = Buffer.from(v.payloadHex, 'hex');
    assert.equal(bytes.toString('hex'), v.payloadHex, `${v.name}: bad hex`);
  } else {
    const payload = Buffer.from(canonical(v.payload), 'utf8');
    assert.equal(payload.toString('hex'), v.canonicalUtf8Hex, `${v.name}: canonical bytes`);
    bytes = Buffer.concat([Buffer.from(v.label, 'ascii'), Buffer.from([0]), payload]);
    assert.equal(bytes.toString('hex'), v.preimageHex, `${v.name}: preimage bytes`);
  }
  assert.equal(sha256(bytes), v.digest, `${v.name}: digest`);
  assert.equal(v.idPrefix + v.digest, v.expectedId, `${v.name}: typed ID`);
  assert(!byName.has(v.name), `Duplicate vector ${v.name}`);
  byName.set(v.name, v);
}
for (const r of document.relations) {
  assert.equal(r.kind, 'different');
  assert.notEqual(byName.get(r.left).expectedId, byName.get(r.right).expectedId, JSON.stringify(r));
}
const base = byName.get('snapshot_lf').payload;
let previous = '';
for (const f of base.files) {
  assert(f.path > previous, 'Manifest paths must be strictly ASCII sorted'); previous = f.path;
  const bytes = readFileSync(new URL('fixture-payload/' + f.path, root));
  assert.equal(String(bytes.length), f.byteLength, `Length of ${f.path}`);
  assert.equal(sha256(bytes), f.sha256, `Bytes of ${f.path}`);
}
assert.equal(canonical({'\ue000': 1, '😀': 2}), '{"😀":2,"\ue000":1}', 'UTF-16 ordering');
assert.equal(canonical({'2': 2, '10': 10}), '{"10":10,"2":2}', 'Integer-looking keys');
assert.throws(() => canonical('\ud800'), /surrogate/);
assert.throws(() => canonical(2 ** 53), /safe JSON integers/);
assert.throws(() => canonical(0.5), /safe JSON integers/);
console.log(JSON.stringify({
  status: 'passed', runtime: process.version, vectors: document.vectors.length,
  identityRelations: document.relations.length, manifestFilesChecked: base.files.length,
  extraCanonicalizationChecks: 5,
  scope: 'Byte/digest identity fixtures only. This script does not perform JSON Schema or historical/authorization validation.'
}, null, 2));
