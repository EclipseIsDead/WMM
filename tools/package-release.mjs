#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = json(join(root, 'apps/cli/package.json'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cli.version)) throw new Error('Unsafe CLI version');
const name = `world-master-manual-${cli.version}`;
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const temporary = mkdtempSync(join(dist, '.release-'));
const destination = join(temporary, name);
mkdirSync(destination);
const packages = new Map();

// Materialize package-owned links, but never copy an installed dependency tree.
function copy(source, target, ancestors = new Set()) {
  const actual = realpathSync(source);
  const info = statSync(actual);
  if (info.isDirectory()) {
    if (ancestors.has(actual)) throw new Error(`Cyclic source link: ${source}`);
    const next = new Set([...ancestors, actual]);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(actual).sort()) {
      if (entry !== 'node_modules' && entry !== '.git') copy(join(actual, entry), join(target, entry), next);
    }
  } else if (info.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(actual, target);
    chmodSync(target, info.mode & 0o777);
  } else throw new Error(`Unsupported package file: ${source}`);
}
function locate(from, name) {
  let directory = from;
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), target), path, 'dir');
}
function install(source) {
  source = realpathSync(source);
  if (packages.has(source)) return packages.get(source);
  const manifest = json(join(source, 'package.json'));
  const local = relative(root, source);
  const internal = manifest.name?.startsWith('@wmm/') && !local.startsWith(`..${sep}`) && !local.split(sep).includes('node_modules');
  const target = internal ? join(destination, local) : join(destination, 'node_modules', '.release', String(packages.size), 'node_modules', manifest.name);
  packages.set(source, target);
  mkdirSync(target, { recursive: true });
  if (internal) {
    if (!existsSync(join(source, 'dist'))) throw new Error(`Missing build: ${local}/dist; run pnpm build first`);
    copy(join(source, 'package.json'), join(target, 'package.json'));
    for (const entry of new Set(['dist', ...(manifest.files ?? [])])) {
      if (entry.includes('*') || entry.includes('..') || entry.startsWith('/')) throw new Error(`Unsupported files entry: ${entry}`);
      if (existsSync(join(source, entry))) copy(join(source, entry), join(target, entry));
    }
  } else copy(source, target);
  const required = { ...manifest.dependencies, ...manifest.peerDependencies };
  const optional = { ...manifest.optionalDependencies };
  for (const [name, metadata] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (metadata.optional && !manifest.dependencies?.[name]) { optional[name] = required[name]; delete required[name]; }
  }
  for (const name of Object.keys({ ...required, ...optional }).sort()) {
    const dependency = locate(source, name);
    if (!dependency) {
      if (name in optional) continue;
      throw new Error(`Missing production dependency ${name} required by ${manifest.name}`);
    }
    link(install(dependency), join(target, 'node_modules', name));
  }
  return target;
}
function audit(path) {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isSymbolicLink()) {
      const actual = realpathSync(child);
      if (!actual.startsWith(destination + sep)) throw new Error(`Escaping release link: ${child}`);
    } else if (statSync(child).isDirectory()) audit(child);
  }
}
try {
  install(join(root, 'apps/cli'));
  copy(join(root, 'fixtures/v3/succession-world'), join(destination, 'fixtures/v3/succession-world'));
  for (const input of ['faction-project.json', 'lantern-actor-brief.json', 'lantern-decision-draft.json', 'atlas-project.json', 'grain-project.json']) {
    copy(join(root, 'fixtures/authoring', input), join(destination, 'fixtures/authoring', input));
  }
  copy(join(root, 'examples/harness'), join(destination, 'examples/harness'));
  copy(join(root, 'tools/harness/hermes_adapter.py'), join(destination, 'tools/harness/hermes_adapter.py'));
  copy(join(root, 'README.md'), join(destination, 'README.md'));
  copy(join(root, 'docs'), join(destination, 'docs'));
  writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: 'world-master-manual-release', version: cli.version, private: true, type: 'module' }, null, 2) + '\n');
  mkdirSync(join(destination, 'bin'));
  writeFileSync(join(destination, 'bin/wmm'), '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$HERE/../apps/cli/dist/main.js" "$@"\n', { mode: 0o755 });
  audit(destination);
  const archive = join(dist, `${name}.tar.gz`);
  const pending = join(temporary, `${name}.tar.gz`);
  const tarArgs = [...(process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []), '-czf', pending, '-C', temporary, name];
  const result = spawnSync('tar', tarArgs, { stdio: 'inherit', timeout: 120000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (result.error || result.status !== 0) throw new Error(`tar failed: ${result.error ?? result.status}`);
  copyFileSync(pending, archive);
  console.log(`Packaged ${packages.size} production packages: ${archive}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
