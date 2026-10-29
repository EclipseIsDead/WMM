// Scripted protocol peer for offline host tests; never a model response.
import { appendFileSync, closeSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [scenario, captured] = process.argv.slice(2);
const successful = scenario === 'success' || scenario === 'reordered-tools';
if (scenario === 'ignore-termination') {
  writeFileSync(captured + '.pid', String(process.pid), { flag: 'wx', mode: 0o600 });
  process.on('SIGTERM', () => {});
}
if (scenario.startsWith('stdin-closed-')) {
  process.on('SIGTERM', () => appendFileSync(captured + '.signals', 'SIGTERM\n', { mode: 0o600 }));
}
const names = ['wmm_project_read', 'wmm_source_read', 'wmm_authoring_schema', 'wmm_proposal_check', 'wmm_proposal_submit'];
const ready = {
  type: 'ready', tools: names,
  isolation: { contextFiles: false, memory: false, skills: false, soul: false, externalTools: false, contextEngine: 'builtin' },
  runtime: { adapter: 'hermes-sdk', model: 'offline-scripted-peer', provider: 'offline-test' },
};
const send = (value, done = false) => process.stdout.write(JSON.stringify(value) + (scenario === 'stdout-budget' && value.type === 'tool_call' ? ' '.repeat(2 * 1024 * 1024 - 200) : '') + '\n', () => { if (done) process.exit(0); });
const invalidReady = {
  'ready-extra': { ...ready, approve: true },
  'ready-runtime-extra': { ...ready, runtime: { ...ready.runtime, apiKey: 'NOT_A_REAL_CREDENTIAL' } },
  'ready-runtime-adapter': { ...ready, runtime: { ...ready.runtime, adapter: 'external-native-agent' } },
};
const invalidCalls = {
  'tool-extra': { type: 'tool_call', id: 1, name: 'wmm_project_read', arguments: {}, bundlePath: '/not-selected' },
  'tool-id': { type: 'tool_call', id: 0, name: 'wmm_project_read', arguments: {} },
  'tool-args': { type: 'tool_call', id: 1, name: 'wmm_project_read', arguments: [] },
};
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  appendFileSync(captured, line + '\n', { mode: 0o600 });
  const frame = JSON.parse(line);
  if (frame.type === 'initialize') {
    if (scenario === 'ambient-tools') send({ ...ready, tools: [...names, 'terminal'] });
    if (scenario === 'success') send(ready);
    if (scenario === 'reordered-tools') send({ ...ready, tools: [...names].reverse() });
    if (scenario.startsWith('ambient-') && scenario !== 'ambient-tools') {
      const field = scenario.slice('ambient-'.length);
      send({ ...ready, isolation: { ...ready.isolation, [field]: field === 'contextEngine' ? 'external-plugin' : true } });
    }
    if (invalidReady[scenario]) send(invalidReady[scenario]);
    if (invalidCalls[scenario] || scenario.startsWith('complete-') || scenario === 'trailing') send(ready);
    if (scenario.endsWith('-budget') && scenario !== 'frame-budget') send(ready);
    if (scenario === 'frame-budget') process.stdout.write(' '.repeat(2 * 1024 * 1024 + 1), () => process.exit(0));
    if (scenario === 'runtime-error') process.stderr.write('PRIVATE_DIAGNOSTIC_CANARY\n', () => send({ type: 'error', code: 'AUTH_REQUIRED' }, true));
    if (scenario === 'ignore-termination') send(ready);
    if (scenario.startsWith('stdin-closed-')) send(ready);
    if (scenario === 'stderr-budget') process.stderr.write('x'.repeat(64 * 1024 + 1));
  }
  if (frame.type === 'start' && scenario.startsWith('stdin-closed-')) {
    process.stdin.destroy();
    try { closeSync(0); } catch { /* destroy may already have closed fd 0. */ }
    send({ type: 'tool_call', id: 1, name: 'wmm_project_read', arguments: {} });
    if (scenario === 'stdin-closed-ignore-termination') setInterval(() => {}, 1000);
    setTimeout(() => {
      send({ type: 'tool_call', id: 2, name: 'wmm_proposal_submit', arguments: {} });
      send({ type: 'complete', sessionId: 'disconnected-offline-peer', finalResponse: 'SYNTHETIC_LATE_COMPLETION_CANARY', messages: [{ role: 'assistant', content: 'SYNTHETIC_LATE_COMPLETION_CANARY' }] }, scenario === 'stdin-closed-complete');
    }, 150);
  }
  if (frame.type === 'start' && successful) {
    send({ type: 'tool_call', id: 1, name: 'wmm_project_read', arguments: {} });
  }
  if (frame.type === 'tool_result' && successful) {
    send({ type: 'complete', sessionId: 'synthetic-offline-session', finalResponse: 'Scripted protocol exercise, not model output.', messages: [{ role: 'tool', content: JSON.stringify(frame.result) }] }, true);
  }
  if (frame.type === 'start' && scenario.startsWith('ambient-')) {
    send({ type: 'complete', sessionId: 'unsafe-offline-session', finalResponse: 'Unsafe admission observed by test.', messages: [] }, true);
  }
  if (frame.type === 'start' && invalidReady[scenario]) {
    send({ type: 'complete', sessionId: 'invalid-ready-accepted', finalResponse: 'Test observed unsafe ready.', messages: [] }, true);
  }
  if (frame.type === 'start' && invalidCalls[scenario]) send(invalidCalls[scenario]);
  if (frame.type === 'tool_result' && invalidCalls[scenario]) {
    send({ type: 'complete', sessionId: 'invalid-call-accepted', finalResponse: 'Test observed invalid call.', messages: [] }, true);
  }
  if (frame.type === 'start' && scenario.startsWith('complete-')) {
    const value = { type: 'complete', sessionId: 'invalid-completion', finalResponse: 'Scripted invalid completion.', messages: [] };
    if (scenario === 'complete-extra') value.approve = true;
    if (scenario === 'complete-history') value.messages = null;
    send(value, true);
  }
  if (frame.type === 'start' && scenario === 'trailing') {
    process.stdout.write(JSON.stringify({ type: 'complete', sessionId: 'trailing-data', finalResponse: 'Scripted invalid completion.', messages: [] }) + '\nUNFRAMED-TAIL', () => process.exit(0));
  }
  if (frame.type === 'start' && scenario.endsWith('-budget')) {
    send({ type: 'tool_call', id: 1, name: 'wmm_project_read', arguments: scenario === 'argument-budget' ? { text: 'x'.repeat(512 * 1024 + 1) } : {} });
  }
  if (frame.type === 'tool_result' && scenario.endsWith('-budget')) {
    const end = scenario === 'call-budget' ? 33 : scenario === 'total-result-budget' ? 8 : scenario === 'stdout-budget' ? 13 : 1;
    if (frame.id < end) send({ type: 'tool_call', id: frame.id + 1, name: 'wmm_project_read', arguments: {} });
    else send({ type: 'complete', sessionId: 'unbounded-peer-accepted', finalResponse: 'Test observed an exceeded budget.', messages: [] }, true);
  }
});
