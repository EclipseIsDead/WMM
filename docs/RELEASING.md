# Portable prerelease archives

Releases are downloadable archives, **not npm publications**. The CLI's
`apps/cli/package.json` is the version source (first prerelease:
`0.1.0-alpha.1`). Do not create tags or publish packages as part of these tools.

## Build, package, verify

Use Node **24.3.0 or newer in the Node 24 line** and pnpm **10.12.4**. Start
with a fully installed workspace matching `pnpm-lock.yaml`; packaging never
installs packages or accesses the network.

```sh
pnpm release:pack
pnpm release:verify
```

`release:pack` builds before running `tools/package-release.mjs`;
`release:verify` runs `tools/verify-release.mjs`. The packer itself requires
existing compiled output, so use the root script rather than invoking it against
potentially stale output.

Output: `dist/world-master-manual-VERSION.tar.gz`, containing exactly one
`world-master-manual-VERSION/` directory. The verifier defaults to that archive;
an explicit archive path may be passed as its first argument (its version/root
must still match the current CLI manifest).

## Using a download

```sh
tar -xzf world-master-manual-0.1.0-alpha.1.tar.gz
./world-master-manual-0.1.0-alpha.1/bin/wmm --version
./world-master-manual-0.1.0-alpha.1/bin/wmm --help
./world-master-manual-0.1.0-alpha.1/bin/wmm workspace demo --workspace-dir ./my-world --plain
./world-master-manual-0.1.0-alpha.1/bin/wmm workspace resume --workspace-dir ./my-world --plain
```

Node must be on `PATH`; no pnpm, compiler, npm install, or repository checkout
is needed. Keep the extracted directory intact. Invoke the launcher directly;
do not move or symlink only `bin/wmm` elsewhere. Workspace storage should be
outside the extracted release. Interactive UI requires a supported real TTY;
`--plain` and `--json` support redirected/noninteractive use.

## Contents and dependency isolation

The artifact preserves `apps/cli/dist`, its manifest, internal packages at
`packages/*`, their declared runtime files (including schema JSON), and
`fixtures/v3/succession-world`. This preserves fixture paths relative to
`import.meta.url` and the CLI version lookup relative to `dist/main.js`.
The repository README and docs are included as reference; contributor commands
and other fixture examples in them may require a full checkout.

The packer recursively resolves installed production dependencies, optional
dependencies that are present, and peer dependencies from each package's real
installed location. External packages get separate directories and relative
`node_modules` links, preserving different versions and pnpm peer contexts.
Only this reachable closure is copied, never the workspace's entire
`node_modules`, pnpm store, or dev dependency graph. Package-owned files are
retained, so external packages can include their own source, tests, and type
files; they are not extra installed development dependencies. Internal packages
include only their manifest, compiled output and declared `files` entries.
Package-owned symlinks are materialized, dependency links are recreated locally,
and all final links must resolve inside the release. Missing required
production dependencies or compiled internal packages fail packaging.

## Smoke-test coverage

Verification extracts into a fresh OS temporary directory outside the checkout,
rejects ancestor `node_modules` directories, clears `NODE_PATH`/`NODE_OPTIONS`,
and runs the actual executable launcher from outside the release. It checks:

- Contained, non-dangling links and a single expected archive root.
- `--version` and `--help`.
- `workspace demo --json`, resume, and repeat demo with equal saved views.
- A real JSON `workspace.mutate` set-direction request, an increased version,
  and persistence through resume and repeated demo (no reset).
- Plain rendering of the saved mutation.
- Dynamic imports of built plain presentation, UI app, and workspace entrypoint,
  exercising the React/Ink runtime dependency closure without requiring a TTY.

Temporary extraction and workspace storage are removed even after failure.
Subprocesses have bounded timeouts. The smoke test does not simulate interactive
keystrokes or validate full terminal lifecycle; use the separate workspace PTY
smoke for that. Only verify trusted archives: the member-name check and
post-extraction link audit are not a hardened hostile-archive extractor.

## Platform scope and limitations

Supported targets are **Linux and macOS**, with a POSIX shell, `tar`, and an
appropriate Node 24 runtime (including `node:sqlite`). Windows is not supported
by this launcher. Node itself is not bundled. The current runtime dependencies
are shipped from the installed dependency tree; portability across OS/CPU
combinations must not be assumed if native addons, platform-specific optional
packages, or install-generated binaries are introduced. Build and smoke-test
on each target platform before distributing such artifacts. Import smoke tests
do not replace a Linux/macOS release matrix or an interactive UI test.

Archives are not byte-for-byte reproducible: filesystem metadata and tar/gzip
implementation can differ. These tools do not sign artifacts, generate
checksums, upload releases, publish to a registry, or create commits/tags.
