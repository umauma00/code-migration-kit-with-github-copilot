// SPDX-License-Identifier: Apache-2.0
// 2026-11-04 (Windows, Copilot app, phase 04): two files stopped with "write
// EOF; taskkill exit 128 (tree termination unconfirmed)", which the guidance
// read as an unexpected error. The kit gives a worker CLI its prompt on
// standard input. When the prompt does not fit in the pipe (about 64 KiB on
// Windows), a CLI that exits before it has read all of it (one that failed as
// it started, for instance) fails that write. Linux and macOS report EPIPE,
// which the runner left to the CLI's own exit status and output. Windows
// reports EOF for a write that was still waiting (libuv's word for
// ERROR_BROKEN_PIPE), which the runner took for a failure of its own: it tried
// to stop a CLI that was already gone (taskkill's 128: no such process) and
// reported the write. The CLI's own error then never reached the status and
// its guidance, the error the CLI writes in its stream was not read, and a CLI
// signed out only in the kit's worker home was not tried in the person's home.
// Both words now leave the call to the child's own exit. The result keeps the
// word (stdinError): the adapter says the CLI ended before it had read its
// whole prompt, and does not use an answer the CLI gave all the same.
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

// Runs run({ seen, hit, settled }) while the children the kit starts with an
// input (the first `times` of them) have their write of it fail the way a
// platform reports it: code EOF is Windows' word, EPIPE the word of Linux and
// macOS. The child is given none of its input and the write fails at once,
// while the child still runs, so the call's end is the child's own. Without a
// code every write goes as it really does: it fails only when the input does
// not fit in the pipe and the child is gone first. seen collects each failed
// write's code, hit the arguments of each child whose write was made to fail,
// and settled() waits until every such child's input is closed (a real write
// fails on its own, in no fixed order with the call's end).
async function writes(code, run, times = Infinity) {
  const original = cp.spawn, seen = [], hit = [], closed = [];
  cp.spawn = function (...args) {
    const child = original.apply(this, args);
    if (child.stdin) {
      child.stdin.on('error', e => seen.push(e.code));
      closed.push(new Promise(resolve => child.stdin.once('close', resolve)));
      if (code && times-- > 0) {
        hit.push(args[1] ?? []);
        child.stdin.end = function () { return this.destroy(Object.assign(new Error(`write ${code}`), { code, syscall: 'write' })); };
      }
    }
    return child;
  };
  syncBuiltinESMExports();
  try { return await run({ seen, hit, settled: () => Promise.all(closed) }); } finally { cp.spawn = original; syncBuiltinESMExports(); }
}
const node = (code, options) => runProcess(process.execPath, ['-e', code], options);
// The one write made to fail was a worker CLI's, started for that role.
const workerHit = (hit, role) => { assert.equal(hit.length, 1, 'one write made to fail'); assert.match(hit[0].join(' '), new RegExp(`--agent \\S*${role}\\b`)); };

test('a child that exits without reading its input is read like any other child, whatever this platform calls the failed write', async t => {
  await writes(null, async ({ seen, settled }) => {
    // Far more than a pipe holds: most of the write still waits when the child is gone.
    const r = await node('process.stderr.write("cannot start\\n"); process.exit(3)', { input: 'x'.repeat(8 * 1024 * 1024) });
    await settled();
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'cannot start\n');
    assert.equal(r.error, undefined);
    assert.ok(seen.length > 0, 'the write failed');
    for (const code of seen) assert.ok(code === 'EPIPE' || code === 'EOF', code);
    t.diagnostic(`this platform reports the failed write as ${[...new Set(seen)].join(', ')}; the result ${r.stdinError ? `keeps ${r.stdinError}` : 'has no stdinError (the write failed after the call ended)'}`);
    if (r.stdinError) assert.ok(seen.includes(r.stdinError), r.stdinError);
  });
});

test('a write Windows reports as EOF leaves the call to the child, as EPIPE does; any other failed write still fails the call', async () => {
  const child = 'setTimeout(() => { process.stderr.write("no answer\\n"); process.exit(3); }, 100)';
  for (const code of ['EOF', 'EPIPE']) {
    await writes(code, async ({ seen }) => {
      const r = await node(child, { input: 'prompt' }).catch(e => e);
      assert.ok(!(r instanceof Error), `${code}: ${r.message}`);
      assert.equal(r.code, 3, code);
      assert.equal(r.stderr, 'no answer\n', code);
      assert.equal(r.stdinError, code, 'the result keeps the failed write');
      assert.deepEqual(seen, [code]);
    });
  }
  await writes('EIO', async () => {
    const failure = await node(child, { input: 'prompt' }).then(() => null, e => e);
    assert.match(failure?.message ?? '', /^write EIO\b/);
    assert.equal(failure.result.code, null, 'a call the runner failed has no exit status of its own');
    assert.equal(failure.result.stdinError, undefined);
    assert.equal(failure.spawned, true);
  });
  // A write that goes through leaves no trace.
  const read = await node('let n = 0; process.stdin.on("data", d => n += d.length).on("end", () => process.stdout.write(String(n)))', { input: 'prompt' });
  assert.equal(read.stdout, '6');
  assert.equal('stdinError' in read, false);
});

