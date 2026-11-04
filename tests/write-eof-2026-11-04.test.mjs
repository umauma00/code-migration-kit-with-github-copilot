// SPDX-License-Identifier: Apache-2.0
// 2026-11-04 (Windows, Copilot app, phase 04): two files stopped with "write
// EOF; taskkill exit 128 (tree termination unconfirmed)", which the guidance
// read as an unexpected error. The kit gives a worker CLI its prompt on
// standard input, and a CLI that exits before it has read all of it (it failed
// as it started) fails that write. Linux and macOS report EPIPE, which the
// runner left to the CLI's own exit status and output. Windows reports EOF
// (libuv's word for ERROR_BROKEN_PIPE), which the runner took for a failure of
// its own: it stopped a CLI that was already gone (taskkill's 128: no such
// process) and reported the write. The CLI's own error then never reached the
// status and its guidance, the error the CLI writes in its stream was not read,
// and a CLI signed out only in the kit's worker home was not tried in the
// person's home. Both words now leave the call to the child's own exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { prepare, ready, result } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, roles } from '../lib/core.mjs';
import { runProcess } from '../lib/process.mjs';
import { translate } from '../lib/pipeline.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure, isCliLock } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { resetPreparedWorkerHomes } from '../lib/worker-home.mjs';

// Runs run(seen) while the children the kit starts with an input (the first
// `times` of them) have their write of it fail the way a platform reports it:
// code EOF is Windows' word, EPIPE the word of Linux and macOS. The child is
// given none of its input and the write fails at once, while the child still
// runs, so the call's end is the child's own (the first test lets a real
// write fail, which on Windows ends once the child is gone). Without a code
// every write goes as it really does. seen collects each failed write's code.
async function writes(code, run, times = Infinity) {
  const original = cp.spawn, seen = [];
  cp.spawn = function (...args) {
    const child = original.apply(this, args);
    if (child.stdin) {
      child.stdin.on('error', e => seen.push(e.code));
      if (code && times-- > 0) child.stdin.end = function () { return this.destroy(Object.assign(new Error(`write ${code}`), { code, syscall: 'write' })); };
    }
    return child;
  };
  syncBuiltinESMExports();
  try { return await run(seen); } finally { cp.spawn = original; syncBuiltinESMExports(); }
}
const node = (code, options) => runProcess(process.execPath, ['-e', code], options);

test('a child that exits without reading its input is read like any other child, whatever this platform calls the failed write', async t => {
  await writes(null, async seen => {
    // Far more than a pipe holds: most of the write still waits when the child is gone.
    const r = await node('process.stderr.write("cannot start\\n"); process.exit(3)', { input: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'cannot start\n');
    assert.equal(r.error, undefined);
    assert.ok(seen.length > 0, 'the write failed');
    t.diagnostic(`this platform reports the failed write as ${[...new Set(seen)].join(', ')}`);
    for (const code of seen) assert.ok(code === 'EPIPE' || code === 'EOF', code);
  });
});

test('a write Windows reports as EOF leaves the call to the child, as EPIPE does; any other failed write still fails the call', async () => {
  const child = 'setTimeout(() => { process.stderr.write("no answer\\n"); process.exit(3); }, 100)';
  for (const code of ['EOF', 'EPIPE']) {
    await writes(code, async seen => {
      const r = await node(child, { input: 'prompt' }).catch(e => e);
      assert.ok(!(r instanceof Error), `${code}: ${r.message}`);
      assert.equal(r.code, 3, code);
      assert.equal(r.stderr, 'no answer\n', code);
      assert.deepEqual(seen, [code]);
    });
  }
  await writes('EIO', async () => {
    const failure = await node(child, { input: 'prompt' }).then(() => null, e => e);
    assert.match(failure?.message ?? '', /^write EIO\b/);
    assert.equal(failure.result.code, null, 'a call the runner failed has no exit status of its own');
    assert.equal(failure.spawned, true);
  });
});

// A Copilot CLI double that fails on its first call as it starts, before it
// reads its prompt (failure: the script for that), and answers every later
// call like a worker.
function earlyExit(f, failure) {
  const responses = Object.fromEntries(f.units.flatMap(unit => roles.map(role => [`${role}:${unit.target}`, result(role, unit)])));
  const file = safePath(f.root, 'early-exit-cli.mjs'), log = safePath(f.root, 'early-exit-calls.jsonl');
  atomicWrite(file, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
const log = ${JSON.stringify(log)}, role = process.env.MIGRATION_KIT_ROLE, home = process.env.COPILOT_HOME ?? '';
const earlier = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify({ role, home }) + '\\n');
if (earlier === 0) { ${failure} }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const target = prompt.match(/Set target to "([^"]+)"/)?.[1];
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role + ':' + target]), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { command: process.execPath, prefixArgs: [file], calls };
}
const lockFailure = `process.stderr.write('The shared writer lock timed out.\\n'); process.exit(1);`;
const streamFailure = `console.log(JSON.stringify({ type: 'session.error', data: { errorType: 'rate_limit', statusCode: 429, message: 'Too many requests' } })); process.exit(1);`;

