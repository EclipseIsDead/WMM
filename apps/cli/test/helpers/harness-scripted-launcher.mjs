#!/usr/bin/env node
// Scripted launcher/runtime peers only: no Python, Hermes SDK, or model proof.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const root = dirname(process.cwd());
const control = JSON.parse(readFileSync(join(root, 'launcher-control.json'), 'utf8'));
const args = process.argv.slice(2);
const bootstrap = "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, '/scripted installation/hermes'); sys._hermes_pin_default_home = True; import hermes_bootstrap; os.environ.get('HERMES_HOME') or os.environ.__setitem__('HERMES_HOME', str(__import__('hermes_constants').get_default_hermes_root())); runpy.run_module('types', run_name='__main__', alter_sys=True)";
const fixedScript = "; sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')";

if (args[0] === '--print-runtime-command') {
  writeFileSync(join(root, 'launcher-query.json'), JSON.stringify({ args, cwd: process.cwd(), safeMode: process.env.HERMES_SAFE_MODE, environmentHint: process.env.HERMES_ENVIRONMENT_HINT }), { flag: 'wx', mode: 0o600 });
  if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(['--print-runtime-command', '--module', 'types', '--'])) process.exit(41);
  if (control.scenario === 'query-hang') {
    writeFileSync(join(root, 'launcher.pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
    process.on('SIGTERM', () => appendFileSync(join(root, 'launcher-signals.jsonl'), 'SIGTERM\n'));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (control.scenario === 'shared-deadline') await new Promise((resolve) => setTimeout(resolve, 1000));
  let command = [process.argv[1], '-I', '-c', bootstrap, ...args.slice(4)];
  switch (control.scenario) {
    case 'not-array': command = { command }; break;
    case 'extra-argument': command.push('--unrequested'); break;
    case 'wrong-type': command[3] = null; break;
    case 'non-isolated': command[1] = '-S'; break;
    case 'wrong-code-flag': command[2] = '-m'; break;
    case 'relative-python': command[0] = 'node'; break;
    case 'empty-python': command[0] = ''; break;
    case 'control-python': command[0] += '\n'; break;
    case 'long-python': command[0] = '/' + 'x'.repeat(4096); break;
    case 'argument-mismatch': command[4] = '/not-the-requested-adapter.py'; break;
    case 'non-scalar': command[4] = '\ud800'; break;
    case 'wrong-module': command[3] = bootstrap.replace("run_module('types'", "run_module('runpy'"); break;
    case 'extra-code': command[3] += "; print('UNREQUESTED_CODE')"; break;
    case 'missing-bootstrap': command[3] = bootstrap.replace('import hermes_bootstrap; ', ''); break;
    case 'expression-root': command[3] = bootstrap.replace("'/scripted installation/hermes'", "'/scripted' + str(1)"); break;
    case 'relative-root': command[3] = bootstrap.replace("'/scripted installation/hermes'", "'relative/hermes'"); break;
    case 'control-code': command[3] = bootstrap.replace('/scripted', '/scripted\n'); break;
    case 'long-code': command[3] = bootstrap.replace('/scripted', '/' + 'x'.repeat(16384)); break;
  }
  if (control.scenario === 'malformed-json') {
    process.stdout.write('PRIVATE_LAUNCHER_OUTPUT_CANARY');
  } else if (control.scenario === 'invalid-utf8') {
    process.stdout.write(Buffer.from([0xff]));
  } else if (control.scenario === 'bom') {
    process.stdout.write('\ufeff' + JSON.stringify(command));
  } else if (control.scenario === 'trailing-json') {
    process.stdout.write(JSON.stringify(command) + '\n{}');
  } else if (control.scenario === 'stdout-budget') {
    process.stdout.write(' '.repeat(64 * 1024 + 1));
  } else {
    if (control.scenario === 'stderr-budget') process.stderr.write('PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY'.repeat(4096));
    if (control.scenario === 'nonzero' || control.scenario === 'maintenance') process.stderr.write('PRIVATE_LAUNCHER_DIAGNOSTIC_CANARY\n');
    if (control.scenario === 'nonzero') process.exitCode = 17;
    process.stdout.write(JSON.stringify(command) + '\n');
  }
} else {
  writeFileSync(join(root, 'launcher-runtime.json'), JSON.stringify({ args, cwd: process.cwd(), safeMode: process.env.HERMES_SAFE_MODE, environmentHint: process.env.HERMES_ENVIRONMENT_HINT }), { flag: 'wx', mode: 0o600 });
  if (args[0] !== '-I' || args[1] !== '-c' || args[2] !== bootstrap + fixedScript) process.exit(42);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    appendFileSync(join(root, 'launcher-input.jsonl'), line + '\n', { mode: 0o600 });
    const frame = JSON.parse(line);
    if (frame.type === 'initialize') setTimeout(() => process.stdout.write(JSON.stringify({
      type: 'ready', tools: frame.tools.map((tool) => tool.name),
      isolation: { contextFiles: false, memory: false, skills: false, soul: false, externalTools: false, contextEngine: 'builtin' },
      runtime: { adapter: 'hermes-sdk', model: 'scripted-launcher-peer', provider: 'offline-test' },
    }) + '\n'), control.scenario === 'shared-deadline' ? 1800 : 0);
    if (frame.type === 'start') process.stdout.write(JSON.stringify({ type: 'complete', sessionId: 'scripted-launcher-session', finalResponse: 'Scripted launcher protocol exercise, not model output.', messages: [] }) + '\n', () => process.exit(0));
  });
}