test('a child that keeps running in silence after its write failed this way is still stopped as a silent call', async () => {
  await writes('EOF', async ({ seen }) => {
    const failure = await node('setInterval(() => {}, 1000)', { input: 'prompt', silenceMs: 300 }).then(() => null, e => e);
    assert.equal(failure?.silent, true, failure?.message);
    assert.match(failure.message, /no sign of progress/);
    assert.equal(failure.result.code, null);
    assert.equal(failure.result.stdinError, 'EOF');
    assert.deepEqual(seen, ['EOF']);
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
// The implementer's answer for the first unit, given before the CLI reads its prompt.
const unreadAnswer = f => `console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(result('implementer', f.units[0]))}), toolRequests: [] } })); console.log(JSON.stringify({ type: 'result', exitCode: 0 })); process.exit(0);`;
const implement = (cli, f, extra = {}) => createCopilotAdapter(cli)({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra }).then(() => null, e => e);

test('a worker CLI that fails before it reads its prompt on Windows reports its own exit status and error, and gets the guidance for it', async t => {
  for (const [failure, message, guidance] of [
    [lockFailure, /^Copilot implementer failed \(exit 1\) before it had read its whole prompt: The shared writer lock timed out\./, 'cli-lock'],
    [streamFailure, /^Copilot implementer failed \(exit 1\) before it had read its whole prompt: session\.error rate_limit 429: Too many requests/, undefined]]) {
    const f = prepare(t), cli = earlyExit(f, failure);
    const error = await writes('EOF', async ({ seen, hit }) => {
      const e = await implement(cli, f);
      assert.deepEqual(seen, ['EOF']); workerHit(hit, 'implementer');
      return e;
    }, 1);
    assert.ok(error, 'the call failed');
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /write EOF|taskkill/);
    assert.equal(error.result.code, 1, 'the CLI\'s own exit status');
    assert.equal(error.result.stdinError, 'EOF', 'the record keeps the failed write');
    assert.equal(isTransientFailure(error), true, 'retried, as on Linux and macOS');
    assert.equal(isSystemicFailure(error), false);
    const advice = failureGuidance(error, { root: f.root });
    assert.notEqual(advice.id, 'unknown', 'not an unexpected error');
    if (guidance) { assert.equal(advice.id, guidance); assert.equal(isCliLock(error), true); }
  }
});

test('a worker CLI that exits before it reads a prompt larger than the pipe reports its own error, whatever this platform calls the failed write', async t => {
  const f = prepare(t), cli = earlyExit(f, lockFailure);
  const error = await writes(null, async ({ seen, settled }) => {
    // 4 MiB of padding in the prompt: far more than a pipe holds.
    const e = await implement(cli, f, { padding: 'x'.repeat(4 * 1024 * 1024) });
    await settled();
    t.diagnostic(`this platform reports the failed write as ${[...new Set(seen)].join(', ') || 'nothing'}; the record ${e?.result?.stdinError ? `keeps ${e.result.stdinError}` : 'has no stdinError'}`);
    assert.ok(seen.length > 0, 'the write failed');
    for (const code of seen) assert.ok(code === 'EPIPE' || code === 'EOF', code);
    return e;
  });
  assert.ok(error, 'the call failed');
  assert.match(error.message, /^Copilot implementer failed \(exit 1\)(?: before it had read its whole prompt)?: The shared writer lock timed out\./);
  assert.equal(error.result.code, 1);
  assert.equal(isTransientFailure(error), true);
  assert.equal(failureGuidance(error, { root: f.root }).id, 'cli-lock');
});

test('a worker CLI that answers before it has read its whole prompt has that answer refused, as a call that failed', async t => {
  const f = prepare(t), cli = earlyExit(f, unreadAnswer(f));
  const error = await writes('EOF', async ({ seen, hit }) => {
    const e = await implement(cli, f);
    assert.deepEqual(seen, ['EOF']); workerHit(hit, 'implementer');
    return e;
  }, 1);
  assert.ok(error, 'the answer is not used');
  assert.match(error.message, /^Copilot implementer failed \(exit 0\) before it had read its whole prompt: its answer to a prompt cut short is not used/);
  assert.equal(error.result.code, 0);
  assert.equal(error.result.stdinError, 'EOF');
  assert.equal(isTransientFailure(error), false);
  assert.equal(isSystemicFailure(error), false, 'only this call failed');
  assert.equal(failureGuidance(error, { root: f.root }).id, 'worker-output');
  // The same CLI, reading its whole prompt this time, is answered as usual.
  const response = await createCopilotAdapter(cli)({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(response.result.kind, 'implementation');
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
  const response = await writes('EOF', async ({ seen, hit }) => {
    const r = await createCopilotAdapter(cli)({ root: f.root, config: { ...f.config, workerCopilotHome: 'separate' }, role: 'implementer', unit: f.units[0], extra: {} });
    assert.deepEqual(seen, ['EOF']); workerHit(hit, 'implementer');
    return r;
  }, 1);
  assert.equal(response.result.kind, 'implementation');
  assert.match(response.cliHomeWarning, /not signed in in the kit's worker home/);
  assert.deepEqual(cli.calls().map(c => c.home), [`${home}-migration-kit-workers`, home]);
});

test('end to end: a call whose CLI failed before reading its prompt on Windows, with the error in its stream, is retried and the file completes', async t => {
  const f = await ready(t, { executionMode: 'continuous' });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  const cli = earlyExit(f, streamFailure);
  const report = await writes('EOF', async ({ seen, hit }) => {
    const r = await translate(f.root, f.config, createCopilotAdapter(cli));
    assert.deepEqual(seen, ['EOF']); workerHit(hit, 'implementer');
    return r;
  }, 1);
  assert.deepEqual(report.errors, []);
  assert.equal(report.done, 1);
  const dir = safePath(f.root, `migration/runs/${report.runId}`);
  const attempt = fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => readJSON(path.join(dir, n))).find(a => a.role === 'implementer');
  assert.equal(attempt.retries?.length, 1, 'retried once');
  assert.match(attempt.retries[0].error, /^Copilot implementer failed \(exit 1\) before it had read its whole prompt: session\.error rate_limit 429: Too many requests/);
  assert.deepEqual(cli.calls().slice(0, 2).map(c => c.role), ['implementer', 'implementer']);
});