test('a worker CLI that fails before it reads its prompt on Windows reports its own exit status and error, and gets the guidance for it', async t => {
  for (const [failure, message, guidance] of [
    [lockFailure, /^Copilot implementer failed \(exit 1\): The shared writer lock timed out\./, 'cli-lock'],
    [streamFailure, /^Copilot implementer failed \(exit 1\): session\.error rate_limit 429: Too many requests/, undefined]]) {
    const f = prepare(t), cli = earlyExit(f, failure);
    const error = await writes('EOF', () => createCopilotAdapter(cli)({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} }).then(() => null, e => e), 1);
    assert.ok(error, 'the call failed');
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /write EOF|taskkill/);
    assert.equal(error.result.code, 1, 'the CLI\'s own exit status');
    assert.equal(isTransientFailure(error), true, 'retried, as on Linux and macOS');
    assert.equal(isSystemicFailure(error), false);
    const advice = failureGuidance(error, { root: f.root });
    assert.notEqual(advice.id, 'unknown', 'not an unexpected error');
    if (guidance) { assert.equal(advice.id, guidance); assert.equal(isCliLock(error), true); }
  }
});

// A person's CLI home in a temporary folder, restored after the test.
function personHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-person-home-')), home = path.join(dir, '.copilot');
  fs.mkdirSync(home);
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
  resetPreparedWorkerHomes();
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; resetPreparedWorkerHomes(); fs.rmSync(dir, { recursive: true, force: true }); });
  return home;
}

test('a CLI signed out only in the kit\'s worker home, which fails before it reads its prompt on Windows, is tried in the person\'s home', async t => {
  const home = personHome(t), f = prepare(t);
  const cli = earlyExit(f, `process.stderr.write('Error: No authentication information found.\\nTo authenticate, you can use any of the following methods\\n'); process.exit(1);`);
  const response = await writes('EOF', () => createCopilotAdapter(cli)({ root: f.root, config: { ...f.config, workerCopilotHome: 'separate' }, role: 'implementer', unit: f.units[0], extra: {} }), 1);
  assert.equal(response.result.kind, 'implementation');
  assert.match(response.cliHomeWarning, /not signed in in the kit's worker home/);
  assert.deepEqual(cli.calls().map(c => c.home), [`${home}-migration-kit-workers`, home]);
});

test('end to end: a call whose CLI failed before reading its prompt on Windows, with the error in its stream, is retried and the file completes', async t => {
  const f = await ready(t, { executionMode: 'continuous' });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  const cli = earlyExit(f, streamFailure);
  const report = await writes('EOF', () => translate(f.root, f.config, createCopilotAdapter(cli)), 1);
  assert.deepEqual(report.errors, []);
  assert.equal(report.done, 1);
  const dir = safePath(f.root, `migration/runs/${report.runId}`);
  const attempt = fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => readJSON(path.join(dir, n))).find(a => a.role === 'implementer');
  assert.equal(attempt.retries?.length, 1, 'retried once');
  assert.match(attempt.retries[0].error, /^Copilot implementer failed \(exit 1\): session\.error rate_limit 429: Too many requests/);
  assert.deepEqual(cli.calls().slice(0, 2).map(c => c.role), ['implementer', 'implementer']);
});
