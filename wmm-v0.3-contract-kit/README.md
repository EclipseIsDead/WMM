# WMM v0.3 — draft identity contract kit

This kit accompanies **The World Master's Manual — Phase 1 Engineering Plan v0.3**.
It turns a narrow part of the second review into executable examples. It is not a
Worldbuilding Engine implementation or proof that all V0 contracts are ready to freeze.

## Contents

- `core-contracts.schema.json`: Draft 2020-12 shapes for `ClaimBodyV1`, the snapshot
  manifest, and the domain revision envelope. Shapes are closed; semantic validation
  still has to resolve admitted definitions, validate literal data, compare scopes,
  check endpoints, and enforce sorted set collections.
- `golden-vectors.json`: 31 known-answer identity examples with exact canonical bytes,
  hash preimages, lowercase SHA-256 values, and typed identifiers. Includes 7 rejected
  core-shape examples and 8 expected identity differences.
- `verify-vectors.mjs`: independent Node byte/hash verification using built-in modules.
- `verify-vectors.py`: independent Python byte/hash verification plus JSON Schema checks.
- `fixture-payload/`: exact bytes for the LF snapshot-manifest vector.
- `fixture-markdown-crlf.md`: the line-ending variant; bytes must not be rewritten.
- `verification-report.json`: actual local verification results and explicit exclusions.

## Run

From this directory, with Node.js installed:

```sh
node verify-vectors.mjs
```

For independent Python verification (the script needs `jsonschema`):

```sh
python -m pip install jsonschema
python verify-vectors.py
```

No network, model calls, Git repository, or credentials are used by either verifier.
The verification scripts do not rewrite the vectors or fixture files. The pip command
is only dependency installation, not part of the verification itself.

## What passed when this kit was created

Node v22.16.0 and Python 3.13.5 agreed on all 31 byte/hash vectors. Python validated
15 core-shape positive cases and rejected all 7 negative cases. Both verified 8
expected identity differences. Node additionally ran five small canonicalization
checks, including UTF-16 key ordering and rejection of unsafe integers/lone surrogates.
The LF snapshot manifest was checked against its 12 supplied files.

These runtime versions describe the verification environment, not the future WMM
product's required or recommended deployment versions.

## What the examples establish

The same supplied wire object produces the same canonical bytes and SHA-256 input
across these two implementations of the **restricted safe-integer profile**. Unicode
normalization is not performed; NFC and NFD strings can therefore have different
identities. LF and CRLF authored Markdown remain different byte sequences. Polarity,
referenced semantics, and revision ancestry affect the intended respective identities.

The reference profile follows RFC 8785 for the represented JSON values, including
UTF-16 property-key ordering. It does not exercise the full IEEE-754 serialization
suite. Floats are intentionally outside this kit's core numeric profile; precise
noninteger domain values require schema-defined string encodings. These small
verifiers are not production untrusted-input parsers or resource-isolated validators.

## Important exclusions

The semantic-definition/profile objects are **fixture-only**, not allowlisted WMM
runtime packs. Synthetic receipt objects supply stable digest examples only; they
are not host-minted approval receipts. The payload is an identity fixture, not a
complete valid historical world, and no real authorization is represented by it.

No temporal evaluator, historical claim conflict checker, population-coverage proof,
WorkspaceStore, agent, Git transaction/recovery system, or backup implementation has
been executed. A changed hash is not proof of correct logical negation or chronology.
The JSON Schema is only the core hash-input shape schema—not the entire WMM public API.

V0 still requires the complete supported scope/evidence/temporal/result schemas and
semantic input-output fixtures. V3, V4, and V6 retain their separate approval,
idempotency/crash-recovery, and coordinated-backup gates. See the accompanying RFC.

## References

RFC 8785: https://www.rfc-editor.org/rfc/rfc8785

The domain separators and WMM object layouts are proposed WMM contracts, not requirements
imposed by RFC 8785. No claim of full independent standards certification is made.
