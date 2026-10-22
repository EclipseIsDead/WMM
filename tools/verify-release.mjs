#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(repository, 'apps/cli/package.json'), 'utf8')).version;
const name = `world-master-manual-${version}`;
const archive = resolve(process.argv[2] ?? join(repository, 'dist', `${name}.tar.gz`));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'wmm-release-')));
const release = join(temporary, name);
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', NO_COLOR: '1', CI: '1', TERM: 'dumb' };
delete env.FORCE_COLOR;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: temporary, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function audit(path) {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isSymbolicLink()) {
      assert.ok(realpathSync(child).startsWith(release + sep), `Escaping link: ${child}`);
    } else if (statSync(child).isDirectory()) audit(child);
  }
}
try {
  // No ancestor node_modules may mask an incomplete artifact.
  for (let ancestor = temporary;; ancestor = dirname(ancestor)) {
    assert.ok(!existsSync(join(ancestor, 'node_modules')), `Isolation requires no ${ancestor}/node_modules`);
    if (dirname(ancestor) === ancestor) break;
  }
  const members = run('tar', ['-tzf', archive]).trim().split('\n');
  assert.ok(members.length > 0);
  for (const member of members) {
    assert.ok(member === name || member.startsWith(name + '/'), `Unexpected archive root: ${member}`);
    assert.ok(!member.split('/').includes('..'), `Unsafe archive path: ${member}`);
  }
  run('tar', ['-xzf', archive, '-C', temporary]);
  audit(release);
  const cli = (...args) => run(join(release, 'bin/wmm'), args);
  const workspace = join(temporary, 'saved workspace');
  const view = command => {
    const response = JSON.parse(cli('workspace', command, '--workspace-dir', workspace, '--json'));
    assert.equal(response.outcome, 'success', JSON.stringify(response));
    assert.ok(response.data.workspace);
    return response.data;
  };

  const initial = view('demo');
  assert.deepEqual(view('resume'), initial);
  assert.deepEqual(view('demo'), initial);
  const request = {
    format: 'wmm.request/1', apiVersion: 'wmm/1', requestId: 'release-smoke', operation: 'workspace.mutate',
    payload: { workspaceId: initial.workspace.id, expectedVersion: initial.workspace.version, idempotencyKey: 'release-smoke-direction', action: { kind: 'set-direction', text: 'Release smoke: preserve the saved author direction.' } },
  };
  const mutation = JSON.parse(run(join(release, 'bin/wmm'), ['json', '--workspace-dir', workspace], { input: JSON.stringify(request) }));
  assert.equal(mutation.outcome, 'success', JSON.stringify(mutation));
  assert.ok(mutation.data.workspace.version > initial.workspace.version);
  assert.equal(mutation.data.workspace.direction, request.payload.action.text);
  assert.deepEqual(view('resume'), mutation.data);
  assert.deepEqual(view('demo'), mutation.data);
  assert.match(cli('workspace', 'resume', '--workspace-dir', workspace, '--plain'), /Release smoke: preserve the saved author direction/);
  console.log('PASS demo, resume, JSON mutation, repeat demo preserves saved state, plain rendering');
  const imports = [
    './apps/cli/dist/workspace/presentation.js',
    './apps/cli/dist/workspace/app.js',
    './apps/cli/dist/workspace/index.js',
  ];
  run(process.execPath, ['--input-type=module', '-e', `for (const path of ${JSON.stringify(imports)}) await import(path); console.log('imports ok');`], { cwd: release });
  console.log('PASS built plain/UI imports and contained dependency links');
  assert.match(cli('--version'), new RegExp(`(^|\\s)${version.replaceAll('.', '\\.')}($|\\s)`));
  assert.match(cli('--help'), /usage/i);
  console.log('PASS launcher, --version, --help');
  console.log(`Verified ${archive} outside repository on ${process.platform}/${process.arch}, Node ${process.versions.node}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
